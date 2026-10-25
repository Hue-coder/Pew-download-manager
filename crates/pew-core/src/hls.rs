use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use reqwest::Client;
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use url::Url;
use crate::error::{PewError, Result};
use crate::downloader::{apply_media_headers, DownloadConfig, DownloadEvent};

/// Check if a URL or content points to an HLS manifest (.m3u8)
pub fn is_hls_url(url: &str) -> bool {
    let lower = url.to_lowercase();
    lower.contains(".m3u8") 
        || lower.contains("format=m3u8") 
        || lower.contains("/hls_playlist/") 
        || lower.contains("/hls/") 
        || lower.contains("manifest/hls")
}

pub struct HlsDownloader {
    client: Client,
    config: DownloadConfig,
}

impl HlsDownloader {
    pub fn new(client: Client, config: DownloadConfig) -> Self {
        Self { client, config }
    }

    pub async fn download(
        &self,
        master_url_str: &str,
        target_path: &Path,
        event_sender: &Option<mpsc::UnboundedSender<DownloadEvent>>,
    ) -> Result<PathBuf> {
        let base_url = Url::parse(master_url_str).map_err(|e| PewError::InvalidUrl(e.to_string()))?;

        // 1. Fetch playlist content
        let req = self.client.get(master_url_str);
        let req = apply_media_headers(req, master_url_str, self.config.cookies.as_deref(), self.config.referer.as_deref());
        let resp = req.send().await?;
        if !resp.status().is_success() {
            return Err(PewError::HttpStatus(resp.status()));
        }

        let manifest_text = resp.text().await?;
        if !manifest_text.contains("#EXTM3U") {
            return Err(PewError::Custom("Invalid HLS playlist: missing #EXTM3U".to_string()));
        }

        // 2. Resolve media playlist (handle master playlists with variant streams)
        let (media_url, media_manifest) = if manifest_text.contains("#EXT-X-STREAM-INF") {
            let variant_url = self.pick_best_variant(&base_url, &manifest_text)?;
            let v_req = self.client.get(variant_url.as_str());
            let v_req = apply_media_headers(v_req, variant_url.as_str(), self.config.cookies.as_deref(), self.config.referer.as_deref());
            let v_resp = v_req.send().await?;
            let v_text = v_resp.text().await?;
            (variant_url, v_text)
        } else {
            (base_url.clone(), manifest_text)
        };

        // 3. Extract all segment URLs
        let segments = self.extract_segments(&media_url, &media_manifest)?;
        if segments.is_empty() {
            return Err(PewError::Custom("No HLS video segments found in playlist".to_string()));
        }

        let total_segments = segments.len();
        let filename = target_path.file_name().and_then(|f| f.to_str()).unwrap_or("video.mp4");

        if let Some(ref tx) = event_sender {
            let _ = tx.send(DownloadEvent::Started {
                total_bytes: None,
                parts: total_segments,
                filename: filename.to_string(),
            });
        }

        // 4. Download and append segments sequentially to avoid segment ordering issues
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(target_path)
            .await?;

        let downloaded_counter = Arc::new(AtomicU64::new(0));
        let is_running = Arc::new(AtomicBool::new(true));

        // Background speed reporter
        if let Some(tx) = event_sender.clone() {
            let counter_clone = downloaded_counter.clone();
            let is_running_clone = is_running.clone();
            tokio::spawn(async move {
                let mut last_bytes = 0u64;
                let mut last_time = Instant::now();

                while is_running_clone.load(Ordering::Relaxed) {
                    tokio::time::sleep(tokio::time::Duration::from_millis(400)).await;
                    let current = counter_clone.load(Ordering::Relaxed);
                    let elapsed = last_time.elapsed().as_secs_f64();
                    if elapsed > 0.0 {
                        let speed = ((current.saturating_sub(last_bytes)) as f64) / elapsed;
                        let _ = tx.send(DownloadEvent::Progress {
                            downloaded: current,
                            total: None,
                            speed_bps: speed,
                        });
                        last_bytes = current;
                        last_time = Instant::now();
                    }
                }
            });
        }

        for (idx, seg_url) in segments.iter().enumerate() {
            let mut retries = 3;
            let mut seg_bytes = Vec::new();

            while retries > 0 {
                let seg_req = self.client.get(seg_url.as_str());
                let seg_req = apply_media_headers(seg_req, seg_url.as_str(), self.config.cookies.as_deref(), self.config.referer.as_deref());
                match seg_req.send().await {
                    Ok(resp) if resp.status().is_success() => {
                        match resp.bytes().await {
                            Ok(b) => {
                                seg_bytes = b.to_vec();
                                break;
                            }
                            Err(_) => retries -= 1,
                        }
                    }
                    _ => retries -= 1,
                }
                tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
            }

            if seg_bytes.is_empty() && retries == 0 {
                is_running.store(false, Ordering::Relaxed);
                return Err(PewError::Custom(format!("Failed to download HLS segment {}/{}", idx + 1, total_segments)));
            }

            file.write_all(&seg_bytes).await?;
            downloaded_counter.fetch_add(seg_bytes.len() as u64, Ordering::Relaxed);
        }

        file.flush().await?;
        is_running.store(false, Ordering::Relaxed);

        let final_size = downloaded_counter.load(Ordering::Relaxed);
        if final_size == 0 {
            let _ = tokio::fs::remove_file(target_path).await;
            return Err(PewError::Custom("HLS stream download produced 0 bytes".to_string()));
        }

        if let Some(ref tx) = event_sender {
            let _ = tx.send(DownloadEvent::Completed {
                path: target_path.to_path_buf(),
                total_bytes: final_size,
            });
        }

        Ok(target_path.to_path_buf())
    }

    fn pick_best_variant(&self, base_url: &Url, manifest: &str) -> Result<Url> {
        let mut best_bandwidth = 0u64;
        let mut best_uri: Option<&str> = None;

        let mut lines = manifest.lines();
        while let Some(line) = lines.next() {
            let line = line.trim();
            if line.starts_with("#EXT-X-STREAM-INF:") {
                let bandwidth = line
                    .split(',')
                    .find(|p| p.trim().starts_with("BANDWIDTH="))
                    .and_then(|p| p.trim()[10..].parse::<u64>().ok())
                    .unwrap_or(0);

                if let Some(uri_line) = lines.next() {
                    let uri_line = uri_line.trim();
                    if !uri_line.is_empty() && !uri_line.starts_with('#') {
                        if bandwidth >= best_bandwidth {
                            best_bandwidth = bandwidth;
                            best_uri = Some(uri_line);
                        }
                    }
                }
            }
        }

        if let Some(uri) = best_uri {
            base_url.join(uri).map_err(|e| PewError::InvalidUrl(e.to_string()))
        } else {
            Ok(base_url.clone())
        }
    }

    fn extract_segments(&self, base_url: &Url, manifest: &str) -> Result<Vec<Url>> {
        let mut segments = Vec::new();

        for line in manifest.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }

            if let Ok(url) = base_url.join(line) {
                segments.push(url);
            }
        }

        Ok(segments)
    }
}
