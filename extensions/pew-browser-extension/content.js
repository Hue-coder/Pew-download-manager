// Pew In-Page Video Grabber (Content Script)
(function() {
  // Clean up any existing widget from previous reloads to prevent zombie widgets
  const oldWidget = document.getElementById('pew-floating-widget');
  if (oldWidget) oldWidget.remove();

  let mediaList = [];
  let panelContainer = null;
  let dropdownMenu = null;
  let activeTabFilter = 'all'; // 'all', 'video', 'audio'

  // Safe Extension Messaging (immune to "Extension context invalidated")
  function safeSendMessage(msg, callback) {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) {
            // Context was invalidated during flight
            if (msg.action === 'TRIGGER_PEW_DOWNLOAD') {
              directHttpDownload(msg.url, msg.filename);
            }
            return;
          }
          if (callback) callback(res);
        });
      } else {
        if (msg.action === 'TRIGGER_PEW_DOWNLOAD') {
          directHttpDownload(msg.url, msg.filename);
        }
      }
    } catch (e) {
      if (msg.action === 'TRIGGER_PEW_DOWNLOAD') {
        directHttpDownload(msg.url, msg.filename);
      }
    }
  }

  function directHttpDownload(url, filename) {
    fetch('http://127.0.0.1:41738/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: url,
        filename: filename,
        referer: window.location.href,
        user_agent: navigator.userAgent,
        parts: 8
      })
    }).catch(err => {
      console.warn('Direct Pew download failed:', err);
    });
  }

  // 1. Resolve media via local Pew resolver or background
  async function queryMedia() {
    const pageUrl = window.location.href;
    if (!pageUrl.startsWith('http')) return;

    // Direct local resolve
    try {
      const resp = await fetch(`http://127.0.0.1:41738/resolve?url=${encodeURIComponent(pageUrl)}`, {
        signal: AbortSignal.timeout(5000)
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data && data.success && Array.isArray(data.formats) && data.formats.length > 0) {
          mediaList = data.formats.map(f => ({
            id: f.id,
            url: f.url,
            filename: f.filename,
            format: f.format,
            quality: f.quality,
            mediaType: f.media_type,
            size: f.size,
          }));
          renderOrUpdateFloatingPanel();
          return;
        }
      }
    } catch (e) {}

    // Fallback to background query
    safeSendMessage({ action: 'GET_TAB_MEDIA' }, (res) => {
      if (res && res.media && res.media.length > 0) {
        mediaList = res.media;
        renderOrUpdateFloatingPanel();
      } else {
        safeSendMessage({ action: 'REQUEST_RESOLVE', url: pageUrl, title: document.title }, (r2) => {
          if (r2 && r2.media && r2.media.length > 0) {
            mediaList = r2.media;
            renderOrUpdateFloatingPanel();
          }
        });
      }
    });
  }

  // Initial query and navigation handlers
  queryMedia();
  window.addEventListener('yt-navigate-finish', () => setTimeout(queryMedia, 600));
  window.addEventListener('popstate', () => setTimeout(queryMedia, 600));

  // Listen to background broadcast
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((message) => {
        if (message.action === 'PEW_MEDIA_FOUND') {
          mediaList = message.allMedia || [];
          renderOrUpdateFloatingPanel();
        }
      });
    }
  } catch (e) {}

  function renderOrUpdateFloatingPanel() {
    if (mediaList.length === 0) return;

    if (!panelContainer) {
      createFloatingPanel();
    }

    const badge = panelContainer.querySelector('.pew-badge');
    if (badge) badge.textContent = mediaList.length;

    renderDropdownItems();
  }

  function createFloatingPanel() {
    if (document.getElementById('pew-floating-widget')) {
      panelContainer = document.getElementById('pew-floating-widget');
      return;
    }

    panelContainer = document.createElement('div');
    panelContainer.id = 'pew-floating-widget';
    panelContainer.innerHTML = `
      <div class="pew-pill-btn">
        <span class="pew-icon">⚡</span>
        <span class="pew-label">Download Media</span>
        <span class="pew-badge">${mediaList.length}</span>
      </div>
      <div class="pew-dropdown" style="display: none;">
        <div class="pew-dropdown-header">
          <span>⚡ Pew Media Grabber (${mediaList.length})</span>
          <button class="pew-open-app-btn" title="Open Desktop App">🖥️ Open Pew</button>
          <button class="pew-close-btn">&times;</button>
        </div>
        <div class="pew-filter-tabs">
          <button class="pew-tab-btn active" data-tab="all">All (${mediaList.length})</button>
          <button class="pew-tab-btn" data-tab="video">🎬 Video (4K/2K/1080p)</button>
          <button class="pew-tab-btn" data-tab="audio">🎵 Audio (MP3/WAV)</button>
        </div>
        <div class="pew-dropdown-list"></div>
      </div>
    `;

    document.body.appendChild(panelContainer);

    const pillBtn = panelContainer.querySelector('.pew-pill-btn');
    dropdownMenu = panelContainer.querySelector('.pew-dropdown');
    const closeBtn = panelContainer.querySelector('.pew-close-btn');
    const openAppBtn = panelContainer.querySelector('.pew-open-app-btn');

    pillBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = dropdownMenu.style.display !== 'none';
      dropdownMenu.style.display = isVisible ? 'none' : 'block';
    });

    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdownMenu.style.display = 'none';
    });

    openAppBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      safeSendMessage({ action: 'SHOW_PEW_APP' });
    });

    // Tab buttons
    panelContainer.querySelectorAll('.pew-tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        panelContainer.querySelectorAll('.pew-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeTabFilter = btn.dataset.tab;
        renderDropdownItems();
      });
    });

    document.addEventListener('click', (e) => {
      if (!panelContainer.contains(e.target)) {
        dropdownMenu.style.display = 'none';
      }
    });

    makeDraggable(panelContainer, pillBtn);
  }

  function renderDropdownItems() {
    if (!dropdownMenu) return;
    const listEl = dropdownMenu.querySelector('.pew-dropdown-list');
    listEl.innerHTML = '';

    const filtered = mediaList.filter(item => {
      if (activeTabFilter === 'video') return item.mediaType === 'video';
      if (activeTabFilter === 'audio') return item.mediaType === 'audio';
      return true;
    });

    if (filtered.length === 0) {
      listEl.innerHTML = '<div style="padding: 1.5rem; text-align: center; color: #94a3b8; font-size: 0.85rem;">No formats available for this tab</div>';
      return;
    }

    filtered.forEach((item) => {
      const itemEl = document.createElement('div');
      itemEl.className = 'pew-media-item';

      const quality = item.quality || 'Media Stream';
      const format = item.format || 'MP4';
      const cleanName = item.filename || `${document.title || 'video'}_${format.toLowerCase()}.${format.toLowerCase()}`;
      const sizeText = item.size > 0 ? formatBytes(item.size) : '';

      // Distinct badge color
      let badgeStyle = 'background: #06b6d4; color: #fff;';
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

      itemEl.innerHTML = `
        <div class="pew-item-info">
          <div class="pew-item-title" title="${cleanName}">${cleanName}</div>
          <div class="pew-item-meta">
            <span class="pew-format-tag" style="${badgeStyle}">${quality}</span>
            <span class="pew-format-sub">${format}</span>
            ${sizeText ? `<span class="pew-format-size" style="color: #38bdf8; font-size: 0.75rem; font-family: monospace; font-weight: 600;">${sizeText}</span>` : ''}
          </div>
          <div class="pew-save-location">📁 Downloads\\${cleanName}</div>
        </div>
        <div class="pew-item-actions">
          <button class="pew-action-download" title="Send to Pew Desktop App">⚡ Download</button>
          <button class="pew-action-copy" title="Copy Stream URL">📋</button>
        </div>
      `;

      itemEl.querySelector('.pew-action-download').addEventListener('click', (e) => {
        e.stopPropagation();
        safeSendMessage({
          action: 'TRIGGER_PEW_DOWNLOAD',
          url: item.url,
          filename: cleanName
        });

        const dlBtn = itemEl.querySelector('.pew-action-download');
        dlBtn.textContent = '✓ Sent!';
        dlBtn.style.background = '#10b981';
        setTimeout(() => {
          dlBtn.textContent = '⚡ Download';
          dlBtn.style.background = '';
        }, 2000);
      });

      itemEl.querySelector('.pew-action-copy').addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(item.url);
        const copyBtn = itemEl.querySelector('.pew-action-copy');
        copyBtn.textContent = '✓';
        setTimeout(() => copyBtn.textContent = '📋', 1500);
      });

      listEl.appendChild(itemEl);
    });
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function makeDraggable(container, handle) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    handle.onmousedown = dragMouseDown;

    function dragMouseDown(e) {
      e = e || window.event;
      if (e.target.closest('.pew-dropdown')) return;
      pos3 = e.clientX;
      pos4 = e.clientY;
      document.onmouseup = closeDragElement;
      document.onmousemove = elementDrag;
    }

    function elementDrag(e) {
      e = e || window.event;
      pos1 = pos3 - e.clientX;
      pos2 = pos4 - e.clientY;
      pos3 = e.clientX;
      pos4 = e.clientY;
      container.style.top = (container.offsetTop - pos2) + "px";
      container.style.left = (container.offsetLeft - pos1) + "px";
      container.style.right = 'auto';
    }

    function closeDragElement() {
      document.onmouseup = null;
      document.onmousemove = null;
    }
  }
})();
