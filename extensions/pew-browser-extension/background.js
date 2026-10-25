// Pew Media Grabber - Service Worker (Background)
const detectedMedia = new Map(); // tabId -> Array of media items

// YouTube ITAG quality mapping
const YT_ITAG_MAP = {
  '137': { res: '1080p', format: 'MP4', type: 'video' },
  '248': { res: '1080p', format: 'WebM', type: 'video' },
  '136': { res: '720p', format: 'MP4', type: 'video' },
  '247': { res: '720p', format: 'WebM', type: 'video' },
  '22':  { res: '720p (Audio)', format: 'MP4', type: 'video' },
  '135': { res: '480p', format: 'MP4', type: 'video' },
  '244': { res: '480p', format: 'WebM', type: 'video' },
  '134': { res: '360p', format: 'MP4', type: 'video' },
  '18':  { res: '360p (Audio)', format: 'MP4', type: 'video' },
  '140': { res: '128k', format: 'M4A', type: 'audio' },
  '251': { res: '160k', format: 'Opus', type: 'audio' }
};

const MEDIA_MIME_PATTERNS = [
  /^video\//i,
  /^audio\//i,
  /application\/(x-)?mpegurl/i,
  /application\/vnd\.apple\.mpegurl/i,
  /application\/dash\+xml/i,
  /application\/octet-stream/i
];

const MEDIA_EXTENSIONS = [
  '.mp4', '.m4v', '.webm', '.mkv', '.avi', '.mov', '.flv', '.wmv',
  '.ts', '.m3u8', '.mpd',
  '.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg'
];

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!details.tabId || details.tabId < 0) return;

    const url = details.url;
    const headers = details.responseHeaders || [];

    let contentType = '';
    let contentLength = 0;

    for (const h of headers) {
      const name = h.name.toLowerCase();
      if (name === 'content-type') contentType = h.value || '';
      else if (name === 'content-length') contentLength = parseInt(h.value || '0', 10);
    }

    // Special handling for YouTube streaming URLs
    if (url.includes('googlevideo.com/videoplayback')) {
      const itagMatch = url.match(/[?&]itag=(\d+)/);
      const itag = itagMatch ? itagMatch[1] : null;

      let quality = 'Video';
      let format = 'MP4';
      let mediaType = 'video';

      if (itag && YT_ITAG_MAP[itag]) {
        const info = YT_ITAG_MAP[itag];
        quality = info.res;
        format = info.format;
        mediaType = info.type;
      } else if (contentType.includes('audio')) {
        quality = 'Audio';
        format = 'M4A';
        mediaType = 'audio';
      }

      const item = {
        id: `yt_${itag || 'stream'}_${details.tabId}`,
        url: url,
        contentType: contentType,
        size: contentLength,
        format: format,
        quality: quality,
        mediaType: mediaType,
        isStream: true,
        timestamp: Date.now()
      };

      addMediaForTab(details.tabId, item);
      return;
    }

    // Standard media URLs
    if (isMediaTarget(url, contentType, contentLength)) {
      const detectedFmt = detectFormat(url, contentType);
      const item = {
        id: generateHash(url),
        url: url,
        contentType: contentType,
        size: contentLength,
        format: detectedFmt.format,
        quality: detectedFmt.quality,
        mediaType: detectedFmt.type,
        isStream: false,
        timestamp: Date.now()
      };

      addMediaForTab(details.tabId, item);
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

function isMediaTarget(url, contentType, contentLength) {
  const cleanUrl = url.split('?')[0].toLowerCase();
  const hasMediaExt = MEDIA_EXTENSIONS.some(ext => cleanUrl.endsWith(ext));
  if (hasMediaExt) return true;

  const matchesMime = MEDIA_MIME_PATTERNS.some(p => p.test(contentType));
  if (matchesMime) {
    if (contentType.includes('mpegurl') || contentType.includes('dash+xml')) return true;
    if (contentLength > 150 * 1024 || contentLength === 0) return true;
  }
  return false;
}

function detectFormat(url, contentType) {
  const cleanUrl = url.split('?')[0].toLowerCase();
  for (const ext of MEDIA_EXTENSIONS) {
    if (cleanUrl.endsWith(ext)) {
      const fmt = ext.replace('.', '').toUpperCase();
      const isAudio = ['MP3', 'M4A', 'AAC', 'FLAC', 'WAV', 'OGG'].includes(fmt);
      return { format: fmt, quality: isAudio ? 'Audio' : 'Video', type: isAudio ? 'audio' : 'video' };
    }
  }

  if (contentType.includes('mp4')) return { format: 'MP4', quality: 'HD', type: 'video' };
  if (contentType.includes('webm')) return { format: 'WebM', quality: 'HD', type: 'video' };
  if (contentType.includes('mpegurl')) return { format: 'HLS', quality: 'Multi-Res', type: 'video' };
  if (contentType.includes('dash+xml')) return { format: 'DASH', quality: 'Multi-Res', type: 'video' };
  if (contentType.includes('audio')) return { format: 'Audio', quality: 'Audio', type: 'audio' };

  return { format: 'MP4', quality: 'Video', type: 'video' };
}

function generateHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return 'media_' + Math.abs(hash);
}

function addMediaForTab(tabId, item) {
  let list = detectedMedia.get(tabId) || [];
  
  // If item with same quality & format already exists, update URL
  const existingIdx = list.findIndex(m => m.quality === item.quality && m.format === item.format);
  if (existingIdx >= 0) {
    list[existingIdx] = item;
  } else {
    // Put videos first, then audios
    if (item.mediaType === 'video') {
      list.unshift(item);
    } else {
      list.push(item);
    }
  }

  detectedMedia.set(tabId, list);

  chrome.action.setBadgeText({ tabId, text: String(list.length) });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#06b6d4' });

  chrome.tabs.sendMessage(tabId, {
    action: 'PEW_MEDIA_FOUND',
    mediaCount: list.length,
    newMedia: item,
    allMedia: list
  }).catch(() => {});
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    detectedMedia.delete(tabId);
    chrome.action.setBadgeText({ tabId, text: '' });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  detectedMedia.delete(tabId);
});

// Messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'GET_TAB_MEDIA') {
    const tabId = message.tabId || (sender.tab && sender.tab.id);
    const media = detectedMedia.get(tabId) || [];
    sendResponse({ media });
    return true;
  }

  if (message.action === 'SHOW_PEW_APP') {
    fetch('http://127.0.0.1:41738/show', { method: 'POST' })
      .then(res => res.json())
      .then(() => sendResponse({ success: true }))
      .catch(() => {
        // Fallback: launch custom protocol
        chrome.tabs.create({ url: 'pew://show', active: false }, (t) => {
          setTimeout(() => { if (t && t.id) chrome.tabs.remove(t.id).catch(() => {}); }, 1000);
        });
        sendResponse({ success: false });
      });
    return true;
  }

  if (message.action === 'CHECK_PEW_STATUS') {
    fetch('http://127.0.0.1:41738/health')
      .then(res => res.json())
      .then(() => sendResponse({ connected: true }))
      .catch(() => sendResponse({ connected: false }));
    return true;
  }

  if (message.action === 'TRIGGER_PEW_DOWNLOAD') {
    const { url, filename } = message;

    // Send direct RPC to Pew Desktop App
    fetch('http://127.0.0.1:41738/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: url,
        filename: filename,
        parts: 8
      })
    })
    .then(r => r.json())
    .then(() => {
      sendResponse({ success: true, method: 'rpc' });
    })
    .catch(() => {
      // Fallback 1: try custom protocol
      const pewProtocolUrl = `pew://download?url=${encodeURIComponent(url)}&name=${encodeURIComponent(filename || '')}`;
      chrome.tabs.create({ url: pewProtocolUrl, active: false }, (t) => {
        setTimeout(() => { if (t && t.id) chrome.tabs.remove(t.id).catch(() => {}); }, 1000);
      });

      // Fallback 2: chrome downloads
      chrome.downloads.download({
        url: url,
        filename: filename || undefined,
        saveAs: false
      });

      sendResponse({ success: true, method: 'fallback' });
    });

    return true;
  }
});
