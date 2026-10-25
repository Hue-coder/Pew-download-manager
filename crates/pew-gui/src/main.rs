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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub download_dir: String,
    pub max_connections: usize,
    pub auto_start: bool,
    pub open_folder_on_finish: bool,
    pub user_agent: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            download_dir: dirs_fallback().to_string_lossy().to_string(),
            max_connections: 8,
            auto_start: true,
            open_folder_on_finish: false,
            user_agent: pew_core::downloader::CHROME_USER_AGENT.to_string(),
        }
    }
}

pub struct AppState {
    pub downloads: Arc<Mutex<HashMap<String, DownloadItem>>>,
    pub settings: Arc<Mutex<AppSettings>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedFormat {
    pub id: String,
    pub quality: String,
    pub format: String,
    pub url: String,
    pub size: u64,
    pub media_type: String, // "video" or "audio"
    pub filename: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaResolveResult {
    pub success: bool,
    pub title: String,
    pub formats: Vec<ResolvedFormat>,
}

fn get_config_file_path() -> PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        let p = PathBuf::from(appdata).join("PewDownloadManager");
        let _ = std::fs::create_dir_all(&p);
        p.join("settings.json")
    } else {
        PathBuf::from("pew_settings.json")
    }
}

fn load_saved_settings() -> AppSettings {
    let p = get_config_file_path();
    if let Ok(content) = std::fs::read_to_string(&p) {
        if let Ok(s) = serde_json::from_str::<AppSettings>(&content) {
            return s;
        }
    }
    AppSettings::default()
}

fn save_settings_to_file(settings: &AppSettings) {
    let p = get_config_file_path();
    if let Ok(json) = serde_json::to_string_pretty(settings) {
        let _ = std::fs::write(p, json);
    }
}

async fn resolve_media_options(url: &str) -> MediaResolveResult {
    let url_owned = url.to_string();
    let result = tokio::task::spawn_blocking(move || {
        let output = std::process::Command::new("python")
            .args(["-m", "yt_dlp", "-J", "--no-warnings", &url_owned])
            .output();

        if let Ok(o) = output {
            if o.status.success() {
                if let Ok(data) = serde_json::from_slice::<serde_json::Value>(&o.stdout) {
                    let raw_title = data["title"].as_str().unwrap_or("Media_Video");
                    let clean_title = raw_title.replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_");

                    let mut formats = Vec::new();
                    let mut seen_heights = std::collections::HashSet::new();
                    let mut audio_url = None;
                    let mut audio_size = 0u64;

                    if let Some(formats_arr) = data["formats"].as_array() {
                        // Find highest bitrate audio stream
                        for f in formats_arr.iter().rev() {
                            if f["vcodec"].as_str().unwrap_or("") == "none" {
                                if let Some(u) = f["url"].as_str() {
                                    audio_url = Some(u.to_string());
                                    audio_size = f["filesize"].as_u64().or_else(|| f["filesize_approx"].as_u64()).unwrap_or(0);
                                    break;
                                }
                            }
                        }

                        // Collect target video resolutions in priority order: 4K, 2K, 1080p, 720p, 480p, 360p
                        let target_heights = [2160, 1440, 1080, 720, 480, 360];
                        for target_h in target_heights {
                            for f in formats_arr {
                                let h = f["height"].as_u64().unwrap_or(0);
                                if h == target_h && !seen_heights.contains(&h) {
                                    if let Some(u) = f["url"].as_str() {
                                        seen_heights.insert(h);
                                        let (tag, label) = match h {
                                            2160 => ("4K", "4K Ultra HD (2160p)"),
                                            1440 => ("2K", "2K Quad HD (1440p)"),
                                            1080 => ("1080p", "1080p Full HD"),
                                            720 => ("720p", "720p HD"),
                                            480 => ("480p", "480p SD"),
                                            _ => ("360p", "360p"),
                                        };
                                        let size = f["filesize"].as_u64().or_else(|| f["filesize_approx"].as_u64()).unwrap_or(0);
                                        formats.push(ResolvedFormat {
                                            id: format!("vid_{}", h),
                                            quality: label.to_string(),
                                            format: "MP4".to_string(),
                                            url: u.to_string(),
                                            size,
                                            media_type: "video".to_string(),
                                            filename: format!("{}_{}.mp4", clean_title, tag),
                                        });
                                        break;
                                    }
                                }
                            }
                        }

                        // Audio Options (MP3, WAV, M4A)
                        if let Some(a_url) = audio_url {
                            formats.push(ResolvedFormat {
                                id: "aud_mp3".to_string(),
                                quality: "MP3 Audio (High Quality)".to_string(),
                                format: "MP3".to_string(),
                                url: a_url.clone(),
                                size: audio_size,
                                media_type: "audio".to_string(),
                                filename: format!("{}_Audio.mp3", clean_title),
                            });
                            formats.push(ResolvedFormat {
                                id: "aud_wav".to_string(),
                                quality: "WAV Audio (Lossless)".to_string(),
                                format: "WAV".to_string(),
                                url: a_url.clone(),
                                size: audio_size,
                                media_type: "audio".to_string(),
                                filename: format!("{}_Audio.wav", clean_title),
                            });
                            formats.push(ResolvedFormat {
                                id: "aud_m4a".to_string(),
                                quality: "M4A Audio (Original AAC)".to_string(),
                                format: "M4A".to_string(),
                                url: a_url,
                                size: audio_size,
                                media_type: "audio".to_string(),
                                filename: format!("{}_Audio.m4a", clean_title),
                            });
                        }
                    }

                    if !formats.is_empty() {
                        return MediaResolveResult {
                            success: true,
                            title: clean_title,
                            formats,
                        };
                    }
                }
            }
        }

        MediaResolveResult {
            success: false,
            title: "Unknown Media".to_string(),
            formats: Vec::new(),
        }
    }).await;

    result.unwrap_or(MediaResolveResult {
        success: false,
        title: "Error".to_string(),
        formats: Vec::new(),
    })
}

#[tauri::command]
async fn resolve_url_formats(url: String) -> Result<MediaResolveResult, String> {
    Ok(resolve_media_options(&url).await)
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let s = state.settings.lock().await;
    Ok(s.clone())
}

#[tauri::command]
async fn save_settings(state: State<'_, AppState>, settings: AppSettings) -> Result<(), String> {
    save_settings_to_file(&settings);
    let mut s = state.settings.lock().await;
    *s = settings;
    Ok(())
}

#[tauri::command]
async fn select_folder() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(|| {
        let output = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select Default Download Folder'; if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath }"])
            .output();
        match output {
            Ok(o) => {
                let path = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if !path.is_empty() {
                    Ok(Some(path))
                } else {
                    Ok(None)
                }
            }
            Err(e) => Err(e.to_string()),
        }
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn probe_url(url: String) -> Result<ProbeResult, String> {
    // If it's a video service link, try full resolution
    let resolved = resolve_media_options(&url).await;
    if resolved.success && !resolved.formats.is_empty() {
        let first = &resolved.formats[0];
        return Ok(ProbeResult {
            url: first.url.clone(),
            filename: first.filename.clone(),
            content_length: if first.size > 0 { Some(first.size) } else { None },
            accepts_ranges: true,
        });
    }

    let client = reqwest::Client::builder()
        .user_agent(pew_core::downloader::CHROME_USER_AGENT)
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
    let current_settings = {
        let s = state.settings.lock().await;
        s.clone()
    };

    let resolved_out_dir = output_dir.unwrap_or(current_settings.download_dir);
    let resolved_parts = parts.unwrap_or(current_settings.max_connections);

    start_download_internal(
        app,
        state.downloads.clone(),
        url,
        filename,
        Some(resolved_out_dir),
        Some(resolved_parts),
        None,
        None,
        Some(current_settings.user_agent),
        current_settings.open_folder_on_finish,
    ).await
}

#[tauri::command]
async fn delete_download(state: State<'_, AppState>, id: String, delete_file: bool) -> Result<(), String> {
    let mut map = state.downloads.lock().await;
    if let Some(item) = map.remove(&id) {
        if delete_file {
            if let Some(target) = item.target_path {
                let _ = tokio::fs::remove_file(target).await;
            }
        }
    }
    Ok(())
}

async fn start_download_internal(
    app: AppHandle,
    downloads_map: Arc<Mutex<HashMap<String, DownloadItem>>>,
    url: String,
    filename: Option<String>,
    output_dir: Option<String>,
    parts: Option<usize>,
    cookies: Option<String>,
    referer: Option<String>,
    user_agent: Option<String>,
    open_folder_on_finish: bool,
) -> Result<String, String> {
    let id = format!("dl_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());
    let parts = parts.unwrap_or(8).clamp(1, 32);

    let default_dir = dirs_fallback();
    let out_dir = output_dir.map(PathBuf::from).unwrap_or(default_dir);

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
            cookies,
            referer,
            user_agent: user_agent.unwrap_or_else(|| pew_core::downloader::CHROME_USER_AGENT.to_string()),
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
                        if open_folder_on_finish {
                            let _ = open_in_folder(path.to_string_lossy().to_string());
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

#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path])
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
fn start_local_rpc_server(
    app_handle: AppHandle,
    downloads_map: Arc<Mutex<HashMap<String, DownloadItem>>>,
    settings_ref: Arc<Mutex<AppSettings>>,
) {
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
            let cfg_ref = settings_ref.clone();

            tauri::async_runtime::spawn(async move {
                let mut buffer = [0u8; 16384];
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

                // Video/Audio Format Resolver Endpoint (4K, 2K, 1080p, 720p, 480p, 360p, MP3, WAV)
                if first_line.contains("/resolve") {
                    let mut media_url = None;
                    if let Some(query_start) = first_line.find('?') {
                        let query = first_line[query_start + 1..].split_whitespace().next().unwrap_or("");
                        for param in query.split('&') {
                            if let Some((k, v)) = param.split_once('=') {
                                if k == "url" {
                                    media_url = urlencoding::decode(v).ok().map(|s| s.into_owned());
                                }
                            }
                        }
                    } else if !body_part.trim().is_empty() {
                        #[derive(Deserialize)]
                        struct ResolvePayload { url: String }
                        if let Ok(p) = serde_json::from_str::<ResolvePayload>(body_part.trim()) {
                            media_url = Some(p.url);
                        }
                    }

                    if let Some(url) = media_url {
                        let resolved = resolve_media_options(&url).await;
                        let json_resp = serde_json::to_string(&resolved).unwrap_or_else(|_| "{\"formats\":[]}".into());
                        let resp = send_response(&json_resp);
                        let _ = socket.write_all(resp.as_bytes()).await;
                        let _ = socket.flush().await;
                        return;
                    }
                }

                if first_line.contains("/download") {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }

                    let mut download_url = None;
                    let mut download_name = None;
                    let mut download_cookies = None;
                    let mut download_referer = None;
                    let mut download_ua = None;
                    let mut download_parts = None;

                    #[derive(Deserialize)]
                    struct RpcDownloadPayload {
                        url: String,
                        filename: Option<String>,
                        cookies: Option<String>,
                        referer: Option<String>,
                        user_agent: Option<String>,
                        parts: Option<usize>,
                    }

                    if let Ok(payload) = serde_json::from_str::<RpcDownloadPayload>(body_part.trim()) {
                        download_url = Some(payload.url);
                        download_name = payload.filename;
                        download_cookies = payload.cookies;
                        download_referer = payload.referer;
                        download_ua = payload.user_agent;
                        download_parts = payload.parts;
                    } else if let Some(query_start) = first_line.find('?') {
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
                        let cfg = {
                            let s = cfg_ref.lock().await;
                            s.clone()
                        };

                        let parts_to_use = download_parts.unwrap_or(cfg.max_connections);
                        let ua_to_use = download_ua.or(Some(cfg.user_agent));

                        let _ = start_download_internal(
                            app,
                            dl_map,
                            url,
                            download_name,
                            Some(cfg.download_dir),
                            Some(parts_to_use),
                            download_cookies,
                            download_referer,
                            ua_to_use,
                            cfg.open_folder_on_finish,
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
    if let Ok(mut stream) = std::net::TcpStream::connect("127.0.0.1:41738") {
        use std::io::Write;
        let _ = stream.write_all(b"GET /show HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        let _ = stream.flush();
        return;
    }

    register_pew_protocol();

    let initial_settings = load_saved_settings();
    let app_state = AppState {
        downloads: Arc::new(Mutex::new(HashMap::new())),
        settings: Arc::new(Mutex::new(initial_settings)),
    };

    let downloads_ref = app_state.downloads.clone();
    let settings_ref = app_state.settings.clone();

    tauri::Builder::default()
        .manage(app_state)
        .setup(move |app| {
            start_local_rpc_server(app.handle().clone(), downloads_ref, settings_ref);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            probe_url,
            start_download,
            get_downloads,
            open_in_folder,
            open_file,
            delete_download,
            get_settings,
            save_settings,
            select_folder,
            resolve_url_formats
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
