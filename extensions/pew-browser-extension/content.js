// Pew In-Page Video Grabber (Content Script)
(function() {
  // Suppress harmless context-invalidated messages when extension is reloaded
  window.addEventListener('error', (e) => {
    if (e.message && e.message.includes('Extension context invalidated')) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }, true);

  // Clean up any existing widget from previous reloads
  try {
    const oldWidget = document.getElementById('pew-floating-widget');
    if (oldWidget) oldWidget.remove();
  } catch (e) {}

  let mediaList = [];
  let panelContainer = null;
  let dropdownMenu = null;
  let activeTabFilter = 'all'; // 'all', 'video', 'audio'
  let isCustomPositioned = false;

  // Safe Extension Messaging
  function safeSendMessage(msg, callback) {
    try {
      if (typeof chrome !== 'undefined' && chrome && chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) {
            if (msg.action === 'TRIGGER_PEW_DOWNLOAD') {
              directHttpDownload(msg.url, msg.audio_url, msg.filename);
            }
            return;
          }
          if (callback) callback(res);
        });
      } else {
        if (msg.action === 'TRIGGER_PEW_DOWNLOAD') {
          directHttpDownload(msg.url, msg.audio_url, msg.filename);
        }
      }
    } catch (e) {
      if (msg.action === 'TRIGGER_PEW_DOWNLOAD') {
        directHttpDownload(msg.url, msg.audio_url, msg.filename);
      }
    }
  }

  function directHttpDownload(url, audio_url, filename) {
    fetch('http://127.0.0.1:41738/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: url,
        audio_url: audio_url || undefined,
        filename: filename,
        referer: window.location.href,
        user_agent: navigator.userAgent,
        parts: 8
      })
    }).catch(() => {});
  }

  // 1. Pinterest Specific Main Pin Video Extractor
  function extractPinterestPinMedia() {
    if (!window.location.hostname.includes('pinterest.')) return null;

    // Look for video element in the primary Pin view
    const mainContainer = document.querySelector('[data-test-id="visual-content-container"]') 
                       || document.querySelector('[data-test-id="pin-closeup-image"]')
                       || document.querySelector('div[role="main"]');

    const videoEl = (mainContainer && mainContainer.querySelector('video')) || document.querySelector('video');
    if (!videoEl) return null;

    let src = videoEl.currentSrc || videoEl.src || '';
    if (!src && videoEl.querySelector('source')) {
      src = videoEl.querySelector('source').src || '';
    }

    if (!src) return null;

    const rawTitle = (document.title || 'Pinterest_Video').replace(/[\/\\:*?"<>|]/g, '_').trim();
    const cleanTitle = rawTitle.replace(/[\s\-_]+/g, '_').substring(0, 40);

    let items = [];

    // If it's a direct MP4, derive the corresponding HLS master playlist which has sound!
    // Example: https://v.pinimg.com/videos/mc/720p/3c/62/7f/3c627f10b7713f01905a5dc27725964d.mp4
    // Master HLS: https://v.pinimg.com/videos/hls/3c/62/7f/3c627f10b7713f01905a5dc27725964d.m3u8
    if (src.includes('/videos/mc/')) {
      const hlsUrl = src.replace(/\/videos\/mc\/[^\/]+\//, '/videos/hls/').replace(/\.mp4(\?.*)?$/, '.m3u8$1');
      items.push({
        id: 'pin_hls_audio',
        url: hlsUrl,
        filename: `${cleanTitle}_HD.mp4`,
        format: 'MP4 (Full Audio)',
        quality: '720p HD (with Sound)',
        mediaType: 'video',
        size: 0,
        priority: 1
      });
      items.push({
        id: 'pin_mp4_direct',
        url: src,
        filename: `${cleanTitle}_Direct.mp4`,
        format: 'MP4',
        quality: 'Direct Stream',
        mediaType: 'video',
        size: 0,
        priority: 2
      });
    } else if (src.includes('.m3u8')) {
      items.push({
        id: 'pin_hls_audio',
        url: src,
        filename: `${cleanTitle}_HD.mp4`,
        format: 'MP4 (Full Audio)',
        quality: 'HD Video (with Sound)',
        mediaType: 'video',
        size: 0,
        priority: 1
      });
    } else {
      items.push({
        id: 'pin_direct',
        url: src,
        filename: `${cleanTitle}.mp4`,
        format: 'MP4',
        quality: 'Video Stream',
        mediaType: 'video',
        size: 0,
        priority: 1
      });
    }

    return items;
  }

  // 2. Resolve media via local Pew resolver or background
  async function queryMedia() {
    try {
      const pageUrl = window.location.href;
      if (!pageUrl.startsWith('http')) return;

      // Check Pinterest direct Pin video first
      const pinMedia = extractPinterestPinMedia();
      if (pinMedia && pinMedia.length > 0) {
        mediaList = pinMedia;
        renderOrUpdateFloatingPanel();
        return;
      }

      // Direct local resolver for YouTube, Vimeo, social platforms
      try {
        const resp = await fetch(`http://127.0.0.1:41738/resolve?url=${encodeURIComponent(pageUrl)}`, {
          signal: AbortSignal.timeout(6000)
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data && data.success && Array.isArray(data.formats) && data.formats.length > 0) {
            mediaList = data.formats.map(f => ({
              id: f.id,
              url: f.url,
              audio_url: f.audio_url || undefined,
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

      // Fallback to background store
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
    } catch (e) {}
  }

  // Initial query and navigation handlers
  queryMedia();
  window.addEventListener('yt-navigate-finish', () => setTimeout(queryMedia, 600));
  window.addEventListener('popstate', () => setTimeout(queryMedia, 600));

  // Listen to background broadcast
  try {
    if (typeof chrome !== 'undefined' && chrome && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((message) => {
        if (message.action === 'PEW_MEDIA_FOUND') {
          // If on Pinterest, ensure we only show the current Pin video
          if (window.location.hostname.includes('pinterest.')) {
            const pinMedia = extractPinterestPinMedia();
            if (pinMedia && pinMedia.length > 0) {
              mediaList = pinMedia;
            } else {
              mediaList = message.allMedia || [];
            }
          } else {
            mediaList = message.allMedia || [];
          }
          renderOrUpdateFloatingPanel();
        }
      });
    }
  } catch (e) {}

  // Find the active video player element on the screen
  function findTargetVideo() {
    // 1. YouTube main player
    const ytPlayer = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
    if (ytPlayer) {
      const v = ytPlayer.querySelector('video');
      if (v) return { video: v, container: ytPlayer };
    }

    // 2. Pinterest main pin video container
    if (window.location.hostname.includes('pinterest.')) {
      const pinContainer = document.querySelector('[data-test-id="visual-content-container"]') 
                        || document.querySelector('[data-test-id="pin-closeup-image"]')
                        || document.querySelector('div[role="main"]');
      if (pinContainer) {
        const v = pinContainer.querySelector('video');
        if (v) return { video: v, container: pinContainer };
      }
    }

    // 3. Actively playing video
    const allVideos = Array.from(document.querySelectorAll('video'));
    const playing = allVideos.find(v => !v.paused && !v.ended && v.readyState > 1 && v.clientWidth > 160);
    if (playing) {
      return { video: playing, container: playing.parentElement || playing };
    }

    // 4. Largest visible video on screen
    let largest = null;
    let maxArea = 0;
    for (const v of allVideos) {
      const rect = v.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > maxArea && rect.width > 180 && rect.height > 90 && rect.top < window.innerHeight && rect.bottom > 0) {
        maxArea = area;
        largest = v;
      }
    }
    if (largest) {
      return { video: largest, container: largest.parentElement || largest };
    }

    return null;
  }

  // Dynamically position the sleek download button at the top-right corner of the video player
  function updateWidgetPosition() {
    if (!panelContainer || isCustomPositioned) return;

    if (mediaList.length === 0) {
      panelContainer.style.display = 'none';
      return;
    }

    const target = findTargetVideo();
    if (target) {
      const box = (target.container || target.video);
      const rect = box.getBoundingClientRect();

      // Check if video is visible on screen
      if (rect.width > 180 && rect.height > 80 && rect.bottom > 40 && rect.top < window.innerHeight) {
        const top = Math.max(10, rect.top + 12);
        const right = Math.max(10, window.innerWidth - rect.right + 12);
        panelContainer.style.position = 'fixed';
        panelContainer.style.top = `${top}px`;
        panelContainer.style.right = `${right}px`;
        panelContainer.style.left = 'auto';
        panelContainer.style.bottom = 'auto';
        panelContainer.style.display = 'block';
        return;
      }
    }

    // Fallback if video is scrolled off: stay docked at viewport top-right
    panelContainer.style.position = 'fixed';
    panelContainer.style.top = '16px';
    panelContainer.style.right = '16px';
    panelContainer.style.display = 'block';
  }

  // Periodic and event-driven position updates
  window.addEventListener('scroll', updateWidgetPosition, { passive: true });
  window.addEventListener('resize', updateWidgetPosition, { passive: true });
  document.addEventListener('fullscreenchange', updateWidgetPosition);
  setInterval(updateWidgetPosition, 1200);

  // When videos start playing or hover, update immediately
  document.addEventListener('play', () => {
    setTimeout(() => {
      queryMedia();
      updateWidgetPosition();
    }, 300);
  }, true);

  function renderOrUpdateFloatingPanel() {
    try {
      if (mediaList.length === 0) return;

      if (!panelContainer) {
        createFloatingPanel();
      }

      const badge = panelContainer ? panelContainer.querySelector('.pew-badge') : null;
      if (badge) {
        // Show highest quality badge (e.g. 4K, 1080p, or count)
        const has4k = mediaList.some(m => (m.quality || '').includes('4K'));
        const has1080 = mediaList.some(m => (m.quality || '').includes('1080'));
        const has720 = mediaList.some(m => (m.quality || '').includes('720'));
        if (has4k) {
          badge.textContent = '4K';
        } else if (has1080) {
          badge.textContent = '1080p';
        } else if (has720) {
          badge.textContent = '720p';
        } else {
          badge.textContent = String(mediaList.length);
        }
      }

      renderDropdownItems();
      updateWidgetPosition();
    } catch (e) {}
  }

  function createFloatingPanel() {
    if (document.getElementById('pew-floating-widget')) {
      panelContainer = document.getElementById('pew-floating-widget');
      return;
    }

    panelContainer = document.createElement('div');
    panelContainer.id = 'pew-floating-widget';
    panelContainer.innerHTML = `
      <div class="pew-pill-btn" title="Download video with Pew">
        <span class="pew-icon">⚡</span>
        <span class="pew-label">Download</span>
        <span class="pew-badge">${mediaList.length}</span>
      </div>
      <div class="pew-dropdown" style="display: none;">
        <div class="pew-dropdown-header">
          <span>⚡ Pew Grabber (${mediaList.length})</span>
          <div style="display:flex; gap:6px; align-items:center;">
            <button class="pew-open-app-btn" title="Open Desktop App">🖥️ Pew App</button>
            <button class="pew-close-btn">&times;</button>
          </div>
        </div>
        <div class="pew-filter-tabs">
          <button class="pew-tab-btn active" data-tab="all">All (${mediaList.length})</button>
          <button class="pew-tab-btn" data-tab="video">🎬 Video</button>
          <button class="pew-tab-btn" data-tab="audio">🎵 Audio</button>
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
      dropdownMenu.style.display = isVisible ? 'none' : 'flex';
      if (!isVisible) {
        queryMedia();
      }
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
        try {
          e.stopPropagation();
          panelContainer.querySelectorAll('.pew-tab-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          activeTabFilter = btn.dataset.tab;
          renderDropdownItems();
        } catch (err) {}
      });
    });

    document.addEventListener('click', (e) => {
      try {
        if (panelContainer && !panelContainer.contains(e.target)) {
          dropdownMenu.style.display = 'none';
        }
      } catch (err) {}
    });

    makeDraggable(panelContainer, pillBtn);
    updateWidgetPosition();
  }

  function renderDropdownItems() {
    if (!dropdownMenu) return;
    const listEl = dropdownMenu.querySelector('.pew-dropdown-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    const filtered = mediaList.filter(item => {
      if (activeTabFilter === 'video') return item.mediaType === 'video';
      if (activeTabFilter === 'audio') return item.mediaType === 'audio';
      return true;
    });

    if (filtered.length === 0) {
      listEl.innerHTML = '<div style="padding: 1.25rem; text-align: center; color: #94a3b8; font-size: 0.8rem;">No formats available for this tab</div>';
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

      itemEl.innerHTML = `
        <div class="pew-item-info">
          <div class="pew-item-title" title="${cleanName}">${cleanName}</div>
          <div class="pew-item-meta">
            <span class="pew-format-tag" style="${badgeStyle}">${quality}</span>
            <span class="pew-format-sub">${format}</span>
            ${sizeText ? `<span class="pew-format-size" style="color: #38bdf8; font-size: 0.72rem; font-family: monospace; font-weight: 600;">${sizeText}</span>` : ''}
          </div>
          <div class="pew-save-location">📁 Downloads\\${cleanName}</div>
        </div>
        <div class="pew-item-actions">
          <button class="pew-action-download" title="Send to Pew Desktop App">⚡ Download</button>
          <button class="pew-action-copy" title="Copy Stream URL">📋</button>
        </div>
      `;

      itemEl.querySelector('.pew-action-download').addEventListener('click', (e) => {
        try {
          e.stopPropagation();
          safeSendMessage({
            action: 'TRIGGER_PEW_DOWNLOAD',
            url: item.url,
            audio_url: item.audio_url || undefined,
            filename: cleanName
          });

          const dlBtn = itemEl.querySelector('.pew-action-download');
          if (dlBtn) {
            dlBtn.textContent = '✓ Sent!';
            dlBtn.style.background = '#10b981';
            setTimeout(() => {
              dlBtn.textContent = '⚡ Download';
              dlBtn.style.background = '';
            }, 2000);
          }
        } catch (err) {}
      });

      itemEl.querySelector('.pew-action-copy').addEventListener('click', (e) => {
        try {
          e.stopPropagation();
          navigator.clipboard.writeText(item.url);
          const copyBtn = itemEl.querySelector('.pew-action-copy');
          if (copyBtn) {
            copyBtn.textContent = '✓';
            setTimeout(() => copyBtn.textContent = '📋', 1500);
          }
        } catch (err) {}
      });

      listEl.appendChild(itemEl);
    });
  }

  function makeDraggable(container, handle) {
    let isDragging = false;
    let startX, startY, startLeft, startTop;

    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('.pew-badge') || e.target.closest('.pew-close-btn')) return;
      isDragging = true;
      isCustomPositioned = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = container.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      container.style.right = 'auto';
      container.style.bottom = 'auto';
      container.style.left = `${startLeft}px`;
      container.style.top = `${startTop}px`;

      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      container.style.left = `${Math.max(10, Math.min(window.innerWidth - container.offsetWidth - 10, startLeft + dx))}px`;
      container.style.top = `${Math.max(10, Math.min(window.innerHeight - container.offsetHeight - 10, startTop + dy))}px`;
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }
})();
