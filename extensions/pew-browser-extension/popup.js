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

  // Intercept Toggle
  const interceptToggle = document.getElementById('toggle-intercept');
  if (interceptToggle) {
    chrome.storage.local.get({ auto_intercept: false }, (res) => {
      interceptToggle.checked = !!res.auto_intercept;
    });
    interceptToggle.addEventListener('change', (e) => {
      chrome.storage.local.set({ auto_intercept: e.target.checked });
    });
  }

  // Open Pew App button (Wakes up running app or launches via custom protocol)
  openGuiBtn.addEventListener('click', () => {
    openGuiBtn.innerHTML = '<span>⏳ Opening Pew...</span>';
    chrome.runtime.sendMessage({ action: 'SHOW_PEW_APP' }, () => {
      openGuiBtn.innerHTML = '<span>✓ Pew Opened</span>';
      setTimeout(() => window.close(), 500);
    });
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

  // 1. Instant check: Display existing background cached media immediately (0ms)
  if (activeTab.id) {
    chrome.runtime.sendMessage({ action: 'GET_TAB_MEDIA', tabId: activeTab.id }, (response) => {
      const media = (response && response.media) || [];
      if (media.length > 0) {
        currentMedia = media;
        renderMediaCards();
      } else {
        // 2. Not cached yet: Request background resolve with feedback
        chrome.runtime.sendMessage({ action: 'REQUEST_RESOLVE', url: tabUrl, title: activeTab.title }, (r2) => {
          const m2 = (r2 && r2.media) || [];
          if (m2.length > 0) {
            currentMedia = m2;
            renderMediaCards();
          } else {
            emptyEl.style.display = 'flex';
            listEl.style.display = 'none';
          }
        });
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

        const btn = card.querySelector('.btn-dl');
        if (btn) {
          btn.textContent = '⏳ Starting Pew...';
          btn.style.background = '#0284c7';
        }

        chrome.runtime.sendMessage({
          action: 'TRIGGER_PEW_DOWNLOAD',
          url: item.url,
          audio_url: item.audio_url || undefined,
          filename: filename
        }, (res) => {
          if (res && res.task_id) {
            if (btn) {
              btn.textContent = '✓ Sent to Pew';
              btn.style.background = '#10b981';
              setTimeout(() => {
                btn.textContent = '⚡ Download with Pew';
                btn.style.background = '';
              }, 2500);
            }
            startProgressModal(res.task_id, filename);
          } else {
            if (btn) {
              btn.textContent = '⚠️ Pew Offline';
              btn.style.background = '#ef4444';
              setTimeout(() => {
                btn.textContent = '⚡ Download with Pew';
                btn.style.background = '';
              }, 3000);
            }
            statusBadge.className = 'app-status status-offline';
            statusText.textContent = 'Pew Offline';
          }
        });
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

  // =========================================================================
  // Live Download Progress Popup Window Logic
  // =========================================================================
  const modalProgress = document.getElementById('dl-progress-modal');
  const popFilename = document.getElementById('pop-item-filename');
  const popBar = document.getElementById('pop-progress-bar');
  const popStatus = document.getElementById('pop-status-text');
  const popPercent = document.getElementById('pop-percent-text');
  const popSize = document.getElementById('pop-size-text');
  const popSpeed = document.getElementById('pop-speed-text');
  const popFooter = document.getElementById('pop-modal-footer');
  const btnCloseModal = document.getElementById('pop-btn-close-modal');
  const btnCloseFooter = document.getElementById('pop-btn-close-footer');
  const btnOpenFile = document.getElementById('pop-btn-open-file');
  const btnOpenFolder = document.getElementById('pop-btn-open-folder');

  let activePollInterval = null;
  let activeTargetPath = null;
  let activeTaskId = null;

  function closeProgressModal() {
    if (activePollInterval) {
      clearInterval(activePollInterval);
      activePollInterval = null;
    }
    modalProgress.classList.remove('active');
  }

  if (btnCloseModal) btnCloseModal.addEventListener('click', closeProgressModal);
  if (btnCloseFooter) btnCloseFooter.addEventListener('click', closeProgressModal);

  if (btnOpenFile) {
    btnOpenFile.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'OPEN_DOWNLOAD_FILE', path: activeTargetPath, taskId: activeTaskId });
      btnOpenFile.textContent = '✓ Opened';
      setTimeout(() => btnOpenFile.textContent = '▶ Open File', 1500);
    });
  }

  if (btnOpenFolder) {
    btnOpenFolder.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'OPEN_DOWNLOAD_FOLDER', path: activeTargetPath, taskId: activeTaskId });
      btnOpenFolder.textContent = '✓ Opened';
      setTimeout(() => btnOpenFolder.textContent = '📂 Open Folder', 1500);
    });
  }

  function startProgressModal(taskId, filename) {
    if (activePollInterval) {
      clearInterval(activePollInterval);
      activePollInterval = null;
    }

    activeTaskId = taskId;
    activeTargetPath = null;
    popFilename.textContent = filename;
    popFilename.title = filename;
    popBar.className = 'dl-progress-fill';
    popBar.style.width = '0%';
    popStatus.textContent = 'Connecting to Pew Engine...';
    popStatus.style.color = 'var(--text-secondary)';
    popPercent.textContent = '0%';
    popSize.textContent = '0 B';
    popSpeed.textContent = '0 KB/s';
    popFooter.style.display = 'none';

    modalProgress.classList.add('active');

    activePollInterval = setInterval(() => {
      chrome.runtime.sendMessage({ action: 'POLL_TASK_PROGRESS', taskId }, (res) => {
        if (!res || !res.success || !res.task) return;

        const task = res.task;
        if (task.target_path) {
          activeTargetPath = task.target_path;
        }

        const downloaded = task.downloaded_bytes || 0;
        const total = task.total_bytes || 0;
        const speed = task.speed_bps || 0;

        let pct = 0;
        if (total > 0) {
          pct = Math.min(100, Math.max(0, Math.round((downloaded / total) * 100)));
        }

        popBar.style.width = (task.status === 'Completed' ? 100 : pct) + '%';
        popPercent.textContent = (task.status === 'Completed' ? 100 : pct) + '%';
        popStatus.textContent = task.status || 'Downloading...';

        if (total > 0) {
          popSize.textContent = `${formatBytes(downloaded)} / ${formatBytes(total)}`;
        } else if (downloaded > 0) {
          popSize.textContent = formatBytes(downloaded);
        }

        popSpeed.textContent = speed > 0 ? `${formatBytes(speed)}/s` : (task.status === 'Completed' ? 'Complete' : '');

        if (task.status === 'Completed') {
          clearInterval(activePollInterval);
          activePollInterval = null;
          popBar.classList.add('completed');
          popStatus.textContent = '✓ Download Finished Successfully';
          popStatus.style.color = '#22c55e';
          popFooter.style.display = 'flex';
        } else if (task.status === 'Error') {
          clearInterval(activePollInterval);
          activePollInterval = null;
          popBar.classList.add('error');
          popStatus.textContent = `❌ ${task.error || 'Download failed'}`;
          popStatus.style.color = '#ef4444';
          popFooter.style.display = 'flex';
          btnOpenFile.style.display = 'none';
          btnOpenFolder.style.display = 'none';
        }
      });
    }, 350);
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }
});
