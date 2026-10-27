/**
 * TaskFlow - Version 3.5 (Real-time SSE Collaboration + N-Layer SQLite Backend)
 * CNPM Tuần 7: Tiến hóa kiến trúc ứng dụng quản lý công việc
 *
 * V3.5 changes:
 *  - Replaced 2.5s HTTP polling with Server-Sent Events (SSE) for real-time sync
 *  - Added online user awareness panel
 *  - Event-based change protocol (task_created / task_updated / task_deleted)
 *    — same format that V4 P2P WebRTC DataChannel will reuse
 *  - Polling retained as automatic fallback when SSE is disconnected
 */

const API_BASE        = '/api/tasks';
const POLL_INTERVAL_MS = 2500;

// Application State
let tasks         = [];
let isInitialLoad = true;
let isPolling     = false;

// DOM Elements
const taskForm       = document.getElementById('task-form');
const taskInput      = document.getElementById('task-title-input');
const loadingState   = document.getElementById('loading-state');
const refreshBtn     = document.getElementById('refresh-btn');
const toastContainer = document.getElementById('toast-container');

// Kanban Elements
const listPending        = document.getElementById('list-pending');
const listCompleted      = document.getElementById('list-completed');
const dropzonePending    = document.getElementById('dropzone-pending');
const dropzoneCompleted  = document.getElementById('dropzone-completed');
const badgePendingCount  = document.getElementById('badge-pending-count');
const badgeCompletedCount= document.getElementById('badge-completed-count');
const emptyHintPending   = document.getElementById('empty-hint-pending');
const emptyHintCompleted = document.getElementById('empty-hint-completed');

// Multi-Client / Network Elements
const clientNameEl    = document.getElementById('client-name');
const renameClientBtn = document.getElementById('rename-client-btn');
const syncDot         = document.getElementById('sync-dot');
const syncText        = document.getElementById('sync-text');
const shareUrlText    = document.getElementById('share-url-text');
const copyShareUrlBtn = document.getElementById('copy-share-url-btn');

// Online users panel
const onlineCountEl  = document.getElementById('online-count');
const onlineAvatarsEl= document.getElementById('online-avatars');

// Stats Elements
const statTotal     = document.getElementById('stat-total');
const statPending   = document.getElementById('stat-pending');
const statCompleted = document.getElementById('stat-completed');
const statPercent   = document.getElementById('stat-percent');
const progressBar   = document.getElementById('progress-bar');

// Status Elements
const statusIndicator = document.getElementById('status-indicator');
const statusText      = document.getElementById('status-text');

// =============================================================================
// Client identity
// =============================================================================

function initClientIdentity() {
  let clientName = sessionStorage.getItem('taskflow_client_name');
  if (!clientName) {
    const letters    = ['A', 'B', 'C', 'D', 'E', 'F'];
    const randomLetter = letters[Math.floor(Math.random() * letters.length)];
    const randomNum    = Math.floor(100 + Math.random() * 900);
    clientName = `Thiết bị ${randomLetter} (#${randomNum})`;
    sessionStorage.setItem('taskflow_client_name', clientName);
  }
  if (clientNameEl) clientNameEl.textContent = clientName;
  if (shareUrlText) shareUrlText.textContent  = window.location.origin;
}

if (renameClientBtn) {
  renameClientBtn.addEventListener('click', () => {
    const current = sessionStorage.getItem('taskflow_client_name') || 'Thiết bị';
    const newName  = prompt('Nhập tên đại diện cho thiết bị / trình duyệt này:', current);
    if (newName && newName.trim()) {
      sessionStorage.setItem('taskflow_client_name', newName.trim());
      if (clientNameEl) clientNameEl.textContent = newName.trim();
      showToast(`Đã đổi tên thiết bị thành: "${newName.trim()}"`, 'info');
      // Reconnect SSE with new name
      reconnectSSE();
    }
  });
}

if (copyShareUrlBtn) {
  copyShareUrlBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(window.location.origin);
      showToast('Đã sao chép link truy cập vào clipboard!', 'success');
    } catch {
      showToast('Link: ' + window.location.origin, 'info');
    }
  });
}

// =============================================================================
// Toast
// =============================================================================

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  let icon = 'ℹ️';
  if (type === 'success') icon = '✅';
  if (type === 'error')   icon = '❌';

  toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity   = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition= 'all 0.25s ease';
    setTimeout(() => toast.remove(), 250);
  }, 3200);
}

// =============================================================================
// Server status
// =============================================================================

function setServerStatus(online, details = '') {
  if (online) {
    statusIndicator.className = 'pulse-indicator connected';
    statusText.textContent    = details || 'SQLite Backend :8080';
  } else {
    statusIndicator.className = 'pulse-indicator error';
    statusText.textContent    = details || 'Mất kết nối server';
  }
}

// =============================================================================
// Online users panel
// =============================================================================

function updateOnlineUsers(data) {
  if (!data) return;

  const count = data.online_count ?? 0;
  if (onlineCountEl) {
    onlineCountEl.textContent = `${count} người online`;
  }

  if (onlineAvatarsEl && Array.isArray(data.clients)) {
    onlineAvatarsEl.innerHTML = data.clients
      .map(c => `<span class="online-avatar-chip" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>`)
      .join('');
  }
}

// =============================================================================
// Utilities
// =============================================================================

function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp * 1000);
  return date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) +
         ' ' + date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
}

function areTasksEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length)                  return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id ||
        a[i].completed !== b[i].completed ||
        a[i].title !== b[i].title) return false;
  }
  return true;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// =============================================================================
// REST API helpers (unchanged from V3)
// =============================================================================

async function loadTasks(silent = false) {
  if (isPolling) return;
  isPolling = true;
  try {
    const res = await fetch(API_BASE, {
      headers: { 'ngrok-skip-browser-warning': 'true', 'Cache-Control': 'no-cache' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    const newTasks = await res.json();
    setServerStatus(true, 'SSE Real-time + SQLite3');

    if (!areTasksEqual(tasks, newTasks)) {
      const isRemoteChange = !isInitialLoad && tasks.length > 0;
      tasks = newTasks;
      renderKanban();
      if (isRemoteChange && !silent) {
        showToast('🔄 Đã đồng bộ dữ liệu mới nhất từ server!', 'info');
      }
    }

    if (syncDot) {
      syncDot.style.opacity = '1';
      setTimeout(() => { if (syncDot) syncDot.style.opacity = '0.7'; }, 300);
    }
    if (syncText) syncText.textContent = `Đồng bộ: ${new Date().toLocaleTimeString('vi-VN')}`;

    isInitialLoad = false;
  } catch (err) {
    console.error('Lỗi nạp tasks:', err);
    setServerStatus(false, 'Không thể kết nối C server');
    if (!silent) showToast('Lỗi khi tải dữ liệu từ C SQLite backend!', 'error');
  } finally {
    isPolling = false;
    if (loadingState) loadingState.style.display = 'none';
  }
}

async function handleAddTask(e) {
  e.preventDefault();
  const title = taskInput.value.trim();
  if (!title) return;

  const submitBtn = document.getElementById('add-task-btn');
  submitBtn.disabled = true;

  try {
    const res = await fetch(API_BASE, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
      body:    JSON.stringify({ title })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }

    const newTask = await res.json();
    // Optimistic local insert — SSE will also arrive and be deduplicated
    if (!tasks.find(t => t.id === newTask.id)) {
      tasks.unshift(newTask);
      renderKanban();
    }
    taskInput.value = '';
    showToast(`Đã thêm task: "${newTask.title}"`, 'success');
  } catch (err) {
    console.error('Lỗi tạo task:', err);
    showToast(`Không thể thêm task: ${err.message}`, 'error');
  } finally {
    submitBtn.disabled = false;
    taskInput.focus();
  }
}

async function updateTaskStatus(id, newStatus) {
  const task = tasks.find(t => t.id === id);
  if (!task || task.completed === newStatus) return;

  const previousStatus = task.completed;
  task.completed = newStatus;
  renderKanban();

  try {
    const res = await fetch(`${API_BASE}/${id}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
      body:    JSON.stringify({ completed: newStatus })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast(newStatus
      ? `Đã chuyển task #${id} sang Hoàn thành!`
      : `Đã chuyển task #${id} sang Chưa hoàn thành!`, 'info');
  } catch (err) {
    console.error('Lỗi cập nhật task:', err);
    task.completed = previousStatus;
    renderKanban();
    showToast('Không thể cập nhật trạng thái!', 'error');
  }
}

async function deleteTask(id) {
  const task      = tasks.find(t => t.id === id);
  const taskTitle = task ? task.title : `#${id}`;
  try {
    const res = await fetch(`${API_BASE}/${id}`, {
      method:  'DELETE',
      headers: { 'ngrok-skip-browser-warning': 'true' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    tasks = tasks.filter(t => t.id !== id);
    renderKanban();
    showToast(`Đã xóa task: "${taskTitle}"`, 'info');
  } catch (err) {
    console.error('Lỗi xóa task:', err);
    showToast('Không thể xóa task!', 'error');
  }
}

// =============================================================================
// V3.5: SSE Real-time connection
// =============================================================================

let eventSource      = null;
let fallbackPollingId= null;

function getClientName() {
  return sessionStorage.getItem('taskflow_client_name') || 'Unknown';
}

function connectSSE() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  const encodedName = encodeURIComponent(getClientName());
  const url         = `/api/events?name=${encodedName}`;

  eventSource = new EventSource(url);

  /* ── task_created ──────────────────────────────────────────────── */
  eventSource.addEventListener('task_created', (e) => {
    const task = JSON.parse(e.data);
    // Deduplicate: may already be in local state from optimistic insert
    if (!tasks.find(t => t.id === task.id)) {
      tasks.unshift(task);
      renderKanban();
      showToast(`🆕 Task mới từ người dùng khác: "${task.title}"`, 'info');
    }
    updateSyncBadge();
  });

  /* ── task_updated ──────────────────────────────────────────────── */
  eventSource.addEventListener('task_updated', (e) => {
    const updated = JSON.parse(e.data);
    const idx = tasks.findIndex(t => t.id === updated.id);
    if (idx >= 0) {
      tasks[idx] = updated;
      renderKanban();
    }
    updateSyncBadge();
  });

  /* ── task_deleted ──────────────────────────────────────────────── */
  eventSource.addEventListener('task_deleted', (e) => {
    const { deleted_id } = JSON.parse(e.data);
    const before = tasks.length;
    tasks = tasks.filter(t => t.id !== deleted_id);
    if (tasks.length !== before) {
      renderKanban();
      showToast(`🗑️ Task #${deleted_id} đã bị xóa bởi người khác`, 'info');
    }
    updateSyncBadge();
  });

  /* ── client_joined ─────────────────────────────────────────────── */
  eventSource.addEventListener('client_joined', (e) => {
    const data = JSON.parse(e.data);
    updateOnlineUsers(data);
    // Only show toast if it's a different client joining
    if (data.client_name !== getClientName()) {
      showToast(`👋 ${data.client_name} đã tham gia`, 'info');
    }
  });

  /* ── client_left ───────────────────────────────────────────────── */
  eventSource.addEventListener('client_left', (e) => {
    const data = JSON.parse(e.data);
    updateOnlineUsers(data);
    showToast(`👋 ${data.client_name} đã rời phòng`, 'info');
  });

  /* ── connection lifecycle ───────────────────────────────────────── */
  eventSource.onopen = () => {
    setServerStatus(true, 'SSE Real-time Connected ✓');
    console.log('[SSE] Connected to /api/events');

    // Stop fallback polling if SSE is back
    if (fallbackPollingId) {
      clearInterval(fallbackPollingId);
      fallbackPollingId = null;
    }
  };

  eventSource.onerror = () => {
    setServerStatus(false, 'SSE mất kết nối, đang thử lại...');
    console.warn('[SSE] Connection error — falling back to polling');

    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }

    // Activate fallback polling while SSE is down
    if (!fallbackPollingId) {
      fallbackPollingId = setInterval(() => loadTasks(true), POLL_INTERVAL_MS);
    }

    // Auto-reconnect SSE after 5 s
    setTimeout(connectSSE, 5000);
  };
}

function reconnectSSE() {
  if (eventSource) { eventSource.close(); eventSource = null; }
  connectSSE();
}

function updateSyncBadge() {
  if (syncDot) {
    syncDot.style.opacity = '1';
    setTimeout(() => { if (syncDot) syncDot.style.opacity = '0.7'; }, 300);
  }
  if (syncText) syncText.textContent = `SSE sync: ${new Date().toLocaleTimeString('vi-VN')}`;
}

// =============================================================================
// Kanban rendering (unchanged from V3)
// =============================================================================

function updateStats() {
  const total     = tasks.length;
  const completed = tasks.filter(t => t.completed).length;
  const pending   = total - completed;
  const pct       = total === 0 ? 0 : Math.round((completed / total) * 100);

  statTotal.textContent     = total;
  statPending.textContent   = pending;
  statCompleted.textContent = completed;
  statPercent.textContent   = `${pct}%`;
  progressBar.style.width   = `${pct}%`;

  badgePendingCount.textContent  = pending;
  badgeCompletedCount.textContent= completed;

  emptyHintPending.style.display  = pending   === 0 ? 'block' : 'none';
  emptyHintCompleted.style.display= completed === 0 ? 'block' : 'none';
}

function renderKanban() {
  updateStats();
  listPending.innerHTML   = '';
  listCompleted.innerHTML = '';

  tasks.filter(t => !t.completed).forEach(task => listPending.appendChild(createKanbanCard(task, false)));
  tasks.filter(t =>  t.completed).forEach(task => listCompleted.appendChild(createKanbanCard(task, true)));
}

function createKanbanCard(task, isCompleted) {
  const card = document.createElement('li');
  card.className = `kanban-card ${isCompleted ? 'completed' : ''}`;
  card.id        = `kanban-card-${task.id}`;
  card.draggable = true;

  card.innerHTML = `
    <div class="kanban-card-header">
      <div class="kanban-card-meta">
        <span class="task-id-badge">#${task.id}</span>
        <span>${task.created_at ? formatTime(task.created_at) : 'Vừa xong'}</span>
      </div>
      <button type="button" class="btn-delete" id="task-delete-${task.id}"
        title="Xóa công việc" aria-label="Xóa task ${task.id}">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          <line x1="10" y1="11" x2="10" y2="17"></line>
          <line x1="14" y1="11" x2="14" y2="17"></line>
        </svg>
      </button>
    </div>

    <div class="kanban-card-body" id="task-title-${task.id}">
      ${escapeHtml(task.title)}
    </div>

    <div class="kanban-card-footer">
      <span class="status-pill ${isCompleted ? 'done' : 'pending'}">
        ${isCompleted ? 'Đã xong' : 'Chưa xong'}
      </span>
      <button type="button" class="btn-move-status" id="task-move-${task.id}"
        title="${isCompleted ? 'Chuyển về Chưa hoàn thành' : 'Đánh dấu Hoàn thành'}">
        ${isCompleted ? `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
          Làm lại
        ` : `
          Hoàn thành
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        `}
      </button>
    </div>
  `;

  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', String(task.id));
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));

  card.querySelector(`#task-move-${task.id}`).addEventListener('click', () => {
    updateTaskStatus(task.id, !isCompleted);
  });
  card.querySelector(`#task-delete-${task.id}`).addEventListener('click', (e) => {
    e.stopPropagation();
    deleteTask(task.id);
  });

  return card;
}

function setupDropzones() {
  [dropzonePending, dropzoneCompleted].forEach(zone => {
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', (e) => {
      if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over');
    });
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const taskId      = parseInt(e.dataTransfer.getData('text/plain'), 10);
      const targetStatus= zone.dataset.targetStatus === 'true';
      if (taskId > 0) updateTaskStatus(taskId, targetStatus);
    });
  });
}

// =============================================================================
// Event listeners & init
// =============================================================================

taskForm.addEventListener('submit', handleAddTask);
refreshBtn.addEventListener('click', () => {
  showToast('Đang làm mới dữ liệu...', 'info');
  loadTasks(false);
});

document.addEventListener('DOMContentLoaded', () => {
  initClientIdentity();
  setupDropzones();
  loadTasks(true);       // Initial full fetch

  // V3.5: Start SSE real-time connection
  connectSSE();
  // NOTE: No setInterval polling here — SSE handles real-time;
  // fallback polling starts automatically in eventSource.onerror
});
