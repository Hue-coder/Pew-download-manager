use reqwest::header::{ACCEPT_RANGES, CONTENT_DISPOSITION, CONTENT_LENGTH, ETAG};
use reqwest::Client;
use url::Url;
use crate::error::{PewError, Result};
use crate::youtube::{extract_youtube_video_id, resolve_youtube_stream};

#[derive(Debug, Clone)]
pub struct RemoteFileInfo {
    pub url: String,
    pub filename: String,
    pub content_length: Option<u64>,
    pub accepts_ranges: bool,
    pub etag: Option<String>,
}

impl RemoteFileInfo {
    pub async fn probe(client: &Client, url: &str) -> Result<Self> {
        // If it's a YouTube watch link, resolve stream directly
        if let Some(vid) = extract_youtube_video_id(url) {
            if let Ok(yt) = resolve_youtube_stream(client, &vid).await {
                return Ok(Self {
                    url: yt.url,
                    filename: format!("{}_{}.mp4", yt.title, yt.quality),
                    content_length: yt.content_length,
                    accepts_ranges: true,
                    etag: None,
                });
            }
        }

        let parsed_url = Url::parse(url).map_err(|e| PewError::InvalidUrl(e.to_string()))?;
        
        // Try HEAD first with browser headers; if failed, fall back to Range 0-0 GET
        let head_req = client.head(url)
            .header("User-Agent", crate::downloader::CHROME_USER_AGENT)
            .header("Referer", if url.contains("googlevideo.com") { "https://www.youtube.com/" } else { "" });

        let response = match head_req.send().await {
            Ok(resp) if resp.status().is_success() => resp,
            _ => {
                let mut get_req = client.get(url)
                    .header("User-Agent", crate::downloader::CHROME_USER_AGENT)
                    .header("Range", "bytes=0-0");
                if url.contains("googlevideo.com") {
                    get_req = get_req.header("Referer", "https://www.youtube.com/");
                }
                get_req.send().await?
            }
        };

        if !response.status().is_success() && response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
            return Err(PewError::HttpStatus(response.status()));
        }

        let headers = response.headers();

        let accepts_ranges = headers
            .get(ACCEPT_RANGES)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.eq_ignore_ascii_case("bytes"))
            .unwrap_or(false)
            || response.status() == reqwest::StatusCode::PARTIAL_CONTENT;

        let content_length = if let Some(len_header) = headers.get(CONTENT_LENGTH) {
            len_header.to_str().ok().and_then(|v| v.parse::<u64>().ok())
        } else if let Some(range_header) = headers.get(reqwest::header::CONTENT_RANGE) {
            // E.g. "bytes 0-0/1048576"
            range_header
                .to_str()
                .ok()
                .and_then(|v| v.split('/').last())
                .and_then(|v| v.parse::<u64>().ok())
        } else {
            None
        };

        let etag = headers
            .get(ETAG)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());

        let filename = Self::extract_filename(headers.get(CONTENT_DISPOSITION), &parsed_url);

        Ok(Self {
            url: url.to_string(),
            filename,
            content_length,
            accepts_ranges,
            etag,
        })
    }

    fn extract_filename(disposition: Option<&reqwest::header::HeaderValue>, url: &Url) -> String {
        if let Some(disp) = disposition.and_then(|v| v.to_str().ok()) {
            // Check for filename*=UTF-8''... or filename="..."
            for part in disp.split(';') {
                let part = part.trim();
                if part.to_ascii_lowercase().starts_with("filename*=") {
                    let val = &part[10..];
                    if let Some(idx) = val.find("''") {
                        let decoded = &val[idx + 2..];
                        if let Ok(unescaped) = urlencoding::decode(decoded) {
                            return unescaped.into_owned();
                        }
                    }
                } else if part.to_ascii_lowercase().starts_with("filename=") {
                    let val = part[9..].trim_matches('"').trim();
                    if !val.is_empty() {
                        return val.to_string();
                    }
                }
            }
        }

        // Fallback to URL path
        if let Some(segments) = url.path_segments() {
            if let Some(last) = segments.last() {
                if !last.is_empty() {
                    return last.to_string();
                }
            }
        }

        "downloaded_file".to_string()
    }
}
