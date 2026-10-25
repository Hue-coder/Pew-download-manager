// Pew Media Grabber - Service Worker (Background)
const detectedMedia = new Map(); // tabId -> Array of media items

// Media MIME types to catch
const MEDIA_MIME_PATTERNS = [
  /^video\//i,
  /^audio\//i,
  /application\/(x-)?mpegurl/i,
  /application\/vnd\.apple\.mpegurl/i,
  /application\/dash\+xml/i,
  /application\/octet-stream/i // often used for video files or direct downloads
];

// Media file extensions to catch
const MEDIA_EXTENSIONS = [
  '.mp4', '.m4v', '.webm', '.mkv', '.avi', '.mov', '.flv', '.wmv',
  '.ts', '.m3u8', '.mpd',
  '.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg'
];

// Listen to web responses
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    // Only check requests originating from standard tabs
    if (!details.tabId || details.tabId < 0) return;

    const url = details.url;
    const headers = details.responseHeaders || [];

    let contentType = '';
    let contentLength = 0;
    let contentDisposition = '';

    for (const h of headers) {
      const name = h.name.toLowerCase();
      if (name === 'content-type') contentType = h.value || '';
      else if (name === 'content-length') contentLength = parseInt(h.value || '0', 10);
      else if (name === 'content-disposition') contentDisposition = h.value || '';
    }

    const isMedia = isMediaTarget(url, contentType, contentDisposition, contentLength);
    if (isMedia) {
      const item = {
        id: generateHash(url),
        url: url,
        contentType: contentType,
        size: contentLength,
        format: detectFormat(url, contentType),
        timestamp: Date.now()
      };

      addMediaForTab(details.tabId, item);
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// Determine if request represents downloadable video/audio
function isMediaTarget(url, contentType, disposition, contentLength) {
  const urlLower = url.split('?')[0].toLowerCase();

  // Check URL extension
  const hasMediaExt = MEDIA_EXTENSIONS.some(ext => urlLower.endsWith(ext));
  if (hasMediaExt) return true;

  // Check MIME type
  const matchesMime = MEDIA_MIME_PATTERNS.some(p => p.test(contentType));
  if (matchesMime) {
    // Skip tiny sound effects (< 120KB) unless it's a playlist (.m3u8 or .mpd)
    const isPlaylist = contentType.includes('mpegurl') || contentType.includes('dash+xml') || urlLower.includes('.m3u8') || urlLower.includes('.mpd');
    if (isPlaylist) return true;
    if (contentLength > 120 * 1024 || contentLength === 0) return true;
  }

  // Check Content-Disposition attachment
  if (disposition && disposition.toLowerCase().includes('attachment')) {
    if (contentLength > 500 * 1024) return true;
  }

  return false;
}

function detectFormat(url, contentType) {
  const cleanUrl = url.split('?')[0].toLowerCase();
  for (const ext of MEDIA_EXTENSIONS) {
    if (cleanUrl.endsWith(ext)) return ext.replace('.', '').toUpperCase();
  }
  if (contentType.includes('mp4')) return 'MP4';
  if (contentType.includes('webm')) return 'WEBM';
  if (contentType.includes('mpegurl')) return 'HLS (M3U8)';
  if (contentType.includes('dash+xml')) return 'DASH (MPD)';
  if (contentType.includes('audio')) return 'AUDIO';
  return 'VIDEO';
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
  
  // Prevent duplicate URLs
  if (list.some(m => m.url === item.url)) return;

  list.push(item);
  detectedMedia.set(tabId, list);

  // Update extension badge count
  chrome.action.setBadgeText({ tabId, text: String(list.length) });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#06b6d4' });

  // Notify active tab's content script to show/update floating IDM panel
  chrome.tabs.sendMessage(tabId, {
    action: 'PEW_MEDIA_FOUND',
    mediaCount: list.length,
    newMedia: item,
    allMedia: list
  }).catch(() => {
    // Content script might not be injected yet
  });
}

// Clear tab records on navigation or closed tabs
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    detectedMedia.delete(tabId);
    chrome.action.setBadgeText({ tabId, text: '' });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  detectedMedia.delete(tabId);
});

// Handle messages from Popup or Content Script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'GET_TAB_MEDIA') {
    const tabId = message.tabId || (sender.tab && sender.tab.id);
    const media = detectedMedia.get(tabId) || [];
    sendResponse({ media });
    return true;
  }

  if (message.action === 'TRIGGER_PEW_DOWNLOAD') {
    const { url, filename } = message;
    // Launch Pew via custom URI protocol or browser download
    const pewProtocolUrl = `pew://download?url=${encodeURIComponent(url)}&name=${encodeURIComponent(filename || '')}`;
    
    // Attempt opening custom protocol
    chrome.tabs.create({ url: pewProtocolUrl, active: false }, (tab) => {
      // Automatically close helper tab if opened
      setTimeout(() => {
        if (tab && tab.id) chrome.tabs.remove(tab.id).catch(() => {});
      }, 1000);
    });

    sendResponse({ success: true });
    return true;
  }
});
