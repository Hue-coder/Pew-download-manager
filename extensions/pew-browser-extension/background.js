// Pew Integration Background Service Worker (Robust Media Resolver & Sniffer)
const tabMediaStore = new Map(); // tabId -> Array of media items

// 1. Automatic Download Interception
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
    // Desktop app offline, browser handles normally
  }
});

// 2. Resolve media options via Pew Desktop Core
async function resolvePageMedia(url, tabId, pageTitle) {
  if (!url || !url.startsWith('http')) return [];

  try {
    const resolveEndpoint = `http://127.0.0.1:41738/resolve?url=${encodeURIComponent(url)}`;
    const resp = await fetch(resolveEndpoint, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return [];

    const data = await resp.json();
    if (data && data.success && Array.isArray(data.formats) && data.formats.length > 0) {
      const items = data.formats.map((f, idx) => ({
        id: f.id || `fmt_${idx}_${Date.now()}`,
        url: f.url,
        filename: f.filename,
        format: f.format,
        quality: f.quality,
        mediaType: f.media_type,
        size: f.size || 0,
        priority: getQualityPriority(f.quality),
        timestamp: Date.now()
      }));

      items.sort((a, b) => a.priority - b.priority);
      tabMediaStore.set(tabId, items);

      updateBadge(tabId, items.length);
      notifyTab(tabId, items);
      return items;
    }
  } catch (e) {
    // Local app not ready or network timeout
  }
  return [];
}

function getQualityPriority(q) {
  if (q.includes('4K') || q.includes('2160')) return 1;
  if (q.includes('2K') || q.includes('1440')) return 2;
  if (q.includes('1080')) return 3;
  if (q.includes('720')) return 4;
  if (q.includes('480')) return 5;
  if (q.includes('360')) return 6;
  if (q.includes('MP3')) return 7;
  if (q.includes('WAV')) return 8;
  if (q.includes('M4A')) return 9;
  return 10;
}

function updateBadge(tabId, count) {
  try {
    if (count > 0) {
      chrome.action.setBadgeText({ tabId, text: String(count) });
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#06b6d4' });
    } else {
      chrome.action.setBadgeText({ tabId, text: '' });
    }
  } catch (e) {}
}

function notifyTab(tabId, mediaList) {
  try {
    chrome.tabs.sendMessage(tabId, {
      action: 'PEW_MEDIA_FOUND',
      allMedia: mediaList
    }).catch(() => {});
  } catch (e) {}
}

// 3. Tab Lifecycle Monitoring
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    tabMediaStore.delete(tabId);
    updateBadge(tabId, 0);
  }

  const url = (tab && tab.url) || '';
  if (changeInfo.status === 'complete' && url.startsWith('http')) {
    resolvePageMedia(url, tabId, tab.title);
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const media = tabMediaStore.get(activeInfo.tabId) || [];
  updateBadge(activeInfo.tabId, media.length);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabMediaStore.delete(tabId);
});

// 4. Network Sniffer Fallback
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

    if (url.includes('.m3u8') || contentType.includes('mpegurl')) {
      addDirectMediaItem(details.tabId, {
        id: 'hls_' + hashStr(url),
        url: url,
        filename: 'stream.mp4',
        format: 'HLS Stream',
        quality: 'Video Stream (.m3u8)',
        mediaType: 'video',
        size: 0,
        priority: 4,
        timestamp: Date.now()
      });
      return;
    }

    const cleanUrl = url.split('?')[0].toLowerCase();
    const hasVideoExt = ['.mp4', '.m4v', '.webm', '.mkv', '.mov', '.avi', '.flv', '.ts'].some(e => cleanUrl.endsWith(e));
    if (hasVideoExt || (contentType.startsWith('video/') && !contentType.includes('html'))) {
      if (contentLength > 0 && contentLength < 100 * 1024) return;
      if (url.includes('googlevideo.com')) return;

      const ext = cleanUrl.includes('.') ? cleanUrl.split('.').pop().toUpperCase() : 'MP4';
      addDirectMediaItem(details.tabId, {
        id: 'vid_' + hashStr(url),
        url: url,
        filename: cleanUrl.split('/').pop() || 'video.mp4',
        format: ext,
        quality: 'Video (' + ext + ')',
        mediaType: 'video',
        size: contentLength,
        priority: 4,
        timestamp: Date.now()
      });
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

function addDirectMediaItem(tabId, item) {
  let list = tabMediaStore.get(tabId) || [];
  if (!list.some(m => m.id === item.id || m.url === item.url)) {
    list.push(item);
    list.sort((a, b) => a.priority - b.priority);
    tabMediaStore.set(tabId, list);
    updateBadge(tabId, list.length);
    notifyTab(tabId, list);
  }
}

function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

// 5. Messaging API
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = (sender.tab && sender.tab.id) || message.tabId;

  if (message.action === 'GET_TAB_MEDIA') {
    const media = tabMediaStore.get(tabId) || [];
    sendResponse({ media });
    return true;
  }

  if (message.action === 'REQUEST_RESOLVE') {
    if (message.url && tabId) {
      resolvePageMedia(message.url, tabId, message.title).then(items => {
        sendResponse({ media: items });
      });
      return true;
    }
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
        referer: sender.tab ? sender.tab.url : '',
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
