// Pew Media Grabber - In-page Floating Downloader (Content Script)
(function() {
  let mediaList = [];
  let panelContainer = null;
  let dropdownMenu = null;

  // Listen for media detected from background service worker
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'PEW_MEDIA_FOUND') {
      mediaList = message.allMedia || [];
      renderOrUpdateFloatingPanel();
    }
  });

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
          <button class="pew-close-btn">&times;</button>
        </div>
        <div class="pew-dropdown-list"></div>
      </div>
    `;

    document.body.appendChild(panelContainer);

    const pillBtn = panelContainer.querySelector('.pew-pill-btn');
    dropdownMenu = panelContainer.querySelector('.pew-dropdown');
    const closeBtn = panelContainer.querySelector('.pew-close-btn');

    pillBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = dropdownMenu.style.display !== 'none';
      dropdownMenu.style.display = isVisible ? 'none' : 'block';
    });

    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdownMenu.style.display = 'none';
    });

    // Close on clicking outside
    document.addEventListener('click', (e) => {
      if (!panelContainer.contains(e.target)) {
        dropdownMenu.style.display = 'none';
      }
    });

    // Make floating pill draggable
    makeDraggable(panelContainer, pillBtn);
  }

  function renderDropdownItems() {
    if (!dropdownMenu) return;
    const listEl = dropdownMenu.querySelector('.pew-dropdown-list');
    listEl.innerHTML = '';

    mediaList.forEach((item, index) => {
      const itemEl = document.createElement('div');
      itemEl.className = 'pew-media-item';

      const sizeStr = item.size > 0 ? formatBytes(item.size) : 'Stream / Unknown';
      const cleanName = getSuggestedFilename(item.url);

      itemEl.innerHTML = `
        <div class="pew-item-info">
          <div class="pew-item-title" title="${cleanName}">${cleanName}</div>
          <div class="pew-item-meta">
            <span class="pew-format-tag">${item.format}</span>
            <span class="pew-size-tag">${sizeStr}</span>
          </div>
        </div>
        <div class="pew-item-actions">
          <button class="pew-action-download" title="Send to Pew Downloader">⚡ Download</button>
          <button class="pew-action-copy" title="Copy Link">📋</button>
        </div>
      `;

      // Download action
      itemEl.querySelector('.pew-action-download').addEventListener('click', () => {
        // Send to Pew app
        chrome.runtime.sendMessage({
          action: 'TRIGGER_PEW_DOWNLOAD',
          url: item.url,
          filename: cleanName
        });

        // Feedback
        const dlBtn = itemEl.querySelector('.pew-action-download');
        dlBtn.textContent = '✓ Sent!';
        setTimeout(() => dlBtn.textContent = '⚡ Download', 2000);
      });

      // Copy action
      itemEl.querySelector('.pew-action-copy').addEventListener('click', () => {
        navigator.clipboard.writeText(item.url);
        const copyBtn = itemEl.querySelector('.pew-action-copy');
        copyBtn.textContent = '✓';
        setTimeout(() => copyBtn.textContent = '📋', 1500);
      });

      listEl.appendChild(itemEl);
    });
  }

  function getSuggestedFilename(url) {
    const pageTitle = document.title ? document.title.replace(/[\\/:*?"<>|]/g, '_').substring(0, 40) : '';
    const cleanUrl = url.split('?')[0].split('#')[0];
    const rawName = cleanUrl.split('/').pop();
    if (rawName && rawName.includes('.')) {
      return pageTitle ? `${pageTitle}_${rawName}` : rawName;
    }
    return pageTitle ? `${pageTitle}.mp4` : 'video_download.mp4';
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
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
