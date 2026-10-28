// Pew Integration Background Service Worker (Robust Media Resolver & Sniffer)
const tabMediaStore = new Map(); // tabId -> Array of media items
const EXTENSION_START_TIME = Date.now();

// 1. Browser Download Interception (Disabled by default to prevent hijacking unwanted browser downloads)
// Only catches explicit archive/installer downloads if the user explicitly turns it on in extension settings.
chrome.downloads.onCreated.addListener(async (downloadItem) => {
  try {
    const settings = await chrome.storage.local.get({ auto_intercept: false });
    if (!settings.auto_intercept) {
      return;
    }

    // Never intercept during the first 15 seconds after browser startup
    if (Date.now() - EXTENSION_START_TIME < 15000) {
      return;
    }

    const url = downloadItem.finalUrl || downloadItem.url;
    if (!url || !url.startsWith('http')) {
      return;
    }

    // Comprehensive whitelist: Catch archives, installers, FTP movies, media, and torrent files
    const clean = url.split('?')[0].toLowerCase();
    const allowedExts = [
      '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso',
      '.exe', '.msi', '.dmg', '.pkg', '.deb', '.rpm', '.apk',
      '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v',
      '.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a',
      '.torrent', '.pdf', '.bin'
    ];
    const isAllowed = allowedExts.some(ext => clean.endsWith(ext));
    if (!isAllowed) {
      return;
    }

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
    // Desktop app offline or request failed, browser handles download normally
  }
});

// 2. Resolve media options via Pew Desktop Core
async function resolvePageMedia(url, tabId, pageTitle) {
  if (!url || !url.startsWith('http')) return [];

  try {
    const resolveEndpoint = `http://127.0.0.1:41738/resolve?url=${encodeURIComponent(url)}`;
    const resp = await fetch(resolveEndpoint, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return [];

    const data = await resp.json();
    if (data && data.success && Array.isArray(data.formats) && data.formats.length > 0) {
      const items = data.formats.map((f, idx) => ({
        id: f.id || `fmt_${idx}_${Date.now()}`,
        url: f.url,
        audio_url: f.audio_url || undefined,
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

function isVideoPlatform(url) {
  if (!url || !url.startsWith('http')) return false;
  return /youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|tiktok\.com|twitter\.com|x\.com|facebook\.com|instagram\.com|twitch\.tv|pinterest\.com|reddit\.com/i.test(url);
}

// 3. Tab Lifecycle Monitoring
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    tabMediaStore.delete(tabId);
    updateBadge(tabId, 0);
  }

  const url = (tab && tab.url) || '';
  if (changeInfo.status === 'complete' && url.startsWith('http')) {
    if (isVideoPlatform(url)) {
      resolvePageMedia(url, tabId, tab.title);
    }
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

    // Avoid polluting tab media list with background chunks or thumbnails
    if (url.includes('googlevideo.com')) return;
    if (url.includes('pinimg.com') && !url.includes('.m3u8') && !url.includes('.mp4')) return;

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
    // Ignore internal streaming segments/chunks to keep file manager and download list clean
    if (cleanUrl.endsWith('.ts') || cleanUrl.includes('.ts?') || cleanUrl.includes('/segment') || cleanUrl.includes('/frag') || cleanUrl.includes('range=')) return;

    const hasVideoExt = ['.mp4', '.m4v', '.webm', '.mkv', '.mov', '.avi', '.flv'].some(e => cleanUrl.endsWith(e));
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

// Auto-wake Pew engine if offline and send download request
async function triggerPewDownloadWithAutoWake(payload) {
  // 1. First attempt: If Pew is already running
  try {
    const res = await fetch('http://127.0.0.1:41738/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2000)
    });
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    // Pew is offline or starting up
  }

  // 2. Launch Pew Desktop in background via protocol
  let helperTabId = null;
  try {
    chrome.tabs.create({ url: 'pew://start', active: false }, (tab) => {
      if (tab && tab.id) helperTabId = tab.id;
    });
  } catch (e) {}

  // 3. Retry connecting to Pew every 800ms for up to 10 seconds
  for (let attempt = 0; attempt < 12; attempt++) {
    await new Promise(r => setTimeout(r, 800));
    try {
      const retryRes = await fetch('http://127.0.0.1:41738/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(2000)
      });
      if (retryRes.ok) {
        if (helperTabId) {
          chrome.tabs.remove(helperTabId).catch(() => {});
        }
        return await retryRes.json();
      }
    } catch (e) {}
  }

  if (helperTabId) {
    chrome.tabs.remove(helperTabId).catch(() => {});
  }

  throw new Error('PEW_OFFLINE');
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
    fetch('http://127.0.0.1:41738/show', { method: 'POST', signal: AbortSignal.timeout(1500) })
      .then(() => sendResponse({ success: true }))
      .catch(() => {
        try {
          chrome.tabs.create({ url: 'pew://show', active: false }, (tab) => {
            setTimeout(() => {
              if (tab && tab.id) chrome.tabs.remove(tab.id).catch(() => {});
            }, 2000);
          });
        } catch (e) {}
        sendResponse({ success: true, launchedProtocol: true });
      });
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
    const { url, filename, audio_url } = message;
    const payload = {
      url: url,
      audio_url: audio_url || undefined,
      filename: filename,
      referer: sender.tab ? sender.tab.url : '',
      user_agent: navigator.userAgent,
      parts: 8
    };

    triggerPewDownloadWithAutoWake(payload)
      .then(data => sendResponse({ success: true, task_id: data.task_id }))
      .catch(err => sendResponse({ success: false, error: 'PEW_OFFLINE' }));

    return true;
  }

  if (message.action === 'POLL_TASK_PROGRESS') {
    const taskId = message.taskId;
    fetch(`http://127.0.0.1:41738/task?id=${encodeURIComponent(taskId)}`, { signal: AbortSignal.timeout(3000) })
      .then(r => r.json())
      .then(data => sendResponse({ success: true, task: data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'OPEN_DOWNLOAD_FILE') {
    const path = message.path;
    const taskId = message.taskId;
    const queryParts = [];
    if (path) queryParts.push(`path=${encodeURIComponent(path)}`);
    if (taskId) queryParts.push(`id=${encodeURIComponent(taskId)}`);
    const query = queryParts.join('&');
    fetch(`http://127.0.0.1:41738/open_file?${query}`, { signal: AbortSignal.timeout(3000) })
      .then(r => r.json())
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'OPEN_DOWNLOAD_FOLDER') {
    const path = message.path;
    const taskId = message.taskId;
    const queryParts = [];
    if (path) queryParts.push(`path=${encodeURIComponent(path)}`);
    if (taskId) queryParts.push(`id=${encodeURIComponent(taskId)}`);
    const query = queryParts.join('&');
    fetch(`http://127.0.0.1:41738/open_folder?${query}`, { signal: AbortSignal.timeout(3000) })
      .then(r => r.json())
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});
