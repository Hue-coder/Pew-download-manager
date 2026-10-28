// ==========================================================================
// Pew Download Manager - AB Download Manager Inspired Frontend
// ==========================================================================

const tauri = window.__TAURI__;
const invoke = tauri ? (tauri.core ? tauri.core.invoke : tauri.invoke) : null;
const listen = tauri ? (tauri.event ? tauri.event.listen : null) : null;

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Application State
const state = {
  downloads: new Map(),
  activeFilter: 'all',
  currentView: 'downloads', // 'downloads' or 'settings'
  searchQuery: '',
  selectedIds: new Set(),
  detailModalId: null,
  sortField: 'date',
  sortAsc: false,
  settings: {
    download_dir: '',
    max_connections: 8,
    auto_start: true,
    open_folder_on_finish: false,
    user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  }
};

// DOM References
const bodyEl = document.getElementById('downloads-body');
const emptyStateEl = document.getElementById('empty-state');
const downloadsView = document.getElementById('downloads-view');
const settingsView = document.getElementById('settings-view');
const btnBackDownloads = document.getElementById('btn-back-downloads');
const searchInput = document.getElementById('search-input');
const searchClearBtn = document.getElementById('search-clear-btn');
const thSelectAll = document.getElementById('th-select-all');

// Modals
const addModal = document.getElementById('add-modal');
const modalUrlInput = document.getElementById('modal-url');
const modalFilenameInput = document.getElementById('modal-filename');
const modalPartsSlider = document.getElementById('modal-parts');
const partsValLabel = document.getElementById('parts-val');
const probeLoading = document.getElementById('probe-loading');
const probeSize = document.getElementById('probe-size');
const modalSavePath = document.getElementById('modal-save-path');
const rowFormatSelect = document.getElementById('row-format-select');
const modalFormatSelect = document.getElementById('modal-format-select');
const advancedBox = document.getElementById('advanced-box');

// Detail Modal
const detailModal = document.getElementById('detail-modal');
const detailHeaderTitle = document.getElementById('detail-header-title');
const detailName = document.getElementById('detail-name');
const detailStatus = document.getElementById('detail-status');
const detailSize = document.getElementById('detail-size');
const detailDownloaded = document.getElementById('detail-downloaded');
const detailSpeed = document.getElementById('detail-speed');
const detailRemaining = document.getElementById('detail-remaining');
const detailProgressBar = document.getElementById('detail-progress-bar');
const detailPartBlocks = document.getElementById('detail-part-blocks');

// Context Menu
const contextMenu = document.getElementById('row-context-menu');
let contextTargetId = null;

// Settings Controls
const settingDownloadDir = document.getElementById('setting-download-dir');
const settingMaxConnections = document.getElementById('setting-max-connections');
const settingThreadsVal = document.getElementById('setting-threads-val');
const settingAutoStart = document.getElementById('setting-auto-start');
const settingOpenFolder = document.getElementById('setting-open-folder');
const settingUa = document.getElementById('setting-ua');
const btnSaveSettings = document.getElementById('btn-save-settings');
const saveStatusMsg = document.getElementById('save-status-msg');
const btnBrowseDir = document.getElementById('btn-browse-dir');
const btnOpenCurrentDir = document.getElementById('btn-open-current-dir');

// Toolbar Controls
const btnAddModal = document.getElementById('btn-add-modal');
const btnToolbarDelete = document.getElementById('btn-toolbar-delete');
const btnOpenFolder = document.getElementById('btn-open-folder');
const btnToolbarSettings = document.getElementById('btn-toolbar-settings');
const btnSidebarSettings = document.getElementById('btn-sidebar-settings');

// Status Bar
const activeTasksLabel = document.getElementById('active-tasks-label');
const statTotalCount = document.getElementById('stat-total-count');
const globalSpeedEl = document.getElementById('global-speed');

// ==========================================================================
// Lifecycle Initialization
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  setupTauriListeners();
  loadInitialSettings();
  loadInitialDownloads();

  // Periodic polling fallback
  setInterval(() => {
    loadInitialDownloads();
  }, 2500);
});

function setupEventListeners() {
  // Tree Navigation Filter Clicking
  document.querySelectorAll('.tree-header, .tree-child').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.tree-header, .tree-child').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      state.activeFilter = btn.dataset.filter || 'all';
      showDownloadsView();
      renderTable();
    });
  });

  // Settings view triggers
  btnToolbarSettings.addEventListener('click', () => showSettingsView());
  btnSidebarSettings.addEventListener('click', () => showSettingsView());
  btnBackDownloads.addEventListener('click', () => showDownloadsView());

  // Search input
  searchInput.addEventListener('input', (e) => {
    state.searchQuery = e.target.value.toLowerCase().trim();
    searchClearBtn.style.display = state.searchQuery ? 'inline-block' : 'none';
    renderTable();
  });

  searchClearBtn.addEventListener('click', () => {
    searchInput.value = '';
    state.searchQuery = '';
    searchClearBtn.style.display = 'none';
    renderTable();
  });

  // Select All Checkbox
  thSelectAll.addEventListener('change', (e) => {
    const isChecked = e.target.checked;
    const filtered = Array.from(state.downloads.values()).filter(matchesFilter);
    state.selectedIds.clear();
    if (isChecked) {
      filtered.forEach(it => state.selectedIds.add(it.id));
    }
    renderTable();
  });

  // Toolbar Open Folder
  btnOpenFolder.addEventListener('click', () => {
    const dir = state.settings.download_dir;
    if (dir && invoke) {
      invoke('open_in_folder', { path: dir });
    }
  });

  // Delete Modal Setup & Handlers
  const modalDeleteConfirm = document.getElementById('modal-delete-confirm');
  const deleteModalClose = document.getElementById('delete-modal-close');
  const btnDeleteCancel = document.getElementById('btn-delete-cancel');
  const btnDeleteConfirm = document.getElementById('btn-delete-confirm');
  const chkDeleteDiskFile = document.getElementById('chk-delete-disk-file');
  const deleteModalMsg = document.getElementById('delete-modal-msg');
  let pendingDeleteIds = [];

  function promptDeleteDownloads(ids) {
    if (!ids || ids.length === 0) return;
    pendingDeleteIds = ids;
    const count = ids.length;
    if (count === 1) {
      const item = state.downloads.get(ids[0]);
      const name = item ? item.filename : 'this item';
      deleteModalMsg.innerHTML = `Are you sure you want to delete <strong style="color: #fff;">"${escapeHtml(name)}"</strong>?`;
    } else {
      deleteModalMsg.innerHTML = `Are you sure you want to delete <strong style="color: #fff;">${count}</strong> selected downloads?`;
    }
    if (chkDeleteDiskFile) chkDeleteDiskFile.checked = true;
    if (modalDeleteConfirm) modalDeleteConfirm.classList.add('active');
  }

  function closeDeleteModal() {
    if (modalDeleteConfirm) modalDeleteConfirm.classList.remove('active');
    pendingDeleteIds = [];
  }

  if (deleteModalClose) deleteModalClose.addEventListener('click', closeDeleteModal);
  if (btnDeleteCancel) btnDeleteCancel.addEventListener('click', closeDeleteModal);

  if (btnDeleteConfirm) {
    btnDeleteConfirm.addEventListener('click', async () => {
      const shouldDeleteFile = chkDeleteDiskFile ? chkDeleteDiskFile.checked : true;
      const idsToDelete = [...pendingDeleteIds];
      closeDeleteModal();

      for (const id of idsToDelete) {
        if (invoke) {
          try {
            await invoke('delete_download', { id, delete_file: shouldDeleteFile, deleteFile: shouldDeleteFile });
          } catch (err) {
            console.error('delete_download error:', err);
          }
        }
        state.downloads.delete(id);
        state.selectedIds.delete(id);
      }
      btnToolbarDelete.disabled = state.selectedIds.size === 0;
      renderTable();
    });
  }

  // Toolbar Delete Selected
  btnToolbarDelete.addEventListener('click', () => {
    if (state.selectedIds.size === 0) return;
    promptDeleteDownloads(Array.from(state.selectedIds));
  });

  // Global Keyboard Shortcuts (Delete / Backspace / Escape)
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (modalDeleteConfirm && modalDeleteConfirm.classList.contains('active')) {
        closeDeleteModal();
      }
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (modalDeleteConfirm && modalDeleteConfirm.classList.contains('active')) return;
      if (state.selectedIds.size > 0) {
        e.preventDefault();
        promptDeleteDownloads(Array.from(state.selectedIds));
      }
    }
  });

  // Modal Open & Close
  btnAddModal.addEventListener('click', () => openAddModal());
  document.getElementById('modal-close-btn').addEventListener('click', () => closeAddModal());
  document.getElementById('modal-cancel-btn').addEventListener('click', () => closeAddModal());

  // Add Modal Sliders & Settings Toggles
  modalPartsSlider.addEventListener('input', (e) => {
    partsValLabel.textContent = e.target.value;
  });

  document.getElementById('btn-toggle-advanced').addEventListener('click', () => {
    advancedBox.style.display = advancedBox.style.display === 'none' ? 'flex' : 'none';
  });

  // Paste from clipboard in Add Modal
  document.getElementById('btn-paste-clipboard').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim().startsWith('http')) {
        modalUrlInput.value = text.trim();
        triggerProbe(text.trim());
      }
    } catch (e) {}
  });

  // Add Modal Browse Directory
  document.getElementById('btn-modal-browse').addEventListener('click', async () => {
    if (invoke) {
      try {
        const chosen = await invoke('select_folder');
        if (chosen) {
          modalSavePath.textContent = chosen;
          modalSavePath.title = chosen;
        }
      } catch (e) {}
    }
  });

  // Debounced URL Probe
  let probeTimer = null;
  modalUrlInput.addEventListener('input', (e) => {
    const url = e.target.value.trim();
    clearTimeout(probeTimer);
    if (url.startsWith('http://') || url.startsWith('https://')) {
      probeTimer = setTimeout(() => triggerProbe(url), 350);
    }
  });

  document.getElementById('btn-reprobe').addEventListener('click', () => {
    const url = modalUrlInput.value.trim();
    if (url) triggerProbe(url);
  });

  // Add Modal Actions (Download & Add)
  document.getElementById('modal-start-btn').addEventListener('click', () => executeAddDownload(true));
  document.getElementById('modal-btn-add').addEventListener('click', () => executeAddDownload(false));

  // Detail Modal Actions
  document.getElementById('detail-close-btn').addEventListener('click', () => closeDetailModal());
  document.getElementById('btn-detail-close').addEventListener('click', () => closeDetailModal());
  document.getElementById('btn-detail-folder').addEventListener('click', () => {
    if (state.detailModalId) {
      const item = state.downloads.get(state.detailModalId);
      if (item && item.target_path && invoke) {
        invoke('open_in_folder', { path: item.target_path });
      } else if (state.settings.download_dir && invoke) {
        invoke('open_in_folder', { path: state.settings.download_dir });
      }
    }
  });

  // Settings Page Listeners
  settingMaxConnections.addEventListener('input', (e) => {
    settingThreadsVal.textContent = e.target.value;
  });

  btnBrowseDir.addEventListener('click', async () => {
    if (invoke) {
      try {
        const chosen = await invoke('select_folder');
        if (chosen) settingDownloadDir.value = chosen;
      } catch (e) {}
    }
  });

  btnOpenCurrentDir.addEventListener('click', () => {
    const dir = settingDownloadDir.value.trim() || state.settings.download_dir;
    if (dir && invoke) invoke('open_in_folder', { path: dir });
  });

  btnSaveSettings.addEventListener('click', () => savePreferences());

  document.getElementById('btn-quit-app').addEventListener('click', () => {
    if (confirm('Quit Pew Download Manager completely?')) {
      if (invoke) invoke('exit_app');
    }
  });

  // Global Context Menu dismiss
  document.addEventListener('click', (e) => {
    if (!contextMenu.contains(e.target)) {
      contextMenu.style.display = 'none';
    }
  });

  // Context Menu Item Handlers
  document.getElementById('ctx-open-file').addEventListener('click', () => {
    contextMenu.style.display = 'none';
    if (contextTargetId) {
      const item = state.downloads.get(contextTargetId);
      if (item && item.target_path && invoke) invoke('open_file', { path: item.target_path });
    }
  });

  document.getElementById('ctx-open-folder').addEventListener('click', () => {
    contextMenu.style.display = 'none';
    if (contextTargetId) {
      const item = state.downloads.get(contextTargetId);
      if (item && item.target_path && invoke) invoke('open_in_folder', { path: item.target_path });
    }
  });

  document.getElementById('ctx-copy-url').addEventListener('click', () => {
    contextMenu.style.display = 'none';
    if (contextTargetId) {
      const item = state.downloads.get(contextTargetId);
      if (item && item.url) navigator.clipboard.writeText(item.url);
    }
  });

  document.getElementById('ctx-delete').addEventListener('click', () => {
    contextMenu.style.display = 'none';
    if (contextTargetId) {
      promptDeleteDownloads([contextTargetId]);
    }
  });

  // Menubar Option Actions
  document.getElementById('opt-add-url').addEventListener('click', () => openAddModal());
  document.getElementById('opt-browse-folder').addEventListener('click', () => {
    if (state.settings.download_dir && invoke) invoke('open_in_folder', { path: state.settings.download_dir });
  });
  document.getElementById('opt-settings').addEventListener('click', () => showSettingsView());
  document.getElementById('opt-exit').addEventListener('click', () => {
    if (invoke) invoke('exit_app');
  });
  document.getElementById('opt-clear-completed').addEventListener('click', async () => {
    for (const [id, item] of state.downloads) {
      if (item.status === 'Completed') {
        if (invoke) await invoke('delete_download', { id, deleteFile: false });
        state.downloads.delete(id);
      }
    }
    renderTable();
  });
  document.getElementById('opt-check-updates').addEventListener('click', () => {
    alert('Pew Download Manager v0.1.2\n\nYou are running the latest version with AB Download Manager UI and high-speed multi-threaded engine!');
  });
  document.getElementById('opt-browser-integration').addEventListener('click', () => {
    openBrowserIntegrationModal();
  });
  document.getElementById('opt-about').addEventListener('click', () => {
    alert('Pew Download Manager v0.1.2\nHigh-Performance Multi-threaded Rust Core\nModeled after AB Download Manager');
  });
  document.getElementById('opt-github').addEventListener('click', () => {
    window.open('https://github.com/Hue-coder/Pew-download-manager', '_blank');
  });

  // Browser Integration Modal Listeners
  const modalIntegration = document.getElementById('modal-browser-integration');
  const btnCloseInt = document.getElementById('int-close-btn');
  const btnDoneInt = document.getElementById('btn-int-done');
  const btnCopyIntPath = document.getElementById('btn-int-copy-path');
  const btnOpenIntFolder = document.getElementById('btn-int-open-folder');
  const inputIntPath = document.getElementById('int-ext-path');

  async function openBrowserIntegrationModal() {
    if (invoke) {
      try {
        const info = await invoke('get_extension_info');
        if (info && info.path) {
          inputIntPath.value = info.path;
        }
      } catch (e) {}
    }
    modalIntegration.classList.add('active');
  }

  function closeBrowserIntegrationModal() {
    modalIntegration.classList.remove('active');
  }

  if (btnCloseInt) btnCloseInt.addEventListener('click', closeBrowserIntegrationModal);
  if (btnDoneInt) btnDoneInt.addEventListener('click', closeBrowserIntegrationModal);
  if (btnCopyIntPath) {
    btnCopyIntPath.addEventListener('click', () => {
      navigator.clipboard.writeText(inputIntPath.value);
      btnCopyIntPath.textContent = '✓ Copied';
      setTimeout(() => btnCopyIntPath.textContent = '📋 Copy', 1500);
    });
  }
  if (btnOpenIntFolder) {
    btnOpenIntFolder.addEventListener('click', () => {
      if (invoke) invoke('open_extension_folder');
    });
  }
}

// ==========================================================================
// View Transitions
// ==========================================================================
function showSettingsView() {
  state.currentView = 'settings';
  downloadsView.style.display = 'none';
  settingsView.style.display = 'block';
  btnBackDownloads.style.display = 'inline-block';
}

function showDownloadsView() {
  state.currentView = 'downloads';
  settingsView.style.display = 'none';
  downloadsView.style.display = 'block';
  btnBackDownloads.style.display = 'none';
}

// ==========================================================================
// Tauri Events & Data Fetching
// ==========================================================================
function setupTauriListeners() {
  if (!listen) return;

  listen('download-update', (event) => {
    const item = event.payload;
    state.downloads.set(item.id, item);
    updateRow(item);
    updateCategoryCounts();
    updateGlobalMetrics();

    // If detail modal is open for this item, update it in real-time
    if (state.detailModalId === item.id) {
      updateDetailModal(item);
    }
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

async function loadInitialSettings() {
  if (invoke) {
    try {
      const cfg = await invoke('get_settings');
      if (cfg) {
        state.settings = cfg;
        settingDownloadDir.value = cfg.download_dir || '';
        settingMaxConnections.value = cfg.max_connections || 8;
        settingThreadsVal.textContent = cfg.max_connections || 8;
        modalPartsSlider.value = cfg.max_connections || 8;
        partsValLabel.textContent = cfg.max_connections || 8;
        settingAutoStart.checked = cfg.auto_start !== false;
        settingOpenFolder.checked = cfg.open_folder_on_finish === true;
        settingUa.value = cfg.user_agent || state.settings.user_agent;

        if (cfg.download_dir) {
          modalSavePath.textContent = cfg.download_dir;
          modalSavePath.title = cfg.download_dir;
        }
      }
    } catch (e) {}
  }
}

async function savePreferences() {
  const newSettings = {
    download_dir: settingDownloadDir.value.trim(),
    max_connections: parseInt(settingMaxConnections.value, 10) || 8,
    auto_start: settingAutoStart.checked,
    open_folder_on_finish: settingOpenFolder.checked,
    user_agent: settingUa.value,
  };

  if (invoke) {
    try {
      await invoke('save_settings', { settings: newSettings });
      state.settings = newSettings;
      modalSavePath.textContent = newSettings.download_dir;
      saveStatusMsg.style.display = 'inline-block';
      setTimeout(() => { saveStatusMsg.style.display = 'none'; }, 2500);
    } catch (e) {
      alert('Failed to save settings: ' + e);
    }
  }
}

// ==========================================================================
// Table Rendering & Row Updates
// ==========================================================================
function renderTable() {
  if (state.currentView !== 'downloads') return;

  bodyEl.innerHTML = '';
  const filtered = Array.from(state.downloads.values()).filter(matchesFilter);

  // Sorting
  filtered.sort((a, b) => {
    let res = 0;
    if (state.sortField === 'name') res = a.filename.localeCompare(b.filename);
    else if (state.sortField === 'size') res = (a.total_bytes || 0) - (b.total_bytes || 0);
    else if (state.sortField === 'status') res = a.status.localeCompare(b.status);
    else if (state.sortField === 'speed') res = (a.speed_bps || 0) - (b.speed_bps || 0);
    else res = (b.id || '').localeCompare(a.id || '');
    return state.sortAsc ? res : -res;
  });

  if (filtered.length === 0) {
    emptyStateEl.style.display = 'flex';
  } else {
    emptyStateEl.style.display = 'none';
    filtered.forEach(item => {
      bodyEl.appendChild(createRowElement(item));
    });
  }

  // Update selection button state
  btnToolbarDelete.disabled = state.selectedIds.size === 0;

  updateCategoryCounts();
  updateGlobalMetrics();
}

function matchesFilter(item) {
  if (state.searchQuery && !item.filename.toLowerCase().includes(state.searchQuery)) {
    return false;
  }

  const isFinished = item.status === 'Completed' || (item.total_bytes > 0 && item.downloaded_bytes >= item.total_bytes && item.speed_bps === 0);
  const ext = (item.filename || '').split('.').pop().toLowerCase();

  switch (state.activeFilter) {
    case 'finished':
      return isFinished;
    case 'unfinished':
      return !isFinished;
    case 'video':
      return ['mp4', 'mkv', 'avi', 'mov', 'webm', 'ts', 'm4v', 'flv'].includes(ext);
    case 'music':
      return ['mp3', 'wav', 'flac', 'aac', 'm4a', 'opus', 'ogg'].includes(ext);
    case 'image':
      return ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'bmp', 'ico'].includes(ext);
    case 'apps':
      return ['exe', 'msi', 'dmg', 'apk', 'appimage', 'deb', 'rpm'].includes(ext);
    case 'document':
      return ['pdf', 'docx', 'doc', 'xlsx', 'txt', 'epub', 'pptx'].includes(ext);
    case 'compressed':
      return ['zip', 'rar', '7z', 'tar', 'gz', 'iso', 'bz2', 'xz'].includes(ext);
    case 'other':
      return !['mp4', 'mkv', 'avi', 'mov', 'webm', 'ts', 'mp3', 'wav', 'flac', 'jpg', 'png', 'webp', 'exe', 'msi', 'pdf', 'zip', 'rar', '7z'].includes(ext);
    default:
      return true;
  }
}

function createRowElement(item) {
  const tr = document.createElement('tr');
  tr.id = `row-${item.id}`;
  if (state.selectedIds.has(item.id)) tr.classList.add('selected');

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
      if (state.selectedIds.has(item.id)) row.classList.add('selected');
      else row.classList.remove('selected');
      attachRowEvents(row, item);
    } else {
      row.remove();
      if (bodyEl.children.length === 0) emptyStateEl.style.display = 'flex';
    }
  }
}

function getRowHtml(item) {
  const isSelected = state.selectedIds.has(item.id);
  const total = item.total_bytes || 0;
  const downloaded = item.downloaded_bytes || 0;
  const isFinished = item.status === 'Completed' || (total > 0 && downloaded >= total && item.speed_bps === 0);
  const pct = isFinished ? 100 : (total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0);
  const icon = getFileIcon(item.filename);
  const category = getCategoryName(item.filename);

  // Status Presentation matching ABDM
  let statusText = 'Added';
  let statusClass = 'status-added';
  let showProgress = false;

  if (isFinished) {
    statusText = 'Finished';
    statusClass = 'status-finished';
  } else if (item.status === 'Downloading') {
    statusText = `${pct}% Downloading`;
    statusClass = 'status-downloading';
    showProgress = true;
  } else if (item.status === 'Starting' || item.status.includes('...')) {
    statusText = item.status;
    statusClass = 'status-downloading';
    showProgress = true;
  } else if (item.status === 'Paused') {
    statusText = `${pct}% Paused`;
    statusClass = 'status-paused';
    showProgress = true;
  } else if (item.status === 'Error') {
    statusText = item.error ? 'Error' : 'Error';
    statusClass = 'status-error';
  }

  // Size
  const sizeText = total > 0 ? formatBytes(total) : (downloaded > 0 ? formatBytes(downloaded) : '-');

  // Speed
  const speedText = (!isFinished && item.speed_bps > 0) ? formatSpeed(item.speed_bps) : '';

  // Time Remaining (e.g. "2 m 22 s left")
  let timeLeftText = '';
  if (!isFinished && item.speed_bps > 0 && total > downloaded) {
    const remainingSecs = Math.round((total - downloaded) / item.speed_bps);
    timeLeftText = formatDuration(remainingSecs) + ' left';
  }

  // Date Added / Relative
  const dateText = item.date_added || 'Recently';

  return `
    <td class="td-check">
      <input type="checkbox" class="row-checkbox" ${isSelected ? 'checked' : ''}>
    </td>
    <td class="td-name">
      <div class="cell-file">
        <span class="file-type-icon">${icon}</span>
        <div class="file-text-col">
          <span class="file-name-line" title="${item.filename}">${item.filename}</span>
          <span class="file-category-line">${category}</span>
        </div>
      </div>
    </td>
    <td class="td-size">${sizeText}</td>
    <td class="td-status">
      <div class="cell-status">
        <div class="status-text-row">
          <span class="${statusClass}">${statusText}</span>
        </div>
        ${showProgress ? `
          <div class="slim-progress-track">
            <div class="slim-progress-fill ${item.status === 'Paused' ? 'paused' : ''}" style="width: ${total > 0 ? pct : 50}%"></div>
          </div>
        ` : ''}
      </div>
    </td>
    <td class="td-speed">${speedText}</td>
    <td class="td-time">${timeLeftText}</td>
    <td class="td-date">${dateText}</td>
  `;
}

function attachRowEvents(row, item) {
  const checkbox = row.querySelector('.row-checkbox');
  if (checkbox) {
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
      if (checkbox.checked) {
        state.selectedIds.add(item.id);
        row.classList.add('selected');
      } else {
        state.selectedIds.delete(item.id);
        row.classList.remove('selected');
      }
      btnToolbarDelete.disabled = state.selectedIds.size === 0;
    });
  }

  // Row Click for selection
  row.addEventListener('click', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.closest('.row-checkbox')) return;
    if (state.selectedIds.has(item.id)) {
      state.selectedIds.delete(item.id);
      row.classList.remove('selected');
      if (checkbox) checkbox.checked = false;
    } else {
      state.selectedIds.add(item.id);
      row.classList.add('selected');
      if (checkbox) checkbox.checked = true;
    }
    btnToolbarDelete.disabled = state.selectedIds.size === 0;
  });

  // Double Click opens Download Details Modal
  row.addEventListener('dblclick', () => {
    openDetailModal(item.id);
  });

  // Right Click Context Menu
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    contextTargetId = item.id;
    contextMenu.style.top = `${Math.min(window.innerHeight - 150, e.clientY)}px`;
    contextMenu.style.left = `${Math.min(window.innerWidth - 180, e.clientX)}px`;
    contextMenu.style.display = 'flex';
  });
}

// ==========================================================================
// Category Counts & Metrics
// ==========================================================================
function updateCategoryCounts() {
  const items = Array.from(state.downloads.values());
  const counts = {
    all: items.length,
    image: 0,
    music: 0,
    video: 0,
    apps: 0,
    document: 0,
    compressed: 0,
    other: 0,
    finished: 0,
    unfinished: 0,
  };

  items.forEach(it => {
    const isFinished = it.status === 'Completed' || (it.total_bytes > 0 && it.downloaded_bytes >= it.total_bytes);
    if (isFinished) counts.finished++;
    else counts.unfinished++;

    const ext = (it.filename || '').split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'].includes(ext)) counts.image++;
    else if (['mp3', 'wav', 'flac', 'aac', 'm4a', 'opus'].includes(ext)) counts.music++;
    else if (['mp4', 'mkv', 'avi', 'mov', 'webm', 'ts'].includes(ext)) counts.video++;
    else if (['exe', 'msi', 'dmg', 'apk'].includes(ext)) counts.apps++;
    else if (['pdf', 'docx', 'doc', 'xlsx', 'txt'].includes(ext)) counts.document++;
    else if (['zip', 'rar', '7z', 'tar', 'gz', 'iso'].includes(ext)) counts.compressed++;
    else counts.other++;
  });

  document.getElementById('count-all').textContent = counts.all;
  document.getElementById('count-image').textContent = counts.image;
  document.getElementById('count-music').textContent = counts.music;
  document.getElementById('count-video').textContent = counts.video;
  document.getElementById('count-apps').textContent = counts.apps;
  document.getElementById('count-document').textContent = counts.document;
  document.getElementById('count-compressed').textContent = counts.compressed;
  document.getElementById('count-other').textContent = counts.other;
  document.getElementById('count-finished').textContent = counts.finished;
  document.getElementById('count-unfinished').textContent = counts.unfinished;

  statTotalCount.textContent = counts.all;
}

function updateGlobalMetrics() {
  const items = Array.from(state.downloads.values());
  const activeDownloads = items.filter(i => i.status === 'Downloading');
  const totalSpeed = activeDownloads.reduce((acc, curr) => acc + (curr.speed_bps || 0), 0);

  globalSpeedEl.textContent = formatSpeed(totalSpeed);
  activeTasksLabel.textContent = activeDownloads.length > 0 
    ? `${activeDownloads.length} active download(s)` 
    : 'Ready';
}

// ==========================================================================
// Add Download Modal Logic
// ==========================================================================
let modalResolvedFormats = [];

function openAddModal() {
  addModal.classList.add('active');
  modalUrlInput.value = '';
  modalFilenameInput.value = '';
  modalResolvedFormats = [];
  rowFormatSelect.style.display = 'none';
  modalFormatSelect.innerHTML = '';
  probeSize.textContent = 'Unknown';
  probeLoading.style.display = 'none';
  advancedBox.style.display = 'none';
  modalUrlInput.focus();

  navigator.clipboard.readText().then(text => {
    if (text && (text.startsWith('http://') || text.startsWith('https://'))) {
      modalUrlInput.value = text.trim();
      triggerProbe(text.trim());
    }
  }).catch(() => {});
}

function closeAddModal() {
  addModal.classList.remove('active');
}

async function triggerProbe(url) {
  probeLoading.style.display = 'flex';
  rowFormatSelect.style.display = 'none';
  modalResolvedFormats = [];

  if (invoke) {
    try {
      // 1. YouTube / Streaming Resolution
      const resData = await invoke('resolve_url_formats', { url });
      if (resData && resData.success && Array.isArray(resData.formats) && resData.formats.length > 0) {
        modalResolvedFormats = resData.formats;
        modalFormatSelect.innerHTML = '';
        resData.formats.forEach((f, idx) => {
          const opt = document.createElement('option');
          opt.value = idx;
          const sz = f.size > 0 ? ` (${formatBytes(f.size)})` : '';
          opt.textContent = `${f.quality} - ${f.format}${sz}`;
          modalFormatSelect.appendChild(opt);
        });
        rowFormatSelect.style.display = 'block';

        modalFormatSelect.onchange = () => {
          const chosen = modalResolvedFormats[parseInt(modalFormatSelect.value, 10)];
          if (chosen) {
            modalFilenameInput.value = chosen.filename;
            probeSize.textContent = chosen.size > 0 ? formatBytes(chosen.size) : 'Stream';
          }
        };

        const first = resData.formats[0];
        modalFilenameInput.value = first.filename;
        probeSize.textContent = first.size > 0 ? formatBytes(first.size) : 'Available';
        probeLoading.style.display = 'none';
        return;
      }
    } catch (e) {}

    // 2. Direct probe fallback
    try {
      const res = await invoke('probe_url', { url });
      modalFilenameInput.value = res.filename;
      probeSize.textContent = res.content_length ? formatBytes(res.content_length) : 'Unknown';
      probeLoading.style.display = 'none';
    } catch (err) {
      probeLoading.style.display = 'none';
    }
  }
}

async function executeAddDownload(startImmediately) {
  let url = modalUrlInput.value.trim();
  if (!url) return;

  let filename = modalFilenameInput.value.trim() || undefined;
  let audioUrl = undefined;
  if (modalResolvedFormats && modalResolvedFormats.length > 0 && modalFormatSelect) {
    const chosen = modalResolvedFormats[parseInt(modalFormatSelect.value, 10)];
    if (chosen && chosen.url) {
      url = chosen.url;
      audioUrl = chosen.audio_url || undefined;
      filename = chosen.filename;
    }
  }

  const parts = parseInt(modalPartsSlider.value, 10) || state.settings.max_connections || 8;

  try {
    if (invoke) {
      await invoke('start_download', { 
        url,
        audioUrl,
        filename, 
        parts,
        outputDir: state.settings.download_dir || undefined 
      });
    }
    closeAddModal();
    showDownloadsView();
  } catch (err) {
    alert('Failed to start download: ' + err);
  }
}

// ==========================================================================
// Download Detail Modal Logic (Matching ABDM Screenshot 2)
// ==========================================================================
function openDetailModal(id) {
  const item = state.downloads.get(id);
  if (!item) return;

  state.detailModalId = id;
  updateDetailModal(item);
  detailModal.classList.add('active');
}

function closeDetailModal() {
  state.detailModalId = null;
  detailModal.classList.remove('active');
}

function updateDetailModal(item) {
  const total = item.total_bytes || 0;
  const downloaded = item.downloaded_bytes || 0;
  const isFinished = item.status === 'Completed' || (total > 0 && downloaded >= total && item.speed_bps === 0);
  const pct = isFinished ? 100 : (total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0);

  detailHeaderTitle.textContent = `${pct}% - ${item.filename}`;
  detailName.textContent = item.filename;
  detailStatus.textContent = item.status;
  detailSize.textContent = total > 0 ? formatBytes(total) : 'Unknown';
  detailDownloaded.textContent = formatBytes(downloaded);
  detailSpeed.textContent = item.speed_bps > 0 ? formatSpeed(item.speed_bps) : '-';

  if (!isFinished && item.speed_bps > 0 && total > downloaded) {
    const secs = Math.round((total - downloaded) / item.speed_bps);
    detailRemaining.textContent = formatDuration(secs) + ' left';
  } else {
    detailRemaining.textContent = isFinished ? 'Completed' : '-';
  }

  detailProgressBar.style.width = `${total > 0 ? pct : 50}%`;

  // Render multi-part connection block visualizer
  const partsCount = item.parts || 8;
  detailPartBlocks.innerHTML = '';
  for (let i = 0; i < partsCount; i++) {
    const block = document.createElement('div');
    block.className = 'part-block';
    if (isFinished || (pct > ((i / partsCount) * 100))) {
      block.classList.add('active');
    } else if (item.status === 'Downloading') {
      block.classList.add('chunk-mid');
    }
    detailPartBlocks.appendChild(block);
  }
}

// ==========================================================================
// Helper Utilities
// ==========================================================================
function getCategoryName(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  if (['mp4', 'mkv', 'avi', 'mov', 'webm', 'ts'].includes(ext)) return 'Video';
  if (['mp3', 'wav', 'flac', 'aac', 'm4a'].includes(ext)) return 'Music';
  if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return 'Image';
  if (['exe', 'msi', 'dmg', 'apk'].includes(ext)) return 'Apps';
  if (['pdf', 'docx', 'doc', 'xlsx', 'txt'].includes(ext)) return 'Document';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'iso'].includes(ext)) return 'Compressed';
  return 'Other';
}

function getFileIcon(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  if (['zip', 'rar', '7z', 'tar', 'gz', 'iso'].includes(ext)) return '🗜️';
  if (['mp4', 'mkv', 'avi', 'mov', 'webm', 'ts'].includes(ext)) return '🎥';
  if (['mp3', 'wav', 'flac', 'aac', 'm4a'].includes(ext)) return '🎵';
  if (['pdf', 'docx', 'doc', 'txt', 'xlsx'].includes(ext)) return '📄';
  if (['exe', 'msi', 'dmg', 'apk'].includes(ext)) return '📦';
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

function formatDuration(totalSeconds) {
  if (!totalSeconds || totalSeconds <= 0) return '0 s';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours} h ${minutes} m`;
  if (minutes > 0) return `${minutes} m ${seconds} s`;
  return `${seconds} s`;
}
