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
use crate::metadata::RemoteFileInfo;

pub const CHROME_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

#[derive(Debug, Clone)]
pub struct DownloadConfig {
    pub parts: usize,
    pub user_agent: String,
    pub timeout_secs: u64,
}

impl Default for DownloadConfig {
    fn default() -> Self {
        Self {
            parts: 8,
            user_agent: CHROME_USER_AGENT.to_string(),
            timeout_secs: 30,
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
        url: &str,
        output_dir: &Path,
        custom_filename: Option<&str>,
        event_sender: Option<mpsc::UnboundedSender<DownloadEvent>>,
    ) -> Result<PathBuf> {
        let info = RemoteFileInfo::probe(&self.client, url).await?;
        let filename = custom_filename.unwrap_or(&info.filename);
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

        if parts > 1 && info.content_length.is_some() {
            self.download_segmented(url, &target_path, info.content_length.unwrap(), parts, &event_sender).await?;
        } else {
            self.download_single(url, &target_path, info.content_length, &event_sender).await?;
        }

        let total = if let Ok(meta) = tokio::fs::metadata(&target_path).await {
            meta.len()
        } else {
            info.content_length.unwrap_or(0)
        };

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
        // Pre-allocate the complete file size on disk
        let file = File::create(target_path).await?;
        file.set_len(total_size).await?;
        drop(file);

        let chunks = calculate_chunks(total_size, parts);
        let downloaded_counter = Arc::new(AtomicU64::new(0));
        let is_running = Arc::new(AtomicBool::new(true));

        // Background progress tracker
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
            let url = url.to_string();
            let path = target_path.to_path_buf();
            let downloaded_counter = downloaded_counter.clone();

            let handle = tokio::spawn(async move {
                Self::download_chunk(client, url, path, chunk, downloaded_counter).await
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
        url: String,
        target_path: PathBuf,
        chunk: Chunk,
        downloaded_counter: Arc<AtomicU64>,
    ) -> Result<()> {
        let range_header = format!("bytes={}-{}", chunk.start, chunk.end);
        let req = client.get(&url).header("Range", range_header);
        let req = apply_media_headers(req, &url);
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
        event_sender: &Option<mpsc::UnboundedSender<DownloadEvent>>,
    ) -> Result<()> {
        let req = self.client.get(url);
        let req = apply_media_headers(req, url);
        let resp = req.send().await?;
        if !resp.status().is_success() {
            return Err(PewError::HttpStatus(resp.status()));
        }

        let mut file = File::create(target_path).await?;
        let mut stream = resp.bytes_stream();
        let mut downloaded = 0u64;
        let mut last_time = Instant::now();
        let mut last_bytes = 0u64;

        while let Some(item) = stream.next().await {
            let chunk_bytes = item?;
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

pub fn apply_media_headers(builder: reqwest::RequestBuilder, url: &str) -> reqwest::RequestBuilder {
    let mut b = builder
        .header("User-Agent", CHROME_USER_AGENT)
        .header("Accept", "*/*")
        .header("Accept-Language", "en-US,en;q=0.9");

    if url.contains("googlevideo.com") || url.contains("youtube.com") {
        b = b.header("Referer", "https://www.youtube.com/")
             .header("Origin", "https://www.youtube.com");
    }

    b
}
