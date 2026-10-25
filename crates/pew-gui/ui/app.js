// Pew Download Manager Frontend Logic
const tauri = window.__TAURI__;
const invoke = tauri ? (tauri.core ? tauri.core.invoke : tauri.invoke) : null;
const listen = tauri ? (tauri.event ? tauri.event.listen : null) : null;

// Application State
const state = {
  downloads: new Map(),
  activeFilter: 'all',
  searchQuery: '',
};

// DOM Elements
const bodyEl = document.getElementById('downloads-body');
const emptyStateEl = document.getElementById('empty-state');
const addModal = document.getElementById('add-modal');
const modalUrlInput = document.getElementById('modal-url');
const modalFilenameInput = document.getElementById('modal-filename');
const modalPartsSlider = document.getElementById('modal-parts');
const partsValLabel = document.getElementById('parts-val');
const probeLoading = document.getElementById('probe-loading');
const probeInfo = document.getElementById('probe-info');
const probeSize = document.getElementById('probe-size');
const probeRanges = document.getElementById('probe-ranges');
const globalSpeedEl = document.getElementById('global-speed');
const activeTasksLabel = document.getElementById('active-tasks-label');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  setupTauriListeners();
  loadInitialDownloads();

  // Periodic polling fallback in case IPC events were missed
  setInterval(() => {
    loadInitialDownloads();
  }, 2000);
});

function setupEventListeners() {
  // Modal toggles
  document.getElementById('btn-add-modal').addEventListener('click', () => openModal());
  document.getElementById('modal-close-btn').addEventListener('click', () => closeModal());
  document.getElementById('modal-cancel-btn').addEventListener('click', () => closeModal());

  // Slider
  modalPartsSlider.addEventListener('input', (e) => {
    partsValLabel.textContent = e.target.value;
  });

  // Paste clipboard
  document.getElementById('btn-paste-clipboard').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.startsWith('http')) {
        modalUrlInput.value = text.trim();
        triggerProbe(text.trim());
      }
    } catch (e) {
      console.warn('Could not read clipboard', e);
    }
  });

  // URL input debounce probe
  let probeTimer = null;
  modalUrlInput.addEventListener('input', (e) => {
    const url = e.target.value.trim();
    clearTimeout(probeTimer);
    if (url.startsWith('http://') || url.startsWith('https://')) {
      probeTimer = setTimeout(() => triggerProbe(url), 400);
    }
  });

  // Start Download Button
  document.getElementById('modal-start-btn').addEventListener('click', async () => {
    const url = modalUrlInput.value.trim();
    if (!url) return;

    const filename = modalFilenameInput.value.trim() || undefined;
    const parts = parseInt(modalPartsSlider.value, 10) || 8;

    try {
      if (invoke) {
        await invoke('start_download', { url, filename, parts });
      }
      closeModal();
    } catch (err) {
      alert('Failed to start download: ' + err);
    }
  });

  // Filter Buttons
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeFilter = btn.dataset.filter || 'all';
      renderTable();
    });
  });

  // Search
  document.getElementById('search-input').addEventListener('input', (e) => {
    state.searchQuery = e.target.value.toLowerCase().trim();
    renderTable();
  });
}

function openModal() {
  addModal.classList.add('active');
  modalUrlInput.value = '';
  modalFilenameInput.value = '';
  probeInfo.style.display = 'none';
  probeLoading.style.display = 'none';
  modalUrlInput.focus();

  navigator.clipboard.readText().then(text => {
    if (text && (text.startsWith('http://') || text.startsWith('https://'))) {
      modalUrlInput.value = text.trim();
      triggerProbe(text.trim());
    }
  }).catch(() => {});
}

function closeModal() {
  addModal.classList.remove('active');
}

async function triggerProbe(url) {
  probeLoading.style.display = 'flex';
  probeInfo.style.display = 'none';

  if (invoke) {
    try {
      const res = await invoke('probe_url', { url });
      modalFilenameInput.value = res.filename;
      probeSize.textContent = res.content_length ? formatBytes(res.content_length) : 'Unknown';
      probeRanges.textContent = res.accepts_ranges ? 'Supported (Multi-thread)' : 'Single stream only';
      probeRanges.className = res.accepts_ranges ? 'val badge-success' : 'val';
      probeLoading.style.display = 'none';
      probeInfo.style.display = 'flex';
    } catch (err) {
      probeLoading.style.display = 'none';
    }
  }
}

function setupTauriListeners() {
  if (!listen) return;

  listen('download-update', (event) => {
    const item = event.payload;
    state.downloads.set(item.id, item);
    updateRow(item);
    updateCategoryCounts();
    updateGlobalMetrics();
  });
}

async function loadInitialDownloads() {
  if (invoke) {
    try {
      const items = await invoke('get_downloads');
      items.forEach(it => state.downloads.set(it.id, it));
      renderTable();
    } catch (e) {
      console.error(e);
    }
  }
}

function renderTable() {
  bodyEl.innerHTML = '';
  const filtered = Array.from(state.downloads.values()).filter(matchesFilter);

  if (filtered.length === 0) {
    emptyStateEl.style.display = 'flex';
  } else {
    emptyStateEl.style.display = 'none';
    filtered.reverse().forEach(item => {
      bodyEl.appendChild(createRowElement(item));
    });
  }

  updateCategoryCounts();
  updateGlobalMetrics();
}

function matchesFilter(item) {
  if (state.searchQuery && !item.filename.toLowerCase().includes(state.searchQuery)) {
    return false;
  }

  const ext = item.filename.split('.').pop().toLowerCase();
  switch (state.activeFilter) {
    case 'downloading':
      return item.status === 'Downloading' || item.status === 'Starting';
    case 'completed':
      return item.status === 'Completed' && item.downloaded_bytes > 0;
    case 'video':
      return ['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext);
    case 'compressed':
      return ['zip', 'rar', '7z', 'tar', 'gz', 'iso'].includes(ext);
    case 'document':
      return ['pdf', 'docx', 'doc', 'xlsx', 'txt', 'epub'].includes(ext);
    case 'software':
      return ['exe', 'msi', 'dmg', 'apk', 'appimage'].includes(ext);
    default:
      return true;
  }
}

function createRowElement(item) {
  const tr = document.createElement('tr');
  tr.id = `row-${item.id}`;
  tr.innerHTML = getRowHtml(item);
  attachRowEvents(tr, item);
  return tr;
}

function updateRow(item) {
  let row = document.getElementById(`row-${item.id}`);
  if (!row) {
    if (matchesFilter(item)) {
      emptyStateEl.style.display = 'none';
      bodyEl.prepend(createRowElement(item));
    }
  } else {
    if (matchesFilter(item)) {
      row.innerHTML = getRowHtml(item);
      attachRowEvents(row, item);
    } else {
      row.remove();
      if (bodyEl.children.length === 0) emptyStateEl.style.display = 'flex';
    }
  }
}

function getRowHtml(item) {
  const total = item.total_bytes || 0;
  const downloaded = item.downloaded_bytes || 0;
  const pct = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : (item.status === 'Completed' ? 100 : 0);
  const icon = getFileIcon(item.filename);

  let statusClass = 'downloading';
  let statusText = item.status;
  if (item.status === 'Completed') {
    statusClass = 'completed';
    statusText = 'Completed';
  } else if (item.status === 'Error') {
    statusClass = 'error';
    statusText = item.error ? `Error: ${item.error.substring(0, 30)}` : 'Error';
  }

  const locationHint = item.target_path || `Saving to Downloads\\${item.filename}`;

  const sizeDisplay = total > 0 
    ? formatBytes(total) 
    : (downloaded > 0 ? formatBytes(downloaded) : 'Connecting...');

  const progressHtml = total > 0
    ? `<span>${pct}%</span><span>${formatBytes(downloaded)} / ${formatBytes(total)}</span>`
    : `<span>${item.status}</span><span>${formatBytes(downloaded)}</span>`;

  return `
    <td>
      <div class="file-cell">
        <span class="file-icon">${icon}</span>
        <div class="file-info">
          <span class="file-name" title="${item.filename}">${item.filename}</span>
          <span class="file-url" title="${item.error || locationHint}">${item.error ? '⚠️ ' + item.error : locationHint}</span>
        </div>
      </div>
    </td>
    <td>${sizeDisplay}</td>
    <td>
      <div class="progress-wrapper">
        <div class="progress-info">
          ${progressHtml}
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width: ${total > 0 ? pct : (downloaded > 0 ? 100 : 0)}%"></div>
        </div>
      </div>
    </td>
    <td style="font-family: var(--font-mono); font-size: 0.8rem; color: var(--accent-cyan);">
      ${item.speed_bps > 0 ? formatSpeed(item.speed_bps) : '-'}
    </td>
    <td>
      <span class="status-badge ${statusClass}" title="${item.error || item.status}">${statusText}</span>
    </td>
    <td>
      <div class="action-btn-cell">
        ${item.status === 'Completed' && item.target_path ? `
          <button class="icon-action-btn btn-open" title="Open in File Explorer">📂</button>
        ` : ''}
        <button class="icon-action-btn btn-del" title="Remove from list">🗑️</button>
      </div>
    </td>
  `;
}

function attachRowEvents(row, item) {
  const openBtn = row.querySelector('.btn-open');
  if (openBtn && item.target_path) {
    openBtn.addEventListener('click', () => {
      if (invoke) invoke('open_in_folder', { path: item.target_path });
    });
  }

  const delBtn = row.querySelector('.btn-del');
  if (delBtn) {
    delBtn.addEventListener('click', () => {
      state.downloads.delete(item.id);
      row.remove();
      if (bodyEl.children.length === 0) emptyStateEl.style.display = 'flex';
      updateCategoryCounts();
      updateGlobalMetrics();
    });
  }
}

function updateCategoryCounts() {
  const items = Array.from(state.downloads.values());
  document.getElementById('count-all').textContent = items.length;
  document.getElementById('count-downloading').textContent = items.filter(i => i.status === 'Downloading' || i.status === 'Starting').length;
  document.getElementById('count-completed').textContent = items.filter(i => i.status === 'Completed').length;
}

function updateGlobalMetrics() {
  const items = Array.from(state.downloads.values());
  const activeDownloads = items.filter(i => i.status === 'Downloading');
  const totalSpeed = activeDownloads.reduce((acc, curr) => acc + (curr.speed_bps || 0), 0);

  globalSpeedEl.textContent = formatSpeed(totalSpeed);
  activeTasksLabel.textContent = activeDownloads.length > 0 
    ? `${activeDownloads.length} active download(s)` 
    : 'Engine Ready';
}

function getFileIcon(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  if (['zip', 'rar', '7z', 'tar', 'gz', 'iso'].includes(ext)) return '🗜️';
  if (['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext)) return '🎬';
  if (['mp3', 'wav', 'flac', 'aac', 'm4a'].includes(ext)) return '🎵';
  if (['pdf', 'docx', 'doc', 'txt'].includes(ext)) return '📄';
  if (['exe', 'msi', 'dmg', 'apk'].includes(ext)) return '💻';
  if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return '🖼️';
  return '📦';
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatSpeed(bps) {
  if (!bps || bps <= 0) return '0.0 KB/s';
  return formatBytes(bps) + '/s';
}
