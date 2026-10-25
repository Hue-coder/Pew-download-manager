// Popup Script
document.addEventListener('DOMContentLoaded', async () => {
  const listEl = document.getElementById('media-list');
  const emptyEl = document.getElementById('empty-box');
  const countBadge = document.getElementById('media-count-badge');

  // Query active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  chrome.runtime.sendMessage({ action: 'GET_TAB_MEDIA', tabId: tab.id }, (response) => {
    const media = (response && response.media) || [];
    countBadge.textContent = `${media.length} Media`;

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

      const filename = getFilename(item.url, tab.title);
      const sizeText = item.size > 0 ? formatBytes(item.size) : 'Stream';

      card.innerHTML = `
        <div class="media-title" title="${filename}">${filename}</div>
        <div class="media-meta">
          <div class="tag-group">
            <span class="tag">${item.format}</span>
            <span class="size">${sizeText}</span>
          </div>
        </div>
        <div class="action-group">
          <button class="btn-dl" title="Download via Pew">⚡ Download with Pew</button>
          <button class="btn-copy" title="Copy Link">Copy</button>
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

function getFilename(url, pageTitle) {
  const cleanTitle = (pageTitle || '').replace(/[\\/:*?"<>|]/g, '_').substring(0, 35);
  const cleanUrl = url.split('?')[0].split('#')[0];
  const name = cleanUrl.split('/').pop();
  if (name && name.includes('.')) {
    return cleanTitle ? `${cleanTitle}_${name}` : name;
  }
  return cleanTitle ? `${cleanTitle}.mp4` : 'video.mp4';
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
