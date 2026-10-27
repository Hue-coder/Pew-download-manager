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

  // Safe Extension Messaging (Always routes via background service worker to prevent PNA network dialogs)
  function safeSendMessage(msg, callback) {
    try {
      if (typeof chrome !== 'undefined' && chrome && chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) {
            return;
          }
          if (callback) callback(res);
        });
      }
    } catch (e) {
      // Ignore extension context invalidation
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

  // 1. Pinterest Specific Main Pin Video Extractor (never returns blob: or broken URLs)
  function extractPinterestPinMedia() {
    if (!window.location.hostname.includes('pinterest.')) return null;

    let hlsUrl = null;
    let mp4Url = null;
    let foundTitle = '';

    // 1. Parse __PWS_DATA__ script
    const pwsScript = document.getElementById('__PWS_DATA__');
    if (pwsScript && pwsScript.textContent) {
      try {
        const text = pwsScript.textContent;

        // Recursive search for video_list in JSON
        try {
          const data = JSON.parse(text);
          function searchVideoList(obj) {
            if (!obj || typeof obj !== 'object') return;
            if (obj.video_list && typeof obj.video_list === 'object') {
              const vl = obj.video_list;
              if (vl.V_HLSV4 && vl.V_HLSV4.url) hlsUrl = vl.V_HLSV4.url;
              if (vl.V_EXP720P && vl.V_EXP720P.url) mp4Url = vl.V_EXP720P.url;
              else if (vl.V_720P && vl.V_720P.url) mp4Url = vl.V_720P.url;
              else if (vl.V_480P && vl.V_480P.url) mp4Url = vl.V_480P.url;
              return;
            }
            for (const k in obj) {
              if (obj.hasOwnProperty(k)) {
                searchVideoList(obj[k]);
                if (hlsUrl && mp4Url) return;
              }
            }
          }
          searchVideoList(data);
        } catch (je) {
          const m3u8 = text.match(/https?:\/\/(?:v1|v)\.pinimg\.com\/videos\/[^\s"'<>]+\.m3u8[^\s"'<>]*/);
          if (m3u8) hlsUrl = m3u8[0];
          const expMp4 = text.match(/https?:\/\/(?:v1|v)\.pinimg\.com\/videos\/mc\/expMp4\/[^\s"'<>]+\.mp4[^\s"'<>]*/);
          if (expMp4) mp4Url = expMp4[0];
          else {
            const mp4 = text.match(/https?:\/\/(?:v1|v)\.pinimg\.com\/videos\/[^\s"'<>]+\.mp4[^\s"'<>]*/);
            if (mp4) mp4Url = mp4[0];
          }
        }
      } catch (e) {}
    }

    // 2. Check application/ld+json scripts
    if (!hlsUrl || !mp4Url) {
      document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
        try {
          const json = JSON.parse(s.textContent);
          if (json.contentUrl && json.contentUrl.includes('pinimg.com')) {
            if (json.contentUrl.includes('.m3u8') && !hlsUrl) hlsUrl = json.contentUrl;
            if (json.contentUrl.includes('.mp4') && !mp4Url) mp4Url = json.contentUrl;
          }
          if (json.name && !foundTitle) foundTitle = json.name;
        } catch (e) {}
      });
    }

    // 3. Check performance timing API for recently requested video streams
    if (!hlsUrl) {
      try {
        const resources = performance.getEntriesByType('resource');
        for (const r of resources) {
          if (r.name && r.name.includes('pinimg.com/videos') && r.name.includes('.m3u8')) {
            hlsUrl = r.name;
            break;
          }
        }
      } catch (e) {}
    }

    if (!hlsUrl && !mp4Url) return null;

    const rawTitle = (foundTitle || document.title || 'Pinterest_Video').replace(/[\/\\:*?"<>|#]/g, '_').trim();
    const cleanTitle = rawTitle.replace(/[\s\-_]+/g, '_').substring(0, 40) || 'Pinterest_Video';

    let items = [];

    // Option 1: Direct authentic MP4 (Fastest download, lightweight size ~5-15MB, built-in audio, zero merging needed)
    if (mp4Url) {
      items.push({
        id: 'pin_mp4_' + hashStr(mp4Url),
        url: mp4Url,
        filename: `${cleanTitle}_720p.mp4`,
        format: 'MP4',
        quality: '720p Direct MP4 (Light & Fast)',
        mediaType: 'video',
        size: 0,
        priority: 1
      });
    }

    // Option 2: Pinterest HD via HLS (Best quality + full audio stream)
    if (hlsUrl) {
      items.push({
        id: 'pin_hls_' + hashStr(hlsUrl),
        url: hlsUrl,
        filename: `${cleanTitle}_HD.mp4`,
        format: 'MP4 (Full Audio)',
        quality: 'Pinterest HD (HLS Stream)',
        mediaType: 'video',
        size: 0,
        priority: mp4Url ? 2 : 1
      });

      // Option 3: Extract audio track as MP3
      items.push({
        id: 'pin_aud_' + hashStr(hlsUrl),
        url: hlsUrl,
        filename: `${cleanTitle}_Audio.mp3`,
        format: 'MP3',
        quality: 'MP3 Audio (High Quality)',
        mediaType: 'audio',
        size: 0,
        priority: 3
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

      // Query formats via background service worker (prevents browser Private Network Access warnings)
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
        <span class="pew-icon">
          <svg viewBox="0 0 24 24" fill="none" style="width:14px;height:14px;">
            <circle cx="12" cy="12" r="10" stroke="url(#pillGrad)" stroke-width="2.2"/>
            <path d="M12 7V15M12 15L8.5 11.5M12 15L15.5 11.5M8 17H16" stroke="url(#pillGrad)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
            <defs>
              <linearGradient id="pillGrad" x1="4" y1="4" x2="20" y2="20" gradientUnits="userSpaceOnUse">
                <stop stop-color="#38bdf8"/>
                <stop offset="0.5" stop-color="#818cf8"/>
                <stop offset="1" stop-color="#c084fc"/>
              </linearGradient>
            </defs>
          </svg>
        </span>
        <span class="pew-label">Download</span>
        <span class="pew-badge">${mediaList.length}</span>
      </div>
      <div class="pew-dropdown" style="display: none;">
        <div class="pew-dropdown-header">
          <div class="pew-header-left">
            <svg viewBox="0 0 24 24" fill="none" style="width:16px;height:16px;">
              <circle cx="12" cy="12" r="10" stroke="url(#dropGrad)" stroke-width="2.2"/>
              <path d="M12 7V15M12 15L8.5 11.5M12 15L15.5 11.5M8 17H16" stroke="url(#dropGrad)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
              <defs>
                <linearGradient id="dropGrad" x1="4" y1="4" x2="20" y2="20" gradientUnits="userSpaceOnUse">
                  <stop stop-color="#38bdf8"/>
                  <stop offset="0.5" stop-color="#818cf8"/>
                  <stop offset="1" stop-color="#c084fc"/>
                </linearGradient>
              </defs>
            </svg>
            <span>Pew Grabber (${mediaList.length})</span>
          </div>
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
      openAppBtn.textContent = '⏳ Opening...';
      safeSendMessage({ action: 'SHOW_PEW_APP' }, () => {
        setTimeout(() => { openAppBtn.textContent = '🖥️ Open Pew App'; }, 1200);
      });
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
      let badgeStyle = 'background: #7c3aed; color: #fff; font-weight: 600;';
      if (quality.includes('4K') || quality.includes('2160')) {
        badgeStyle = 'background: linear-gradient(135deg, #f59e0b, #d97706); color: #fff; font-weight: bold;';
      } else if (quality.includes('2K') || quality.includes('1440')) {
        badgeStyle = 'background: linear-gradient(135deg, #8b5cf6, #7c3aed); color: #fff; font-weight: bold;';
      } else if (quality.includes('1080')) {
        badgeStyle = 'background: #3b82f6; color: #fff; font-weight: bold;';
      } else if (quality.includes('720')) {
        badgeStyle = 'background: #22c55e; color: #fff;';
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
          if (!item.url || item.url.startsWith('blob:')) {
            alert('Cannot download internal browser blob. Resolving live stream...');
            queryMedia();
            return;
          }

          const dlBtn = itemEl.querySelector('.pew-action-download');
          if (dlBtn) {
            dlBtn.textContent = '⏳ Starting Pew...';
            dlBtn.style.background = '#0284c7';
          }

          safeSendMessage({
            action: 'TRIGGER_PEW_DOWNLOAD',
            url: item.url,
            audio_url: item.audio_url || undefined,
            filename: cleanName
          }, (res) => {
            if (res && res.task_id) {
              if (dlBtn) {
                dlBtn.textContent = '✓ Sent to Pew';
                dlBtn.style.background = '#10b981';
                setTimeout(() => {
                  dlBtn.textContent = '⚡ Download';
                  dlBtn.style.background = '';
                }, 2500);
              }
              showInPageProgressModal(res.task_id, cleanName);
            } else {
              if (dlBtn) {
                dlBtn.textContent = '⚠️ Pew Offline';
                dlBtn.style.background = '#ef4444';
                setTimeout(() => {
                  dlBtn.textContent = '⚡ Download';
                  dlBtn.style.background = '';
                }, 3000);
              }
              alert('Pew Download Manager is not running. Please open Pew Download Manager from your Start Menu/Desktop.');
            }
          });
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

  // =========================================================================
  // Live In-Page Multi-Progress Modal Windows (Draggable, Minimizable, Multi-File)
  // =========================================================================
  const activeInPageModals = new Map(); // taskId -> { boxEl, pollInterval, currentTargetPath, isMinimized, expand }

  function makeProgressDraggable(container, handle, altHandle) {
    let isDragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    function onMouseDown(e) {
      if (e.target.closest('button') || e.target.closest('a') || e.target.closest('input')) return;

      isDragging = true;
      handle.classList.add('pew-is-dragging');
      startX = e.clientX;
      startY = e.clientY;

      const rect = container.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      container.style.bottom = 'auto';
      container.style.right = 'auto';
      container.style.left = `${startLeft}px`;
      container.style.top = `${startTop}px`;

      e.preventDefault();
    }

    handle.addEventListener('mousedown', onMouseDown);
    if (altHandle) altHandle.addEventListener('mousedown', onMouseDown);

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      const width = container.offsetWidth || 330;
      const height = container.offsetHeight || 160;
      const maxLeft = Math.max(10, window.innerWidth - width - 10);
      const maxTop = Math.max(10, window.innerHeight - height - 10);

      const newLeft = Math.max(10, Math.min(maxLeft, startLeft + dx));
      const newTop = Math.max(10, Math.min(maxTop, startTop + dy));

      container.style.left = `${newLeft}px`;
      container.style.top = `${newTop}px`;
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        handle.classList.remove('pew-is-dragging');
      }
    });
  }

  function showInPageProgressModal(taskId, filename) {
    // If modal already exists for this task, unminimize/bring to front
    if (activeInPageModals.has(taskId)) {
      const existing = activeInPageModals.get(taskId);
      if (existing && existing.expand) existing.expand();
      return;
    }

    const modalId = `pew-inpage-modal-${taskId}`;
    let progressBox = document.getElementById(modalId);
    if (!progressBox) {
      progressBox = document.createElement('div');
      progressBox.id = modalId;
      progressBox.className = 'pew-inpage-modal-wrap';
      document.body.appendChild(progressBox);
    }

    // Stagger position for multiple simultaneous download popups
    const modalIndex = activeInPageModals.size;
    const bottomOffset = 24 + (modalIndex % 4) * 175;
    const rightOffset = 24 + Math.floor(modalIndex / 4) * 345;

    progressBox.style.bottom = `${bottomOffset}px`;
    progressBox.style.right = `${rightOffset}px`;
    progressBox.style.left = 'auto';
    progressBox.style.top = 'auto';
    progressBox.style.zIndex = `${2147483640 + modalIndex}`;

    let currentTargetPath = null;
    let isMinimized = false;

    progressBox.innerHTML = `
      <div class="pew-inpage-card" id="card-${taskId}">
        <div class="pew-inpage-header" title="Drag to move">
          <div class="pew-inpage-title-row">
            <span class="pew-inpage-drag-handle" title="Drag to move">⋮⋮</span>
            <span class="pew-inpage-bolt">⚡</span>
            <span class="pew-inpage-title" title="${filename}">${filename}</span>
          </div>
          <div class="pew-inpage-window-actions">
            <span class="pew-inpage-mini-percent" id="mini-pct-${taskId}">0%</span>
            <button class="pew-inpage-btn-min" id="btn-min-${taskId}" title="Minimize">—</button>
            <button class="pew-inpage-close" id="btn-close-${taskId}" title="Close">&times;</button>
          </div>
        </div>
        <div class="pew-inpage-body" id="body-${taskId}">
          <div class="pew-inpage-bar-track">
            <div class="pew-inpage-bar-fill" id="bar-${taskId}" style="width: 0%;"></div>
          </div>
          <div class="pew-inpage-stats-row">
            <span class="pew-inpage-status" id="status-${taskId}">Connecting to Pew Engine...</span>
            <span class="pew-inpage-percent" id="pct-${taskId}">0%</span>
          </div>
          <div class="pew-inpage-substats">
            <span id="size-${taskId}">0 B</span>
            <span id="speed-${taskId}">0 KB/s</span>
          </div>
        </div>
        <div class="pew-inpage-footer" id="footer-${taskId}" style="display: none;">
          <button class="pew-inpage-btn pew-inpage-btn-primary" id="btn-open-file-${taskId}">▶ Open File</button>
          <button class="pew-inpage-btn pew-inpage-btn-secondary" id="btn-open-folder-${taskId}">📂 Open Folder</button>
          <button class="pew-inpage-btn pew-inpage-btn-secondary" id="btn-dismiss-${taskId}">✕ Close</button>
        </div>
      </div>
    `;

    progressBox.style.display = 'block';

    const cardEl = progressBox.querySelector(`#card-${taskId}`);
    const headerEl = progressBox.querySelector('.pew-inpage-header');
    const bodyEl = progressBox.querySelector(`#body-${taskId}`);
    makeProgressDraggable(progressBox, headerEl, bodyEl);

    const minBtn = progressBox.querySelector(`#btn-min-${taskId}`);
    const closeBtn = progressBox.querySelector(`#btn-close-${taskId}`);
    const dismissBtn = progressBox.querySelector(`#btn-dismiss-${taskId}`);
    const openFileBtn = progressBox.querySelector(`#btn-open-file-${taskId}`);
    const openFolderBtn = progressBox.querySelector(`#btn-open-folder-${taskId}`);

    const barEl = progressBox.querySelector(`#bar-${taskId}`);
    const statusEl = progressBox.querySelector(`#status-${taskId}`);
    const percentEl = progressBox.querySelector(`#pct-${taskId}`);
    const miniPctEl = progressBox.querySelector(`#mini-pct-${taskId}`);
    const sizeEl = progressBox.querySelector(`#size-${taskId}`);
    const speedEl = progressBox.querySelector(`#speed-${taskId}`);
    const footerEl = progressBox.querySelector(`#footer-${taskId}`);

    function toggleMinimize(e) {
      if (e) e.stopPropagation();
      isMinimized = !isMinimized;
      if (isMinimized) {
        cardEl.classList.add('pew-minimized');
        minBtn.textContent = '▢';
        minBtn.title = 'Expand';
      } else {
        cardEl.classList.remove('pew-minimized');
        minBtn.textContent = '—';
        minBtn.title = 'Minimize';
      }
    }

    minBtn.addEventListener('click', toggleMinimize);

    headerEl.addEventListener('click', (e) => {
      if (isMinimized && !e.target.closest('button')) {
        toggleMinimize();
      }
    });

    let pollInterval = null;

    function dismissThisModal() {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      progressBox.remove();
      activeInPageModals.delete(taskId);
    }

    closeBtn.addEventListener('click', dismissThisModal);
    dismissBtn.addEventListener('click', dismissThisModal);

    openFileBtn.addEventListener('click', () => {
      safeSendMessage({ action: 'OPEN_DOWNLOAD_FILE', path: currentTargetPath, taskId: taskId });
      openFileBtn.textContent = '✓ Opened';
      setTimeout(() => openFileBtn.textContent = '▶ Open File', 1500);
    });

    openFolderBtn.addEventListener('click', () => {
      safeSendMessage({ action: 'OPEN_DOWNLOAD_FOLDER', path: currentTargetPath, taskId: taskId });
      openFolderBtn.textContent = '📂 Open Folder';
      setTimeout(() => openFolderBtn.textContent = '📂 Open Folder', 1500);
    });

    pollInterval = setInterval(() => {
      safeSendMessage({ action: 'POLL_TASK_PROGRESS', taskId }, (res) => {
        if (!res || !res.success || !res.task) return;

        const task = res.task;
        if (task.target_path) currentTargetPath = task.target_path;

        const downloaded = task.downloaded_bytes || 0;
        const total = task.total_bytes || 0;
        const speed = task.speed_bps || 0;

        let pct = 0;
        if (total > 0) {
          pct = Math.min(100, Math.max(0, Math.round((downloaded / total) * 100)));
        }

        const isComplete = task.status === 'Completed';
        barEl.style.width = (isComplete ? 100 : pct) + '%';
        percentEl.textContent = (isComplete ? 100 : pct) + '%';
        miniPctEl.textContent = (isComplete ? '✓ Done' : (pct + '%'));
        statusEl.textContent = task.status || 'Downloading...';

        if (total > 0) {
          sizeEl.textContent = `${formatBytes(downloaded)} / ${formatBytes(total)}`;
        } else if (downloaded > 0) {
          sizeEl.textContent = formatBytes(downloaded);
        }

        speedEl.textContent = speed > 0 ? `${formatBytes(speed)}/s` : '';

        if (isComplete) {
          clearInterval(pollInterval);
          pollInterval = null;
          barEl.style.background = 'linear-gradient(135deg, #22c55e, #10b981)';
          barEl.style.boxShadow = '0 0 10px rgba(34, 197, 94, 0.7)';
          statusEl.textContent = '✓ Download Complete!';
          statusEl.style.color = '#22c55e';
          miniPctEl.style.color = '#22c55e';
          footerEl.style.display = 'flex';
        } else if (task.status === 'Error') {
          clearInterval(pollInterval);
          pollInterval = null;
          barEl.style.background = 'linear-gradient(135deg, #ef4444, #dc2626)';
          statusEl.textContent = `❌ ${task.error || 'Download failed'}`;
          statusEl.style.color = '#ef4444';
          miniPctEl.textContent = '❌ Err';
          miniPctEl.style.color = '#ef4444';
          footerEl.style.display = 'flex';
          openFileBtn.style.display = 'none';
          openFolderBtn.style.display = 'none';
        }
      });
    }, 450);

    activeInPageModals.set(taskId, {
      boxEl: progressBox,
      pollInterval,
      expand: () => {
        isMinimized = false;
        cardEl.classList.remove('pew-minimized');
        minBtn.textContent = '—';
        minBtn.title = 'Minimize';
      }
    });
  }
})();
