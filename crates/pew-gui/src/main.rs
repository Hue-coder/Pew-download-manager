// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
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
    pub audio_url: Option<String>,
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

fn find_ffmpeg() -> Option<PathBuf> {
    if let Ok(appdata) = std::env::var("APPDATA") {
        let p = PathBuf::from(appdata).join("PewDownloadManager").join("bin").join("ffmpeg.exe");
        if p.exists() {
            return Some(p);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let p = parent.join("ffmpeg.exe");
            if p.exists() {
                return Some(p);
            }
            let p_bin = parent.join("bin").join("ffmpeg.exe");
            if p_bin.exists() {
                return Some(p_bin);
            }
        }
    }
    if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
        let p = PathBuf::from(localappdata)
            .join("Python")
            .join("pythoncore-3.14-64")
            .join("Lib")
            .join("site-packages")
            .join("static_ffmpeg")
            .join("bin")
            .join("win32")
            .join("ffmpeg.exe");
        if p.exists() {
            return Some(p);
        }
    }
    Some(PathBuf::from("ffmpeg"))
}

async fn mux_video_audio(ffmpeg_exe: &Path, vid_path: &Path, aud_path: &Path, out_path: &Path) -> Result<(), String> {
    let vid_str = vid_path.to_string_lossy().to_string();
    let aud_str = aud_path.to_string_lossy().to_string();
    let out_str = out_path.to_string_lossy().to_string();
    let ffmpeg_str = ffmpeg_exe.to_string_lossy().to_string();

    tokio::task::spawn_blocking(move || {
        let status = std::process::Command::new(ffmpeg_str)
            .args([
                "-y",
                "-i", &vid_str,
                "-i", &aud_str,
                "-c:v", "copy",
                "-c:a", "aac",
                "-movflags", "+faststart",
                &out_str,
            ])
            .output();

        match status {
            Ok(o) if o.status.success() => Ok(()),
            Ok(o) => {
                let err = String::from_utf8_lossy(&o.stderr);
                Err(format!("FFmpeg mux error: {}", err))
            }
            Err(e) => Err(format!("Could not run FFmpeg: {}", e)),
        }
    }).await.map_err(|e| e.to_string())?
}

async fn convert_audio(ffmpeg_exe: &Path, in_path: &Path, out_path: &Path, target_ext: &str) -> Result<(), String> {
    let in_str = in_path.to_string_lossy().to_string();
    let out_str = out_path.to_string_lossy().to_string();
    let ffmpeg_str = ffmpeg_exe.to_string_lossy().to_string();
    let ext = target_ext.to_lowercase();

    tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(ffmpeg_str);
        cmd.args(["-y", "-i", &in_str, "-vn"]);
        if ext == "mp3" {
            cmd.args(["-c:a", "libmp3lame", "-q:a", "2"]);
        } else if ext == "wav" {
            cmd.args(["-c:a", "pcm_s16le"]);
        } else {
            cmd.args(["-c:a", "copy"]);
        }
        cmd.arg(&out_str);

        match cmd.output() {
            Ok(o) if o.status.success() => Ok(()),
            Ok(o) => {
                let err = String::from_utf8_lossy(&o.stderr);
                Err(format!("FFmpeg audio conversion error: {}", err))
            }
            Err(e) => Err(format!("Could not run FFmpeg: {}", e)),
        }
    }).await.map_err(|e| e.to_string())?
}

fn show_main_window(app: &AppHandle) {
    let win = app.get_webview_window("main").or_else(|| {
        app.webview_windows().into_values().next()
    });

    if let Some(window) = win {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_always_on_top(true);
        let _ = window.set_focus();
        let _ = window.set_always_on_top(false);
    } else {
        let _ = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
            .title("Pew Download Manager")
            .inner_size(1080.0, 700.0)
            .min_inner_size(850.0, 550.0)
            .center()
            .build();
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
                                    let ext = f["ext"].as_str().unwrap_or("");
                                    if ext == "m4a" {
                                        break;
                                    }
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
                                        let v_size = f["filesize"].as_u64().or_else(|| f["filesize_approx"].as_u64()).unwrap_or(0);
                                        let has_audio = f["acodec"].as_str().map(|a| a != "none").unwrap_or(false);
                                        let (final_audio_url, total_size) = if has_audio {
                                            (None, v_size)
                                        } else {
                                            (audio_url.clone(), if v_size > 0 { v_size + audio_size } else { 0 })
                                        };

                                        formats.push(ResolvedFormat {
                                            id: format!("vid_{}", h),
                                            quality: label.to_string(),
                                            format: "MP4".to_string(),
                                            url: u.to_string(),
                                            audio_url: final_audio_url,
                                            size: total_size,
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
                                audio_url: None,
                                size: audio_size,
                                media_type: "audio".to_string(),
                                filename: format!("{}_Audio.mp3", clean_title),
                            });
                            formats.push(ResolvedFormat {
                                id: "aud_wav".to_string(),
                                quality: "WAV Audio (Lossless)".to_string(),
                                format: "WAV".to_string(),
                                url: a_url.clone(),
                                audio_url: None,
                                size: audio_size,
                                media_type: "audio".to_string(),
                                filename: format!("{}_Audio.wav", clean_title),
                            });
                            formats.push(ResolvedFormat {
                                id: "aud_m4a".to_string(),
                                quality: "M4A Audio (Original AAC)".to_string(),
                                format: "M4A".to_string(),
                                url: a_url,
                                audio_url: None,
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
    audio_url: Option<String>,
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
        audio_url,
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
    audio_url: Option<String>,
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
        filename: initial_name.clone(),
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
            cookies: cookies.clone(),
            referer: referer.clone(),
            user_agent: user_agent.clone().unwrap_or_else(|| pew_core::downloader::CHROME_USER_AGENT.to_string()),
            ..Default::default()
        };

        let downloader = Downloader::new(config.clone());
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
                            if item.status == "Completed" {
                                continue;
                            }
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
                            if item.status == "Completed" {
                                continue;
                            }
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

        let target_final_path = out_dir.join(&initial_name);

        if let Some(ref a_url) = audio_url {
            // Adaptive video stream with separate audio stream -> Download both and mux
            let temp_vid_name = format!("{}.vid.tmp", task_id);
            let temp_aud_name = format!("{}.aud.tmp", task_id);
            let temp_vid_path = out_dir.join(&temp_vid_name);
            let temp_aud_path = out_dir.join(&temp_aud_name);

            // Channel for video progress
            let (v_tx, mut v_rx) = mpsc::unbounded_channel::<DownloadEvent>();
            let main_tx = tx.clone();
            let v_name = initial_name.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(ev) = v_rx.recv().await {
                    match ev {
                        DownloadEvent::Started { total_bytes, parts, .. } => {
                            let _ = main_tx.send(DownloadEvent::Started {
                                total_bytes,
                                parts,
                                filename: v_name.clone(),
                            });
                        }
                        DownloadEvent::Progress { downloaded, total, speed_bps } => {
                            let _ = main_tx.send(DownloadEvent::Progress { downloaded, total, speed_bps });
                        }
                        _ => {}
                    }
                }
            });

            // 1. Download video track
            let dl_vid_res = downloader.download(&url, &out_dir, Some(&temp_vid_name), Some(v_tx)).await;
            if let Err(e) = dl_vid_res {
                let _ = tokio::fs::remove_file(&temp_vid_path).await;
                let mut map = downloads_ref.lock().await;
                if let Some(item) = map.get_mut(&task_id) {
                    item.status = "Error".to_string();
                    item.error = Some(format!("Video stream error: {}", e));
                    let _ = app_handle.emit("download-update", item.clone());
                }
                return;
            }

            // 2. Download audio track
            {
                let mut map = downloads_ref.lock().await;
                if let Some(item) = map.get_mut(&task_id) {
                    item.status = "Fetching Audio Stream...".to_string();
                    item.speed_bps = 0.0;
                    let _ = app_handle.emit("download-update", item.clone());
                }
            }

            let dl_aud_res = downloader.download(a_url, &out_dir, Some(&temp_aud_name), None).await;
            if let Err(_) = dl_aud_res {
                // If audio fails, fallback to video only
                let _ = tokio::fs::rename(&temp_vid_path, &target_final_path).await;
                let _ = tokio::fs::remove_file(&temp_aud_path).await;
                let final_size = tokio::fs::metadata(&target_final_path).await.map(|m| m.len()).unwrap_or(0);
                let _ = tx.send(DownloadEvent::Completed {
                    path: target_final_path,
                    total_bytes: final_size,
                });
                let _ = progress_tracker.await;
                return;
            }

            // 3. Mux Video and Audio via FFmpeg
            {
                let mut map = downloads_ref.lock().await;
                if let Some(item) = map.get_mut(&task_id) {
                    item.status = "Merging Audio & Video...".to_string();
                    item.speed_bps = 0.0;
                    let _ = app_handle.emit("download-update", item.clone());
                }
            }

            let ffmpeg = find_ffmpeg().unwrap_or_else(|| PathBuf::from("ffmpeg"));
            let mux_res = mux_video_audio(&ffmpeg, &temp_vid_path, &temp_aud_path, &target_final_path).await;

            let _ = tokio::fs::remove_file(&temp_vid_path).await;
            let _ = tokio::fs::remove_file(&temp_aud_path).await;

            if let Err(err) = mux_res {
                tracing::warn!("FFmpeg mux error: {}. Keeping video stream.", err);
                let _ = tokio::fs::rename(&temp_vid_path, &target_final_path).await;
            }

            let final_size = tokio::fs::metadata(&target_final_path).await.map(|m| m.len()).unwrap_or(0);
            let _ = tx.send(DownloadEvent::Completed {
                path: target_final_path,
                total_bytes: final_size,
            });
            let _ = progress_tracker.await;

        } else if initial_name.to_lowercase().ends_with(".mp3") || initial_name.to_lowercase().ends_with(".wav") {
            // Audio conversion to MP3 / WAV
            let temp_aud_name = format!("{}.raw_aud.tmp", task_id);
            let temp_aud_path = out_dir.join(&temp_aud_name);

            let (a_tx, mut a_rx) = mpsc::unbounded_channel::<DownloadEvent>();
            let main_tx = tx.clone();
            let a_name = initial_name.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(ev) = a_rx.recv().await {
                    match ev {
                        DownloadEvent::Started { total_bytes, parts, .. } => {
                            let _ = main_tx.send(DownloadEvent::Started {
                                total_bytes,
                                parts,
                                filename: a_name.clone(),
                            });
                        }
                        DownloadEvent::Progress { downloaded, total, speed_bps } => {
                            let _ = main_tx.send(DownloadEvent::Progress { downloaded, total, speed_bps });
                        }
                        _ => {}
                    }
                }
            });

            match downloader.download(&url, &out_dir, Some(&temp_aud_name), Some(a_tx)).await {
                Ok(_) => {
                    let target_ext = if initial_name.to_lowercase().ends_with(".mp3") { "mp3" } else { "wav" };
                    {
                        let mut map = downloads_ref.lock().await;
                        if let Some(item) = map.get_mut(&task_id) {
                            item.status = format!("Converting to {}...", target_ext.to_uppercase());
                            item.speed_bps = 0.0;
                            let _ = app_handle.emit("download-update", item.clone());
                        }
                    }

                    let ffmpeg = find_ffmpeg().unwrap_or_else(|| PathBuf::from("ffmpeg"));
                    let conv_res = convert_audio(&ffmpeg, &temp_aud_path, &target_final_path, target_ext).await;
                    let _ = tokio::fs::remove_file(&temp_aud_path).await;

                    if let Err(err) = conv_res {
                        let mut map = downloads_ref.lock().await;
                        if let Some(item) = map.get_mut(&task_id) {
                            item.status = "Error".to_string();
                            item.error = Some(err);
                            let _ = app_handle.emit("download-update", item.clone());
                        }
                        return;
                    }

                    let final_size = tokio::fs::metadata(&target_final_path).await.map(|m| m.len()).unwrap_or(0);
                    let _ = tx.send(DownloadEvent::Completed {
                        path: target_final_path,
                        total_bytes: final_size,
                    });
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
        } else {
            // Standard direct file or HLS download
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

#[tauri::command]
fn exit_app(app: AppHandle) {
    app.exit(0);
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
                    show_main_window(&app);
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
                    show_main_window(&app);

                    let mut download_url = None;
                    let mut download_audio_url = None;
                    let mut download_name = None;
                    let mut download_cookies = None;
                    let mut download_referer = None;
                    let mut download_ua = None;
                    let mut download_parts = None;

                    #[derive(Deserialize)]
                    struct RpcDownloadPayload {
                        url: String,
                        audio_url: Option<String>,
                        filename: Option<String>,
                        cookies: Option<String>,
                        referer: Option<String>,
                        user_agent: Option<String>,
                        parts: Option<usize>,
                    }

                    if let Ok(payload) = serde_json::from_str::<RpcDownloadPayload>(body_part.trim()) {
                        download_url = Some(payload.url);
                        download_audio_url = payload.audio_url;
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
                                } else if k == "audio_url" {
                                    download_audio_url = urlencoding::decode(v).ok().map(|s| s.into_owned());
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
                            download_audio_url,
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
        use std::io::{Read, Write};
        let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(800)));
        let _ = stream.write_all(b"GET /show HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        let _ = stream.flush();

        let mut buf = [0u8; 512];
        if let Ok(n) = stream.read(&mut buf) {
            let resp = String::from_utf8_lossy(&buf[..n]);
            if resp.contains("200 OK") {
                // Successfully notified running instance to show window
                return;
            }
        }
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
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
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
            resolve_url_formats,
            exit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
