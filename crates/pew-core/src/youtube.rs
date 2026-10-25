use serde::{Deserialize, Serialize};
use crate::error::{PewError, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YouTubeStreamInfo {
    pub title: String,
    pub video_id: String,
    pub quality: String,
    pub mime_type: String,
    pub url: String,
    pub content_length: Option<u64>,
}

pub fn extract_youtube_video_id(url: &str) -> Option<String> {
    if let Ok(parsed) = url::Url::parse(url) {
        if parsed.host_str().map_or(false, |h| h.contains("youtube.com")) {
            for (k, v) in parsed.query_pairs() {
                if k == "v" && !v.is_empty() {
                    return Some(v.into_owned());
                }
            }
            if let Some(mut segs) = parsed.path_segments() {
                if let Some(first) = segs.next() {
                    if first == "shorts" || first == "embed" || first == "v" {
                        if let Some(id) = segs.next() {
                            return Some(id.to_string());
                        }
                    }
                }
            }
        } else if parsed.host_str().map_or(false, |h| h.contains("youtu.be")) {
            if let Some(mut segs) = parsed.path_segments() {
                if let Some(id) = segs.next() {
                    if !id.is_empty() {
                        return Some(id.to_string());
                    }
                }
            }
        }
    }
    None
}

pub async fn resolve_youtube_stream(client: &reqwest::Client, video_id: &str) -> Result<YouTubeStreamInfo> {
    let payload = serde_json::json!({
        "videoId": video_id,
        "context": {
            "client": {
                "clientName": "ANDROID_VR",
                "clientVersion": "1.58.18"
            }
        }
    });

    let resp = client
        .post("https://www.youtube.com/youtubei/v1/player")
        .header("Content-Type", "application/json")
        .body(payload.to_string())
        .send()
        .await?;

    if !resp.status().is_success() {
        return Err(PewError::HttpStatus(resp.status()));
    }

    let text_val = resp.text().await?;
    let json_val: serde_json::Value = serde_json::from_str(&text_val)?;

    let playability = json_val["playabilityStatus"]["status"].as_str().unwrap_or("");
    if playability != "OK" {
        let reason = json_val["playabilityStatus"]["reason"].as_str().unwrap_or("Video unplayable");
        return Err(PewError::Custom(format!("YouTube error: {}", reason)));
    }

    let title = json_val["videoDetails"]["title"]
        .as_str()
        .unwrap_or("YouTube_Video")
        .replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_");

    let streaming_data = &json_val["streamingData"];
    
    // First try progressive format (contains both audio and video)
    if let Some(formats) = streaming_data["formats"].as_array() {
        for f in formats {
            if let Some(url) = f["url"].as_str() {
                let quality = f["qualityLabel"].as_str().unwrap_or("360p").to_string();
                let mime = f["mimeType"].as_str().unwrap_or("video/mp4").to_string();
                let clen = f["contentLength"].as_str().and_then(|s| s.parse::<u64>().ok());
                return Ok(YouTubeStreamInfo {
                    title,
                    video_id: video_id.to_string(),
                    quality,
                    mime_type: mime,
                    url: url.to_string(),
                    content_length: clen,
                });
            }
        }
    }

    // Fallback to highest quality MP4 video in adaptiveFormats
    if let Some(adapt) = streaming_data["adaptiveFormats"].as_array() {
        for f in adapt {
            let mime = f["mimeType"].as_str().unwrap_or("");
            if mime.starts_with("video/mp4") {
                if let Some(url) = f["url"].as_str() {
                    let quality = f["qualityLabel"].as_str().unwrap_or("HD").to_string();
                    let clen = f["contentLength"].as_str().and_then(|s| s.parse::<u64>().ok());
                    return Ok(YouTubeStreamInfo {
                        title,
                        video_id: video_id.to_string(),
                        quality,
                        mime_type: mime.to_string(),
                        url: url.to_string(),
                        content_length: clen,
                    });
                }
            }
        }
    }

    Err(PewError::Custom("No downloadable format with direct URL found".to_string()))
}
