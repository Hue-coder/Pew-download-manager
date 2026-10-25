// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
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
    pub status: String, // "Starting", "Downloading", "Completed", "Paused", "Error"
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
    start_download_internal(app, state.downloads.clone(), url, filename, output_dir, parts).await
}

async fn start_download_internal(
    app: AppHandle,
    downloads_map: Arc<Mutex<HashMap<String, DownloadItem>>>,
    url: String,
    filename: Option<String>,
    output_dir: Option<String>,
    parts: Option<usize>,
) -> Result<String, String> {
    let id = format!("dl_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());
    let parts = parts.unwrap_or(8).clamp(1, 32);

    let default_dir = dirs_fallback();
    let out_dir = output_dir.map(PathBuf::from).unwrap_or(default_dir);

    // Initial item
    let initial_name = filename.clone().unwrap_or_else(|| {
        url.split('?').next().and_then(|u| u.split('/').last()).unwrap_or("download").to_string()
    });

    let item = DownloadItem {
        id: id.clone(),
        url: url.clone(),
        filename: initial_name,
        target_path: None,
        total_bytes: None,
        downloaded_bytes: 0,
        speed_bps: 0.0,
        status: "Starting".to_string(),
        parts,
        error: None,
    };

    {
        let mut map = downloads_map.lock().await;
        map.insert(id.clone(), item.clone());
    }
    let _ = app.emit("download-update", item);

    let downloads_ref = downloads_map.clone();
    let task_id = id.clone();
    let app_handle = app.clone();

    tauri::async_runtime::spawn(async move {
        let config = DownloadConfig {
            parts,
            ..Default::default()
        };

        let downloader = Downloader::new(config);
        let (tx, mut rx) = mpsc::unbounded_channel::<DownloadEvent>();

        let listener_id = task_id.clone();
        let app_listener = app_handle.clone();
        let dl_state = downloads_ref.clone();

        let progress_tracker = tauri::async_runtime::spawn(async move {
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
            .arg(format!("/select,{}", path))
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

// Background Local RPC Server to communicate with the browser extension
fn start_local_rpc_server(app_handle: AppHandle, downloads_map: Arc<Mutex<HashMap<String, DownloadItem>>>) {
    tauri::async_runtime::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let listener = match TcpListener::bind("127.0.0.1:41738").await {
            Ok(l) => l,
            Err(_) => return,
        };

        while let Ok((mut socket, _)) = listener.accept().await {
            let app = app_handle.clone();
            let dl_map = downloads_map.clone();

            tauri::async_runtime::spawn(async move {
                let mut buffer = [0u8; 8192];
                let n = match socket.read(&mut buffer).await {
                    Ok(n) if n > 0 => n,
                    _ => return,
                };

                let request = String::from_utf8_lossy(&buffer[..n]);
                let (headers_part, body_part) = match request.split_once("\r\n\r\n") {
                    Some((h, b)) => (h, b),
                    None => (request.as_ref(), ""),
                };

                let first_line = headers_part.lines().next().unwrap_or("");

                let send_response = |body_str: &str| {
                    format!(
                        "HTTP/1.1 200 OK\r\n\
Access-Control-Allow-Origin: *\r\n\
Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
Access-Control-Allow-Headers: Content-Type\r\n\
Content-Type: application/json\r\n\
Content-Length: {}\r\n\
Connection: close\r\n\r\n{}",
                        body_str.len(),
                        body_str
                    )
                };

                if first_line.starts_with("OPTIONS") {
                    let resp = send_response("{\"status\":\"ok\"}");
                    let _ = socket.write_all(resp.as_bytes()).await;
                    let _ = socket.flush().await;
                    return;
                }

                if first_line.contains("/show") {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    let resp = send_response("{\"status\":\"ok\"}");
                    let _ = socket.write_all(resp.as_bytes()).await;
                    let _ = socket.flush().await;
                    return;
                }

                if first_line.contains("/download") {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }

                    let mut download_url = None;
                    let mut download_name = None;

                    // Parse JSON body if present
                    #[derive(Deserialize)]
                    struct RpcDownloadPayload {
                        url: String,
                        filename: Option<String>,
                        parts: Option<usize>,
                    }

                    if let Ok(payload) = serde_json::from_str::<RpcDownloadPayload>(body_part.trim()) {
                        download_url = Some(payload.url);
                        download_name = payload.filename;
                    } else if let Some(query_start) = first_line.find('?') {
                        // Fallback: parse query parameters /download?url=...&name=...
                        let query = first_line[query_start + 1..].split_whitespace().next().unwrap_or("");
                        for param in query.split('&') {
                            if let Some((k, v)) = param.split_once('=') {
                                if k == "url" {
                                    download_url = urlencoding::decode(v).ok().map(|s| s.into_owned());
                                } else if k == "name" || k == "filename" {
                                    download_name = urlencoding::decode(v).ok().map(|s| s.into_owned());
                                }
                            }
                        }
                    }

                    if let Some(url) = download_url {
                        let _ = start_download_internal(
                            app,
                            dl_map,
                            url,
                            download_name,
                            None,
                            Some(8),
                        ).await;

                        let resp = send_response("{\"success\":true}");
                        let _ = socket.write_all(resp.as_bytes()).await;
                        let _ = socket.flush().await;
                        return;
                    }
                }

                // Default health check response
                let resp = send_response("{\"app\":\"pew\",\"status\":\"running\"}");
                let _ = socket.write_all(resp.as_bytes()).await;
                let _ = socket.flush().await;
            });
        }
    });
}

fn register_pew_protocol() {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        if let Ok(exe_path) = std::env::current_exe() {
            let exe_str = exe_path.to_string_lossy().to_string();
            let _ = Command::new("reg")
                .args(["add", r"HKCU\Software\Classes\pew", "/ve", "/d", "URL:Pew Protocol", "/f"])
                .output();
            let _ = Command::new("reg")
                .args(["add", r"HKCU\Software\Classes\pew", "/v", "URL Protocol", "/d", "", "/f"])
                .output();
            let _ = Command::new("reg")
                .args(["add", r"HKCU\Software\Classes\pew\shell\open\command", "/ve", "/d", &format!("\"{}\" \"%1\"", exe_str), "/f"])
                .output();
        }
    }
}

fn main() {
    register_pew_protocol();

    let app_state = AppState::default();
    let downloads_ref = app_state.downloads.clone();

    tauri::Builder::default()
        .manage(app_state)
        .setup(move |app| {
            start_local_rpc_server(app.handle().clone(), downloads_ref);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            probe_url,
            start_download,
            get_downloads,
            open_in_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
