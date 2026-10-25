// Pew Integration Background Service Worker (XDM Architecture)
const detectedMedia = new Map(); // tabId -> Array of media streams
let interceptDownloads = true;

// 1. AUTOMATIC DOWNLOAD INTERCEPTION (Like XDM / IDM)
chrome.downloads.onCreated.addListener(async (downloadItem) => {
  if (!interceptDownloads) return;

  const url = downloadItem.finalUrl || downloadItem.url;
  // Ignore data URIs or internal browser extensions
  if (!url || url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('chrome:')) {
    return;
  }

  // Check if Pew Desktop App is active
  try {
    const healthCheck = await fetch('http://127.0.0.1:41738/health').then(r => r.json());
    if (healthCheck && healthCheck.status === 'running') {
      // Cancel the slow built-in browser download
      chrome.downloads.cancel(downloadItem.id).catch(() => {});
      chrome.downloads.erase({ id: downloadItem.id }).catch(() => {});

      // Collect session cookies for authenticated sites (Mega, Drive, etc.)
      const cookies = await getCookiesForUrl(url);

      const filename = downloadItem.filename ? downloadItem.filename.split(/[\\/]/).pop() : undefined;

      // Pass directly to Pew Desktop App
      await fetch('http://127.0.0.1:41738/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: url,
          filename: filename,
          cookies: cookies,
          referer: downloadItem.referrer || '',
          user_agent: navigator.userAgent,
          parts: 8
        })
      });
    }
  } catch (e) {
    // Pew desktop app is not open, let the browser download normally
  }
});

async function getCookiesForUrl(url) {
  try {
    const cookieList = await chrome.cookies.getAll({ url });
    return cookieList.map(c => `${c.name}=${c.value}`).join('; ');
  } catch (e) {
    return '';
  }
}

// 2. VIDEO STREAM SNIFFER (YouTube, HLS, DASH, MP4)
const YT_ITAG_MAP = {
  '22':  { res: '720p HD (Video + Audio)', format: 'MP4', type: 'combined', priority: 1 },
  '18':  { res: '360p SD (Video + Audio)', format: 'MP4', type: 'combined', priority: 2 },
  '137': { res: '1080p Full HD (Video Only)', format: 'MP4', type: 'video', priority: 3 },
  '248': { res: '1080p (WebM Video)', format: 'WebM', type: 'video', priority: 4 },
  '136': { res: '720p (MP4 Video)', format: 'MP4', type: 'video', priority: 5 },
  '140': { res: 'Original Audio (128k M4A)', format: 'M4A', type: 'audio', priority: 6 },
  '251': { res: 'Original Audio (160k Opus)', format: 'Opus', type: 'audio', priority: 7 }
};

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

    // A. Detect HLS (.m3u8) Playlists (Used on 90% of streaming video sites)
    if (url.includes('.m3u8') || contentType.includes('mpegurl') || contentType.includes('application/x-mpegurl')) {
      const item = {
        id: 'hls_' + generateHash(url),
        url: url,
        format: 'HLS Stream',
        quality: 'Original Quality',
        mediaType: 'hls',
        size: 0,
        isStream: true,
        timestamp: Date.now()
      };
      addMediaForTab(details.tabId, item);
      return;
    }

    // B. Detect YouTube Streams (googlevideo.com)
    if (url.includes('googlevideo.com/videoplayback')) {
      const itagMatch = url.match(/[?&]itag=(\d+)/);
      const itag = itagMatch ? itagMatch[1] : null;

      if (!itag || !YT_ITAG_MAP[itag]) return;

      const info = YT_ITAG_MAP[itag];

      // Strip chunk range parameters so Pew downloads the complete master stream
      const fullMediaUrl = url.replace(/([?&])range=\d+-\d+(&|$)/g, '$1')
                              .replace(/([?&])rn=\d+(&|$)/g, '$1')
                              .replace(/([?&])alr=yes(&|$)/g, '$1')
                              .replace(/&&+/g, '&')
                              .replace(/\?&/, '?')
                              .replace(/[?&]$/, '');

      const item = {
        id: `yt_${itag}_${details.tabId}`,
        url: fullMediaUrl,
        contentType: contentType,
        size: contentLength,
        format: info.format,
        quality: info.res,
        mediaType: info.type,
        priority: info.priority,
        isStream: true,
        timestamp: Date.now()
      };

      addMediaForTab(details.tabId, item);
      return;
    }

    // C. Detect Direct Video Files (.mp4, .mkv, .webm, etc.)
    const cleanUrl = url.split('?')[0].toLowerCase();
    if (cleanUrl.endsWith('.mp4') || cleanUrl.endsWith('.mkv') || cleanUrl.endsWith('.webm') || cleanUrl.endsWith('.mov')) {
      const ext = cleanUrl.split('.').pop().toUpperCase();
      const item = {
        id: 'direct_' + generateHash(url),
        url: url,
        contentType: contentType,
        size: contentLength,
        format: ext,
        quality: 'Direct Video',
        mediaType: 'video',
        priority: 10,
        isStream: false,
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

  const existingIdx = list.findIndex(m => m.id === item.id || (m.quality === item.quality && m.format === item.format));
  if (existingIdx >= 0) {
    list[existingIdx] = item;
  } else {
    list.push(item);
  }

  // Sort by priority (combined playable videos first)
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

  if (message.action === 'SHOW_PEW_APP') {
    fetch('http://127.0.0.1:41738/show', { method: 'POST' }).catch(() => {});
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'CHECK_PEW_STATUS') {
    fetch('http://127.0.0.1:41738/health')
      .then(r => r.json())
      .then(() => sendResponse({ connected: true }))
      .catch(() => sendResponse({ connected: false }));
    return true;
  }

  if (message.action === 'TRIGGER_PEW_DOWNLOAD') {
    (async () => {
      const { url, filename } = message;
      const cookies = await getCookiesForUrl(url);

      fetch('http://127.0.0.1:41738/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: url,
          filename: filename,
          cookies: cookies,
          referer: url.includes('googlevideo.com') ? 'https://www.youtube.com/' : '',
          user_agent: navigator.userAgent,
          parts: 8
        })
      })
      .then(r => r.json())
      .then(() => sendResponse({ success: true }))
      .catch((err) => {
        // Fallback: browser download
        chrome.downloads.download({ url, filename, saveAs: true });
        sendResponse({ success: false });
      });
    })();
    return true;
  }
});
