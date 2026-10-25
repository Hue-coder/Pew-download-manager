use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use futures_util::StreamExt;
use reqwest::Client;
use tokio::fs::{File, OpenOptions};
use tokio::io::{AsyncSeekExt, AsyncWriteExt, SeekFrom};
use tokio::sync::mpsc;
use crate::chunk::{calculate_chunks, Chunk};
use crate::error::{PewError, Result};
use crate::hls::{is_hls_url, HlsDownloader};
use crate::metadata::RemoteFileInfo;
use crate::youtube::{extract_youtube_video_id, resolve_youtube_stream};

pub const CHROME_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

#[derive(Debug, Clone)]
pub struct DownloadConfig {
    pub parts: usize,
    pub user_agent: String,
    pub timeout_secs: u64,
    pub cookies: Option<String>,
    pub referer: Option<String>,
}

impl Default for DownloadConfig {
    fn default() -> Self {
        Self {
            parts: 8,
            user_agent: CHROME_USER_AGENT.to_string(),
            timeout_secs: 30,
            cookies: None,
            referer: None,
        }
    }
}

#[derive(Debug, Clone)]
pub enum DownloadEvent {
    Started {
        total_bytes: Option<u64>,
        parts: usize,
        filename: String,
    },
    Progress {
        downloaded: u64,
        total: Option<u64>,
        speed_bps: f64,
    },
    Completed {
        path: PathBuf,
        total_bytes: u64,
    },
    Error(String),
}

pub struct Downloader {
    client: Client,
    config: DownloadConfig,
}

impl Downloader {
    pub fn new(config: DownloadConfig) -> Self {
        let client = Client::builder()
            .user_agent(&config.user_agent)
            .connect_timeout(std::time::Duration::from_secs(config.timeout_secs))
            .build()
            .unwrap_or_default();

        Self { client, config }
    }

    pub async fn download(
        &self,
        raw_url: &str,
        output_dir: &Path,
        custom_filename: Option<&str>,
        event_sender: Option<mpsc::UnboundedSender<DownloadEvent>>,
    ) -> Result<PathBuf> {
        // 1. YouTube direct watch link resolution fallback
        let (actual_url, yt_filename) = if let Some(vid) = extract_youtube_video_id(raw_url) {
            match resolve_youtube_stream(&self.client, &vid).await {
                Ok(info) => {
                    let fname = format!("{}_{}.mp4", info.title, info.quality);
                    (info.url, Some(fname))
                }
                Err(_) => (raw_url.to_string(), None),
            }
        } else {
            (raw_url.to_string(), None)
        };

        // 2. Handle HLS (.m3u8) streams
        if is_hls_url(&actual_url) {
            let fname = custom_filename
                .or(yt_filename.as_deref())
                .unwrap_or("video.mp4");
            let final_name = if fname.to_lowercase().ends_with(".m3u8") {
                format!("{}.mp4", &fname[..fname.len() - 5])
            } else {
                fname.to_string()
            };
            let target_path = output_dir.join(final_name);

            let hls_dl = HlsDownloader::new(self.client.clone(), self.config.clone());
            return hls_dl.download(&actual_url, &target_path, &event_sender).await;
        }

        // 3. Regular HTTP file probing
        let info = RemoteFileInfo::probe(&self.client, &actual_url).await?;
        let filename = custom_filename
            .or(yt_filename.as_deref())
            .unwrap_or(&info.filename);
        let target_path = output_dir.join(filename);

        let parts = if info.accepts_ranges && info.content_length.is_some() {
            self.config.parts.max(1)
        } else {
            1
        };

        if let Some(ref tx) = event_sender {
            let _ = tx.send(DownloadEvent::Started {
                total_bytes: info.content_length,
                parts,
                filename: filename.to_string(),
            });
        }

        let download_res = if parts > 1 && info.content_length.is_some() {
            self.download_segmented(&actual_url, &target_path, info.content_length.unwrap(), parts, &event_sender).await
        } else {
            self.download_single(&actual_url, &target_path, info.content_length, filename, &event_sender).await
        };

        if let Err(e) = download_res {
            let _ = tokio::fs::remove_file(&target_path).await;
            return Err(e);
        }

        let total = if let Ok(meta) = tokio::fs::metadata(&target_path).await {
            meta.len()
        } else {
            info.content_length.unwrap_or(0)
        };

        if total <= 100 {
            // Check if downloaded file is an error text payload (e.g. 31 bytes sabr error)
            if let Ok(bytes) = tokio::fs::read(&target_path).await {
                if let Ok(text) = std::str::from_utf8(&bytes) {
                    let lower = text.to_lowercase();
                    if lower.contains("sabr.") || lower.contains("<html") || lower.contains("forbidden") || lower.contains("error") {
                        let _ = tokio::fs::remove_file(&target_path).await;
                        return Err(PewError::Custom(format!("Server returned error payload ({} bytes): {}", bytes.len(), text.trim())));
                    }
                }
            }
        }

        if total == 0 {
            let _ = tokio::fs::remove_file(&target_path).await;
            return Err(PewError::Custom("Downloaded file is empty (0 bytes received from server)".to_string()));
        }

        if let Some(ref tx) = event_sender {
            let _ = tx.send(DownloadEvent::Completed {
                path: target_path.clone(),
                total_bytes: total,
            });
        }

        Ok(target_path)
    }

    async fn download_segmented(
        &self,
        url: &str,
        target_path: &Path,
        total_size: u64,
        parts: usize,
        event_sender: &Option<mpsc::UnboundedSender<DownloadEvent>>,
    ) -> Result<()> {
        let file = File::create(target_path).await?;
        file.set_len(total_size).await?;
        drop(file);

        let chunks = calculate_chunks(total_size, parts);
        let downloaded_counter = Arc::new(AtomicU64::new(0));
        let is_running = Arc::new(AtomicBool::new(true));

        let (speed_tx, _) = tokio::sync::broadcast::channel::<()>(1);
        if let Some(tx) = event_sender.clone() {
            let counter_clone = downloaded_counter.clone();
            let is_running_clone = is_running.clone();
            tokio::spawn(async move {
                let mut last_bytes = 0u64;
                let mut last_time = Instant::now();

                while is_running_clone.load(Ordering::Relaxed) {
                    tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
                    let current_bytes = counter_clone.load(Ordering::Relaxed);
                    let elapsed = last_time.elapsed().as_secs_f64();

                    if elapsed > 0.0 {
                        let bytes_diff = current_bytes.saturating_sub(last_bytes);
                        let speed_bps = (bytes_diff as f64) / elapsed;

                        let _ = tx.send(DownloadEvent::Progress {
                            downloaded: current_bytes,
                            total: Some(total_size),
                            speed_bps,
                        });

                        last_bytes = current_bytes;
                        last_time = Instant::now();
                    }
                }
            });
        }

        let mut join_handles = Vec::with_capacity(parts);

        for chunk in chunks {
            let client = self.client.clone();
            let config = self.config.clone();
            let url = url.to_string();
            let path = target_path.to_path_buf();
            let downloaded_counter = downloaded_counter.clone();

            let handle = tokio::spawn(async move {
                Self::download_chunk(client, config, url, path, chunk, downloaded_counter).await
            });

            join_handles.push(handle);
        }

        for handle in join_handles {
            match handle.await {
                Ok(res) => res?,
                Err(e) => return Err(PewError::Custom(format!("Worker task failed: {}", e))),
            }
        }

        is_running.store(false, Ordering::Relaxed);
        let _ = speed_tx.send(());

        let final_downloaded = downloaded_counter.load(Ordering::Relaxed);
        if final_downloaded == 0 {
            let _ = tokio::fs::remove_file(target_path).await;
            return Err(PewError::Custom("Multi-segmented download received 0 bytes".to_string()));
        }

        Ok(())
    }

    async fn download_chunk(
        client: Client,
        config: DownloadConfig,
        url: String,
        target_path: PathBuf,
        chunk: Chunk,
        downloaded_counter: Arc<AtomicU64>,
    ) -> Result<()> {
        let range_header = format!("bytes={}-{}", chunk.start, chunk.end);
        let req = client.get(&url).header("Range", range_header);
        let req = apply_media_headers(req, &url, config.cookies.as_deref(), config.referer.as_deref());
        let resp = req.send().await?;

        if !resp.status().is_success() && resp.status() != reqwest::StatusCode::PARTIAL_CONTENT {
            return Err(PewError::HttpStatus(resp.status()));
        }

        let mut file = OpenOptions::new()
            .write(true)
            .open(&target_path)
            .await?;

        file.seek(SeekFrom::Start(chunk.start)).await?;

        let mut stream = resp.bytes_stream();

        while let Some(item) = stream.next().await {
            let chunk_bytes = item?;
            file.write_all(&chunk_bytes).await?;
            downloaded_counter.fetch_add(chunk_bytes.len() as u64, Ordering::Relaxed);
        }

        file.flush().await?;
        Ok(())
    }

    async fn download_single(
        &self,
        url: &str,
        target_path: &Path,
        total_size: Option<u64>,
        filename: &str,
        event_sender: &Option<mpsc::UnboundedSender<DownloadEvent>>,
    ) -> Result<()> {
        let req = self.client.get(url);
        let req = apply_media_headers(req, url, self.config.cookies.as_deref(), self.config.referer.as_deref());
        let resp = req.send().await?;
        if !resp.status().is_success() {
            return Err(PewError::HttpStatus(resp.status()));
        }

        let mut file = File::create(target_path).await?;
        let mut stream = resp.bytes_stream();
        let mut downloaded = 0u64;
        let mut last_time = Instant::now();
        let mut last_bytes = 0u64;
        let mut first_chunk = true;

        while let Some(item) = stream.next().await {
            let chunk_bytes = item?;

            if first_chunk {
                first_chunk = false;
                if let Some(err) = check_media_error_payload(&chunk_bytes, filename) {
                    drop(file);
                    let _ = tokio::fs::remove_file(target_path).await;
                    return Err(PewError::Custom(err));
                }
            }

            file.write_all(&chunk_bytes).await?;
            downloaded += chunk_bytes.len() as u64;

            if let Some(ref tx) = event_sender {
                let elapsed = last_time.elapsed().as_secs_f64();
                if elapsed >= 0.3 {
                    let speed_bps = ((downloaded - last_bytes) as f64) / elapsed;
                    let _ = tx.send(DownloadEvent::Progress {
                        downloaded,
                        total: total_size,
                        speed_bps,
                    });
                    last_time = Instant::now();
                    last_bytes = downloaded;
                }
            }
        }

        file.flush().await?;

        if downloaded == 0 {
            let _ = tokio::fs::remove_file(target_path).await;
            return Err(PewError::Custom("Server closed stream with 0 bytes downloaded".to_string()));
        }

        Ok(())
    }
}

pub fn check_media_error_payload(data: &[u8], filename: &str) -> Option<String> {
    let lower_name = filename.to_lowercase();
    let is_media = lower_name.ends_with(".mp4")
        || lower_name.ends_with(".webm")
        || lower_name.ends_with(".mkv")
        || lower_name.ends_with(".mp3")
        || lower_name.ends_with(".m4a")
        || lower_name.ends_with(".avi")
        || lower_name.ends_with(".flv")
        || lower_name.ends_with(".ts");

    if data.len() < 512 {
        if let Ok(text) = std::str::from_utf8(data) {
            let lower_text = text.to_lowercase();
            if lower_text.contains("sabr.") || lower_text.contains("sabr.malformed_config") {
                return Some("YouTube stream error: sabr.malformed_config. Stream requires fresh player token or clean progressive stream.".into());
            }
            if is_media && (lower_text.contains("<html") || lower_text.contains("<!doctype") || lower_text.contains("<error>") || lower_text.contains("access denied") || lower_text.contains("forbidden")) {
                return Some(format!("Server returned error page instead of video: {}", text.trim()));
            }
        }
    }
    None
}

pub fn apply_media_headers(
    builder: reqwest::RequestBuilder,
    url: &str,
    cookies: Option<&str>,
    referer: Option<&str>,
) -> reqwest::RequestBuilder {
    let mut b = builder
        .header("User-Agent", CHROME_USER_AGENT)
        .header("Accept", "*/*")
        .header("Accept-Language", "en-US,en;q=0.9");

    if let Some(ref_str) = referer {
        if !ref_str.is_empty() {
            b = b.header("Referer", ref_str);
        }
    } else if url.contains("googlevideo.com") || url.contains("youtube.com") {
        b = b.header("Referer", "https://www.youtube.com/")
             .header("Origin", "https://www.youtube.com");
    }

    if let Some(cookie_str) = cookies {
        if !cookie_str.is_empty() {
            b = b.header("Cookie", cookie_str);
        }
    }

    b
}
