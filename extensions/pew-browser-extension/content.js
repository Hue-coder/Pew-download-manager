// Pew In-Page Video Grabber (Content Script)
(function() {
  let mediaList = [];
  let panelContainer = null;
  let dropdownMenu = null;

  // 1. Initial query to background
  chrome.runtime.sendMessage({ action: 'GET_TAB_MEDIA' }, (res) => {
    if (res && res.media && res.media.length > 0) {
      mediaList = res.media;
      renderOrUpdateFloatingPanel();
    }
  });

  // 2. Listen to updates from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'PEW_MEDIA_FOUND') {
      mediaList = message.allMedia || [];
      renderOrUpdateFloatingPanel();
    }
  });

  // 3. Directly inspect HTML5 <video> elements on the page
  function inspectVideos() {
    const videos = document.querySelectorAll('video');
    videos.forEach((video) => {
      const src = video.currentSrc || video.src;
      if (src && (src.startsWith('http://') || src.startsWith('https://'))) {
        const height = video.videoHeight;
        let quality = 'Video';
        if (height >= 1080) quality = '1080p Full HD';
        else if (height >= 720) quality = '720p HD';
        else if (height >= 480) quality = '480p';
        else if (height >= 360) quality = '360p';

        const item = {
          id: 'dom_' + hashStr(src),
          url: src,
          format: 'MP4',
          quality: quality,
          mediaType: 'combined',
          size: 0,
          priority: 1,
          timestamp: Date.now()
        };

        chrome.runtime.sendMessage({ action: 'MEDIA_FROM_DOM', item }, () => {});
      }
    });
  }

  // Monitor video play events
  document.addEventListener('play', (e) => {
    if (e.target && e.target.tagName === 'VIDEO') {
      setTimeout(inspectVideos, 500);
    }
  }, true);

  // Periodic poll for dynamic players
  setInterval(inspectVideos, 3000);

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
        <span class="pew-label">Download Video</span>
        <span class="pew-badge">${mediaList.length}</span>
      </div>
      <div class="pew-dropdown" style="display: none;">
        <div class="pew-dropdown-header">
          <span>⚡ Detected Media (${mediaList.length})</span>
          <button class="pew-open-app-btn" title="Open Desktop App">🖥️ Open App</button>
          <button class="pew-close-btn">&times;</button>
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
      chrome.runtime.sendMessage({ action: 'SHOW_PEW_APP' });
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

    mediaList.forEach((item) => {
      const itemEl = document.createElement('div');
      itemEl.className = 'pew-media-item';

      const quality = item.quality || 'Video';
      const format = item.format || 'MP4';
      const cleanName = getSuggestedFilename(item.url, quality, format);
      const isCombined = item.mediaType === 'combined';

      itemEl.innerHTML = `
        <div class="pew-item-info">
          <div class="pew-item-title" title="${cleanName}">${cleanName}</div>
          <div class="pew-item-meta">
            <span class="pew-format-tag" style="${isCombined ? 'background: #10b981; color: #fff;' : ''}">${quality}</span>
            <span class="pew-format-sub">${format}</span>
          </div>
          <div class="pew-save-location">📁 Downloads\\${cleanName}</div>
        </div>
        <div class="pew-item-actions">
          <button class="pew-action-download" title="Send to Pew Desktop App">⚡ Download</button>
          <button class="pew-action-copy" title="Copy Stream URL">📋</button>
        </div>
      `;

      itemEl.querySelector('.pew-action-download').addEventListener('click', () => {
        chrome.runtime.sendMessage({
          action: 'TRIGGER_PEW_DOWNLOAD',
          url: item.url,
          filename: cleanName
        });

        const dlBtn = itemEl.querySelector('.pew-action-download');
        dlBtn.textContent = '✓ Sent!';
        setTimeout(() => dlBtn.textContent = '⚡ Download', 2000);
      });

      itemEl.querySelector('.pew-action-copy').addEventListener('click', () => {
        navigator.clipboard.writeText(item.url);
        const copyBtn = itemEl.querySelector('.pew-action-copy');
        copyBtn.textContent = '✓';
        setTimeout(() => copyBtn.textContent = '📋', 1500);
      });

      listEl.appendChild(itemEl);
    });
  }

  function getSuggestedFilename(url, quality, format) {
    let title = document.title ? document.title.replace(/[\\/:*?"<>|]/g, '_').replace(/ - YouTube$/, '').trim() : '';
    title = title.substring(0, 45);

    const ext = format.toLowerCase().includes('audio') || format.toLowerCase().includes('m4a') || format.toLowerCase().includes('opus') ? 'm4a' : 'mp4';
    const tag = quality.split(' ')[0].replace(/[^a-zA-Z0-9]/g, '');

    if (title) {
      return `${title}_${tag}.${ext}`;
    }

    return `video_${tag}.${ext}`;
  }

  function hashStr(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h) + str.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h);
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
