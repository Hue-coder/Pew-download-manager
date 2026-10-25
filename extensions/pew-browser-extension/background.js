// Pew Integration Background Service Worker (Rock-solid Sniffer)
const detectedMedia = new Map(); // tabId -> Array of media streams

// 1. AUTOMATIC DOWNLOAD INTERCEPTION
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
    // Pew desktop app is offline, let browser handle download
  }
});

// YouTube ITAG resolution map
const YT_ITAG_MAP = {
  '22':  '720p HD (Video + Audio)',
  '18':  '360p (Video + Audio)',
  '137': '1080p Full HD',
  '248': '1080p (WebM)',
  '399': '1080p (AV1)',
  '136': '720p HD',
  '247': '720p (WebM)',
  '398': '720p (AV1)',
  '135': '480p',
  '244': '480p (WebM)',
  '397': '480p (AV1)',
  '134': '360p',
  '243': '360p (WebM)',
  '140': 'Audio (128k M4A)',
  '251': 'Audio (160k Opus)'
};

// 2. NETWORK TRAFFIC SNIFFER
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

    // A. Detect YouTube googlevideo streams
    if (url.includes('googlevideo.com/videoplayback')) {
      const itagMatch = url.match(/[?&]itag=(\d+)/);
      const itag = itagMatch ? itagMatch[1] : '';

      const isAudio = itag === '140' || itag === '251' || contentType.includes('audio');
      const isCombined = itag === '22' || itag === '18';

      let quality = YT_ITAG_MAP[itag] || (isAudio ? 'Audio Stream' : (isCombined ? '720p (With Audio)' : 'Video Stream'));
      let format = isAudio ? 'M4A' : 'MP4';

      // Clean stream url
      const fullUrl = url.replace(/([?&])range=\d+-\d+(&|$)/g, '$1')
                         .replace(/([?&])rn=\d+(&|$)/g, '$1')
                         .replace(/([?&])alr=yes(&|$)/g, '$1')
                         .replace(/&&+/g, '&')
                         .replace(/\?&/, '?')
                         .replace(/[?&]$/, '');

      const item = {
        id: `yt_${itag || 'stream'}_${details.tabId}`,
        url: fullUrl,
        format: format,
        quality: quality,
        mediaType: isCombined ? 'combined' : (isAudio ? 'audio' : 'video'),
        size: contentLength,
        priority: isCombined ? 1 : (isAudio ? 5 : 2),
        timestamp: Date.now()
      };

      addMediaForTab(details.tabId, item);
      return;
    }

    // B. Detect HLS (.m3u8) Streams
    if (url.includes('.m3u8') || contentType.includes('mpegurl') || contentType.includes('application/x-mpegurl')) {
      const item = {
        id: 'hls_' + hashStr(url),
        url: url,
        format: 'HLS Stream',
        quality: 'Original Stream',
        mediaType: 'combined',
        size: 0,
        priority: 1,
        timestamp: Date.now()
      };
      addMediaForTab(details.tabId, item);
      return;
    }

    // C. Detect Video MIME types or Extensions
    const cleanUrl = url.split('?')[0].toLowerCase();
    const hasVideoExt = ['.mp4', '.m4v', '.webm', '.mkv', '.mov', '.avi', '.flv'].some(e => cleanUrl.endsWith(e));
    const isVideoMime = contentType.startsWith('video/') || contentType.includes('video/mp4') || contentType.includes('video/webm');

    if (hasVideoExt || isVideoMime) {
      // Ignore tiny icons/previews
      if (contentLength > 0 && contentLength < 150 * 1024) return;

      const ext = cleanUrl.includes('.') ? cleanUrl.split('.').pop().toUpperCase() : 'MP4';
      const item = {
        id: 'video_' + hashStr(url),
        url: url,
        format: ext.length <= 4 ? ext : 'MP4',
        quality: 'Video (Direct)',
        mediaType: 'combined',
        size: contentLength,
        priority: 1,
        timestamp: Date.now()
      };
      addMediaForTab(details.tabId, item);
      return;
    }

    // D. Detect Audio
    const hasAudioExt = ['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg'].some(e => cleanUrl.endsWith(e));
    if (hasAudioExt || contentType.startsWith('audio/')) {
      if (contentLength > 0 && contentLength < 100 * 1024) return;
      const ext = cleanUrl.includes('.') ? cleanUrl.split('.').pop().toUpperCase() : 'AUDIO';
      const item = {
        id: 'audio_' + hashStr(url),
        url: url,
        format: ext.length <= 4 ? ext : 'AUDIO',
        quality: 'Audio Track',
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

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    detectedMedia.delete(tabId);
    chrome.action.setBadgeText({ tabId, text: '' });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  detectedMedia.delete(tabId);
});

// Runtime Messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'GET_TAB_MEDIA') {
    const tabId = message.tabId || (sender.tab && sender.tab.id);
    const media = detectedMedia.get(tabId) || [];
    sendResponse({ media });
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
        referer: url.includes('googlevideo.com') ? 'https://www.youtube.com/' : '',
        user_agent: navigator.userAgent,
        parts: 8
      })
    })
    .then(r => r.json())
    .then(() => sendResponse({ success: true }))
    .catch(() => {
      chrome.downloads.download({ url, filename, saveAs: true });
      sendResponse({ success: true });
    });

    return true;
  }
});
