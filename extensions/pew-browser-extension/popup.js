// Popup Script
document.addEventListener('DOMContentLoaded', async () => {
  const listEl = document.getElementById('media-list');
  const emptyEl = document.getElementById('empty-box');
  const statusBadge = document.getElementById('app-status-badge');
  const statusText = document.getElementById('app-status-text');
  const openGuiBtn = document.getElementById('btn-open-gui');

  // Check connection to Pew Desktop App
  chrome.runtime.sendMessage({ action: 'CHECK_PEW_STATUS' }, (res) => {
    if (res && res.connected) {
      statusBadge.className = 'app-status status-online';
      statusText.textContent = 'Pew Connected';
    } else {
      statusBadge.className = 'app-status status-offline';
      statusText.textContent = 'Pew Offline';
    }
  });

  // Open Pew App button
  openGuiBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'SHOW_PEW_APP' });
    openGuiBtn.textContent = '✓ Opening...';
    setTimeout(() => openGuiBtn.innerHTML = '<span>⚡ Open Pew App</span>', 2000);
  });

  // Query active tab media
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  chrome.runtime.sendMessage({ action: 'GET_TAB_MEDIA', tabId: tab.id }, (response) => {
    const media = (response && response.media) || [];

    if (media.length === 0) {
      emptyEl.style.display = 'block';
      listEl.style.display = 'none';
      return;
    }

    emptyEl.style.display = 'none';
    listEl.style.display = 'flex';
    listEl.innerHTML = '';

    media.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'media-card';

      const quality = item.quality || 'Video';
      const format = item.format || 'MP4';
      const filename = getFilename(item.url, tab.title, quality, format);
      const sizeText = item.size > 0 ? formatBytes(item.size) : 'Stream';

      card.innerHTML = `
        <div class="media-title" title="${filename}">${filename}</div>
        <div class="media-meta">
          <div class="tag-group">
            <span class="tag-quality">${quality}</span>
            <span class="tag-format">${format}</span>
          </div>
          <span class="size">${sizeText}</span>
        </div>
        <div class="save-to">📁 Downloads\\${filename}</div>
        <div class="action-group">
          <button class="btn-dl" title="Send to Pew Desktop App">⚡ Download with Pew</button>
          <button class="btn-copy" title="Copy Stream URL">Copy</button>
        </div>
      `;

      card.querySelector('.btn-dl').addEventListener('click', () => {
        chrome.runtime.sendMessage({
          action: 'TRIGGER_PEW_DOWNLOAD',
          url: item.url,
          filename: filename
        });
        const btn = card.querySelector('.btn-dl');
        btn.textContent = '✓ Sent to Pew!';
        setTimeout(() => btn.textContent = '⚡ Download with Pew', 2000);
      });

      card.querySelector('.btn-copy').addEventListener('click', () => {
        navigator.clipboard.writeText(item.url);
        const btn = card.querySelector('.btn-copy');
        btn.textContent = '✓';
        setTimeout(() => btn.textContent = 'Copy', 1500);
      });

      listEl.appendChild(card);
    });
  });
});

function getFilename(url, pageTitle, quality, format) {
  let title = (pageTitle || '').replace(/[\\/:*?"<>|]/g, '_').replace(/ - YouTube$/, '').trim();
  title = title.substring(0, 45);

  const ext = format.toLowerCase().includes('audio') || format.toLowerCase().includes('m4a') ? 'm4a' : 'mp4';

  if (title) {
    return `${title}_${quality}.${ext}`;
  }

  const cleanUrl = url.split('?')[0].split('#')[0];
  const name = cleanUrl.split('/').pop();
  if (name && name.includes('.')) {
    return name;
  }

  return `video_${quality}.${ext}`;
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
