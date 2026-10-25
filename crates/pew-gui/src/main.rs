// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, Mutex};
use pew_core::{Downloader, DownloadConfig, DownloadEvent, RemoteFileInfo};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadItem {
    pub id: String,
    pub url: String,
    pub filename: String,
    pub target_path: Option<String>,
    pub total_bytes: Option<u64>,
    pub downloaded_bytes: u64,
    pub speed_bps: f64,
    pub status: String, // "Queued", "Downloading", "Completed", "Paused", "Error"
    pub parts: usize,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct AppState {
    pub downloads: Arc<Mutex<HashMap<String, DownloadItem>>>,
}

#[tauri::command]
async fn probe_url(url: String) -> Result<ProbeResult, String> {
    let client = reqwest::Client::builder()
        .user_agent("PewDownloadManager/0.1.0")
        .build()
        .map_err(|e| e.to_string())?;

    let info = RemoteFileInfo::probe(&client, &url).await.map_err(|e| e.to_string())?;

    Ok(ProbeResult {
        url: info.url,
        filename: info.filename,
        content_length: info.content_length,
        accepts_ranges: info.accepts_ranges,
    })
}

#[derive(Serialize)]
struct ProbeResult {
    url: String,
    filename: String,
    content_length: Option<u64>,
    accepts_ranges: bool,
}

#[tauri::command]
async fn start_download(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
    filename: Option<String>,
    output_dir: Option<String>,
    parts: Option<usize>,
) -> Result<String, String> {
    let id = format!("dl_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());
    let parts = parts.unwrap_or(8).clamp(1, 32);

    let default_dir = dirs_fallback();
    let out_dir = output_dir.map(PathBuf::from).unwrap_or(default_dir);

    let item = DownloadItem {
        id: id.clone(),
        url: url.clone(),
        filename: filename.clone().unwrap_or_else(|| "downloading".to_string()),
        target_path: None,
        total_bytes: None,
        downloaded_bytes: 0,
        speed_bps: 0.0,
        status: "Starting".to_string(),
        parts,
        error: None,
    };

    {
        let mut map = state.downloads.lock().await;
        map.insert(id.clone(), item);
    }

    let downloads_ref = state.downloads.clone();
    let task_id = id.clone();
    let app_handle = app.clone();

    tokio::spawn(async move {
        let config = DownloadConfig {
            parts,
            ..Default::default()
        };

        let downloader = Downloader::new(config);
        let (tx, mut rx) = mpsc::unbounded_channel::<DownloadEvent>();

        // Event listener for progress updates
        let listener_id = task_id.clone();
        let app_listener = app_handle.clone();
        let dl_state = downloads_ref.clone();

        let progress_tracker = tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    DownloadEvent::Started { total_bytes, parts, filename } => {
                        let mut map = dl_state.lock().await;
                        if let Some(item) = map.get_mut(&listener_id) {
                            item.filename = filename;
                            item.total_bytes = total_bytes;
                            item.parts = parts;
                            item.status = "Downloading".to_string();
                            let _ = app_listener.emit("download-update", item.clone());
                        }
                    }
                    DownloadEvent::Progress { downloaded, total, speed_bps } => {
                        let mut map = dl_state.lock().await;
                        if let Some(item) = map.get_mut(&listener_id) {
                            item.downloaded_bytes = downloaded;
                            item.total_bytes = total;
                            item.speed_bps = speed_bps;
                            item.status = "Downloading".to_string();
                            let _ = app_listener.emit("download-update", item.clone());
                        }
                    }
                    DownloadEvent::Completed { path, total_bytes } => {
                        let mut map = dl_state.lock().await;
                        if let Some(item) = map.get_mut(&listener_id) {
                            item.status = "Completed".to_string();
                            item.target_path = Some(path.to_string_lossy().to_string());
                            item.downloaded_bytes = total_bytes;
                            item.speed_bps = 0.0;
                            let _ = app_listener.emit("download-update", item.clone());
                        }
                    }
                    DownloadEvent::Error(err) => {
                        let mut map = dl_state.lock().await;
                        if let Some(item) = map.get_mut(&listener_id) {
                            item.status = "Error".to_string();
                            item.error = Some(err);
                            let _ = app_listener.emit("download-update", item.clone());
                        }
                    }
                }
            }
        });

        match downloader.download(&url, &out_dir, filename.as_deref(), Some(tx)).await {
            Ok(_) => {
                let _ = progress_tracker.await;
            }
            Err(e) => {
                let mut map = downloads_ref.lock().await;
                if let Some(item) = map.get_mut(&task_id) {
                    item.status = "Error".to_string();
                    item.error = Some(e.to_string());
                    let _ = app_handle.emit("download-update", item.clone());
                }
            }
        }
    });

    Ok(id)
}

#[tauri::command]
async fn get_downloads(state: State<'_, AppState>) -> Result<Vec<DownloadItem>, String> {
    let map = state.downloads.lock().await;
    Ok(map.values().cloned().collect())
}

#[tauri::command]
fn open_in_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn dirs_fallback() -> PathBuf {
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        let downloads = PathBuf::from(user_profile).join("Downloads");
        if downloads.exists() {
            return downloads;
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            probe_url,
            start_download,
            get_downloads,
            open_in_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
