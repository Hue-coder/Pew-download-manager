// Pew Integration Background Service Worker (Robust Media Sniffer & Resolver)
const detectedMedia = new Map(); // tabId -> Array of media streams
const resolvedYouTubeTabs = new Map(); // tabId -> last resolved videoId

// 1. AUTOMATIC DOWNLOAD INTERCEPTION (IDM / XDM Style)
chrome.downloads.onCreated.addListener(async (downloadItem) => {
  const url = downloadItem.finalUrl || downloadItem.url;
  if (!url || url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('chrome:')) {
    return;
  }

  try {
    const health = await fetch('http://127.0.0.1:41738/health', { signal: AbortSignal.timeout(1000) }).then(r => r.json());
    if (health && health.status === 'running') {
      chrome.downloads.cancel(downloadItem.id).catch(() => {});
      chrome.downloads.erase({ id: downloadItem.id }).catch(() => {});

      const filename = downloadItem.filename ? downloadItem.filename.split(/[\\/]/).pop() : undefined;

      await fetch('http://127.0.0.1:41738/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: url,
          filename: filename,
          referer: downloadItem.referrer || '',
          user_agent: navigator.userAgent,
          parts: 8
        })
      });
    }
  } catch (e) {
    // Pew desktop app is offline, browser handles download normally
  }
});

// 2. YOUTUBE VIDEO RESOLVER (Direct Progressive & Adaptive Extraction)
async function resolveYouTubeVideo(videoId, tabId, tabTitle) {
  if (!videoId) return;

  try {
    const resp = await fetch('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId: videoId,
        context: {
          client: {
            clientName: 'ANDROID_VR',
            clientVersion: '1.58.18'
          }
        }
      })
    });

    const data = await resp.json();
    if (!data || !data.streamingData) return;

    const baseTitle = (data.videoDetails && data.videoDetails.title) 
      ? data.videoDetails.title.replace(/[\\/:*?"<>|]/g, '_')
      : (tabTitle || 'YouTube_Video').replace(/[\\/:*?"<>|]/g, '_');

    const items = [];

    // A. Progressive formats (Contains combined Video + Audio)
    const progFormats = data.streamingData.formats || [];
    for (const f of progFormats) {
      if (f.url) {
        const quality = f.qualityLabel || '360p';
        items.push({
          id: `yt_prog_${f.itag}_${videoId}`,
          url: f.url,
          filename: `${baseTitle}_${quality}.mp4`,
          format: 'MP4',
          quality: `${quality} (Video + Audio)`,
          mediaType: 'combined',
          size: parseInt(f.contentLength || '0', 10),
          priority: 1,
          timestamp: Date.now()
        });
      }
    }

    // B. High-resolution adaptive formats (1080p, 720p, etc.)
    const adaptFormats = data.streamingData.adaptiveFormats || [];
    const seenQualities = new Set();

    for (const f of adaptFormats) {
      if (!f.url) continue;
      const mime = (f.mimeType || '').toLowerCase();
      const isVideo = mime.startsWith('video/');
      const isAudio = mime.startsWith('audio/');

      if (isVideo) {
        const quality = f.qualityLabel || 'HD';
        const isMp4 = mime.includes('mp4');
        const key = `${quality}_${isMp4 ? 'mp4' : 'webm'}`;

        if (!seenQualities.has(key)) {
          seenQualities.add(key);
          const ext = isMp4 ? 'mp4' : 'webm';
          const priority = quality.includes('1080') ? 2 : (quality.includes('720') ? 3 : 4);

          items.push({
            id: `yt_adapt_${f.itag}_${videoId}`,
            url: f.url,
            filename: `${baseTitle}_${quality}.${ext}`,
            format: ext.toUpperCase(),
            quality: `${quality} (${ext.toUpperCase()})`,
            mediaType: 'video',
            size: parseInt(f.contentLength || '0', 10),
            priority: priority,
            timestamp: Date.now()
          });
        }
      } else if (isAudio) {
        const isM4a = mime.includes('mp4');
        const key = isM4a ? 'm4a' : 'opus';

        if (!seenQualities.has(key)) {
          seenQualities.add(key);
          const ext = isM4a ? 'm4a' : 'opus';
          const kbps = Math.round((f.bitrate || 128000) / 1000);

          items.push({
            id: `yt_audio_${f.itag}_${videoId}`,
            url: f.url,
            filename: `${baseTitle}_Audio_${kbps}k.${ext}`,
            format: isM4a ? 'M4A' : 'AUDIO',
            quality: `Audio (${kbps}k ${ext.toUpperCase()})`,
            mediaType: 'audio',
            size: parseInt(f.contentLength || '0', 10),
            priority: 5,
            timestamp: Date.now()
          });
        }
      }
    }

    for (const it of items) {
      addMediaForTab(tabId, it);
    }
  } catch (err) {
    console.warn('Pew YouTube resolver error:', err);
  }
}

// 3. NETWORK TRAFFIC SNIFFER (Generic Sites & Streams)
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!details.tabId || details.tabId < 0) return;

    const url = details.url;
    const headers = details.responseHeaders || [];

    let contentType = '';
    let contentLength = 0;

    for (const h of headers) {
      const name = h.name.toLowerCase();
      if (name === 'content-type') contentType = (h.value || '').toLowerCase();
      else if (name === 'content-length') contentLength = parseInt(h.value || '0', 10);
    }

    // A. Detect HLS (.m3u8) Streams across any site
    if (url.includes('.m3u8') || contentType.includes('mpegurl') || contentType.includes('application/x-mpegurl')) {
      const item = {
        id: 'hls_' + hashStr(url),
        url: url,
        filename: 'stream.mp4',
        format: 'HLS Stream',
        quality: 'Video Stream (.m3u8)',
        mediaType: 'combined',
        size: 0,
        priority: 1,
        timestamp: Date.now()
      };
      addMediaForTab(details.tabId, item);
      return;
    }

    // B. Detect Direct Video MIME types or Extensions
    const cleanUrl = url.split('?')[0].toLowerCase();
    const hasVideoExt = ['.mp4', '.m4v', '.webm', '.mkv', '.mov', '.avi', '.flv', '.ts'].some(e => cleanUrl.endsWith(e));
    const isVideoMime = contentType.startsWith('video/') && !contentType.includes('html');

    if (hasVideoExt || isVideoMime) {
      // Ignore tiny previews / tracker gifs
      if (contentLength > 0 && contentLength < 100 * 1024) return;
      if (url.includes('googlevideo.com')) return; // YouTube handled cleanly by resolver

      const ext = cleanUrl.includes('.') ? cleanUrl.split('.').pop().toUpperCase() : 'MP4';
      const item = {
        id: 'vid_' + hashStr(url),
        url: url,
        filename: cleanUrl.split('/').pop() || 'video.mp4',
        format: ext.length <= 4 ? ext : 'MP4',
        quality: 'Video File',
        mediaType: 'combined',
        size: contentLength,
        priority: 1,
        timestamp: Date.now()
      };
      addMediaForTab(details.tabId, item);
      return;
    }

    // C. Detect Audio Streams
    const hasAudioExt = ['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg'].some(e => cleanUrl.endsWith(e));
    if (hasAudioExt || (contentType.startsWith('audio/') && !contentType.includes('html'))) {
      if (contentLength > 0 && contentLength < 80 * 1024) return;
      if (url.includes('googlevideo.com')) return;

      const ext = cleanUrl.includes('.') ? cleanUrl.split('.').pop().toUpperCase() : 'AUDIO';
      const item = {
        id: 'aud_' + hashStr(url),
        url: url,
        filename: cleanUrl.split('/').pop() || 'audio.mp3',
        format: ext.length <= 4 ? ext : 'AUDIO',
        quality: 'Audio File',
        mediaType: 'audio',
        size: contentLength,
        priority: 6,
        timestamp: Date.now()
      };
      addMediaForTab(details.tabId, item);
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

function addMediaForTab(tabId, item) {
  let list = detectedMedia.get(tabId) || [];

  const idx = list.findIndex(m => m.id === item.id || (m.quality === item.quality && m.format === item.format));
  if (idx >= 0) {
    list[idx] = item;
  } else {
    list.push(item);
  }

  list.sort((a, b) => (a.priority || 99) - (b.priority || 99));
  detectedMedia.set(tabId, list);

  chrome.action.setBadgeText({ tabId, text: String(list.length) });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#06b6d4' });

  chrome.tabs.sendMessage(tabId, {
    action: 'PEW_MEDIA_FOUND',
    mediaCount: list.length,
    allMedia: list
  }).catch(() => {});
}

function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

// 4. Tab Navigation and Lifecycle
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    detectedMedia.delete(tabId);
    chrome.action.setBadgeText({ tabId, text: '' });
  }

  // Check for YouTube navigation
  const currentUrl = tab.url || '';
  if (currentUrl.includes('youtube.com/watch') || currentUrl.includes('youtu.be/')) {
    const vMatch = currentUrl.match(/[?&]v=([a-zA-Z0-9_-]+)/) || currentUrl.match(/youtu\.be\/([a-zA-Z0-9_-]+)/);
    if (vMatch && vMatch[1]) {
      const vid = vMatch[1];
      if (resolvedYouTubeTabs.get(tabId) !== vid) {
        resolvedYouTubeTabs.set(tabId, vid);
        resolveYouTubeVideo(vid, tabId, tab.title);
      }
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  detectedMedia.delete(tabId);
  resolvedYouTubeTabs.delete(tabId);
});

// 5. Runtime Messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'GET_TAB_MEDIA') {
    const tabId = message.tabId || (sender.tab && sender.tab.id);
    const media = detectedMedia.get(tabId) || [];
    sendResponse({ media });
    return true;
  }

  if (message.action === 'RESOLVE_YOUTUBE') {
    const tabId = (sender.tab && sender.tab.id) || message.tabId;
    if (message.videoId && tabId) {
      resolveYouTubeVideo(message.videoId, tabId, message.title);
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'MEDIA_FROM_DOM') {
    if (sender.tab && sender.tab.id && message.item) {
      addMediaForTab(sender.tab.id, message.item);
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'SHOW_PEW_APP') {
    fetch('http://127.0.0.1:41738/show', { method: 'POST' }).catch(() => {});
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'CHECK_PEW_STATUS') {
    fetch('http://127.0.0.1:41738/health', { signal: AbortSignal.timeout(1000) })
      .then(r => r.json())
      .then(() => sendResponse({ connected: true }))
      .catch(() => sendResponse({ connected: false }));
    return true;
  }

  if (message.action === 'TRIGGER_PEW_DOWNLOAD') {
    const { url, filename } = message;

    fetch('http://127.0.0.1:41738/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: url,
        filename: filename,
        referer: url.includes('googlevideo.com') ? 'https://www.youtube.com/' : (sender.tab ? sender.tab.url : ''),
        user_agent: navigator.userAgent,
        parts: 8
      })
    })
    .then(r => r.json())
    .then(() => sendResponse({ success: true }))
    .catch(() => {
      // Pew desktop app not reachable: trigger native browser save
      chrome.downloads.download({ url, filename, saveAs: true });
      sendResponse({ success: true });
    });

    return true;
  }
});
