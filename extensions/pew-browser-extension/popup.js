// Popup Script
document.addEventListener('DOMContentLoaded', async () => {
  const listEl = document.getElementById('media-list');
  const emptyEl = document.getElementById('empty-box');
  const statusBadge = document.getElementById('app-status-badge');
  const statusText = document.getElementById('app-status-text');
  const openGuiBtn = document.getElementById('btn-open-gui');

  let currentMedia = [];
  let currentFilter = 'all';

  // Check connection to Pew Desktop App
  function checkPewStatus() {
    fetch('http://127.0.0.1:41738/health', { signal: AbortSignal.timeout(1000) })
      .then(r => r.json())
      .then(() => {
        statusBadge.className = 'app-status status-online';
        statusText.textContent = 'Pew Connected';
      })
      .catch(() => {
        statusBadge.className = 'app-status status-offline';
        statusText.textContent = 'Pew Offline';
      });
  }

  checkPewStatus();

  // Open Pew App button
  openGuiBtn.addEventListener('click', () => {
    fetch('http://127.0.0.1:41738/show', { method: 'POST' }).catch(() => {});
    openGuiBtn.textContent = '✓ Opening...';
    setTimeout(() => openGuiBtn.innerHTML = '<span>🖥️ Open Pew App</span>', 2000);
  });

  // Tab Filtering
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.tab;
      renderMediaCards();
    });
  });

  // Query active tab
  let [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab || !activeTab.url) return;

  const tabUrl = activeTab.url;

  // 1. Try direct resolve via local Pew Core
  try {
    const resolveResp = await fetch(`http://127.0.0.1:41738/resolve?url=${encodeURIComponent(tabUrl)}`, {
      signal: AbortSignal.timeout(6000)
    });
    if (resolveResp.ok) {
      const data = await resolveResp.json();
      if (data && data.success && Array.isArray(data.formats) && data.formats.length > 0) {
        currentMedia = data.formats.map(f => ({
          id: f.id,
          url: f.url,
          audio_url: f.audio_url || undefined,
          filename: f.filename,
          format: f.format,
          quality: f.quality,
          mediaType: f.media_type,
          size: f.size || 0
        }));
        renderMediaCards();
        return;
      }
    }
  } catch (e) {}

  // 2. Fallback to background store
  if (activeTab.id) {
    chrome.runtime.sendMessage({ action: 'GET_TAB_MEDIA', tabId: activeTab.id }, (response) => {
      const media = (response && response.media) || [];
      if (media.length > 0) {
        currentMedia = media;
        renderMediaCards();
      } else {
        emptyEl.style.display = 'flex';
        listEl.style.display = 'none';
      }
    });
  }

  function renderMediaCards() {
    const filtered = currentMedia.filter(item => {
      if (currentFilter === 'video') return item.mediaType === 'video';
      if (currentFilter === 'audio') return item.mediaType === 'audio';
      return true;
    });

    if (filtered.length === 0) {
      emptyEl.style.display = 'flex';
      listEl.style.display = 'none';
      return;
    }

    emptyEl.style.display = 'none';
    listEl.style.display = 'flex';
    listEl.innerHTML = '';

    filtered.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'media-card';

      const quality = item.quality || 'Media Stream';
      const format = item.format || 'MP4';
      const filename = item.filename || `${activeTab.title || 'video'}_${quality}.${format.toLowerCase()}`;
      const sizeText = item.size > 0 ? formatBytes(item.size) : '';

      // Quality badge style
      let badgeStyle = 'background: #06b6d4; color: #041017;';
      if (quality.includes('4K') || quality.includes('2160')) {
        badgeStyle = 'background: linear-gradient(135deg, #f59e0b, #d97706); color: #fff; font-weight: bold;';
      } else if (quality.includes('2K') || quality.includes('1440')) {
        badgeStyle = 'background: linear-gradient(135deg, #8b5cf6, #7c3aed); color: #fff; font-weight: bold;';
      } else if (quality.includes('1080')) {
        badgeStyle = 'background: #0284c7; color: #fff; font-weight: bold;';
      } else if (quality.includes('720')) {
        badgeStyle = 'background: #10b981; color: #fff;';
      } else if (quality.includes('MP3')) {
        badgeStyle = 'background: #ec4899; color: #fff; font-weight: bold;';
      } else if (quality.includes('WAV')) {
        badgeStyle = 'background: #f43f5e; color: #fff; font-weight: bold;';
      }

      card.innerHTML = `
        <div class="media-title" title="${filename}">${filename}</div>
        <div class="media-meta">
          <div class="tag-group">
            <span class="tag-quality" style="${badgeStyle}">${quality}</span>
            <span class="tag-format">${format}</span>
          </div>
          ${sizeText ? `<span class="tag-size">${sizeText}</span>` : ''}
        </div>
        <div class="save-to">📁 Downloads\\${filename}</div>
        <div class="action-group">
          <button class="btn-dl" title="Download via Pew">⚡ Download with Pew</button>
          <button class="btn-copy" title="Copy Link">Copy</button>
        </div>
      `;

      card.querySelector('.btn-dl').addEventListener('click', () => {
        if (!item.url || item.url.startsWith('blob:')) {
          alert('Cannot download browser-internal blob URL. Please refresh the page to resolve the stream.');
          return;
        }
        fetch('http://127.0.0.1:41738/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: item.url,
            audio_url: item.audio_url || undefined,
            filename: filename,
            referer: tabUrl,
            user_agent: navigator.userAgent,
            parts: 8
          })
        }).catch(() => {
          chrome.downloads.download({ url: item.url, filename, saveAs: true });
        });

        const btn = card.querySelector('.btn-dl');
        btn.textContent = '✓ Sent to Pew!';
        btn.style.background = '#10b981';
        btn.style.color = '#fff';
        setTimeout(() => {
          btn.textContent = '⚡ Download with Pew';
          btn.style.background = '#06b6d4';
          btn.style.color = '#041017';
        }, 2000);
      });

      card.querySelector('.btn-copy').addEventListener('click', () => {
        navigator.clipboard.writeText(item.url);
        const btn = card.querySelector('.btn-copy');
        btn.textContent = '✓';
        setTimeout(() => btn.textContent = 'Copy', 1500);
      });

      listEl.appendChild(card);
    });
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }
});
