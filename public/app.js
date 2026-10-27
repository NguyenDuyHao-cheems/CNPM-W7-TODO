/**
 * TaskFlow - Version 3 (Kanban Board UI + N-Layer SQLite Backend)
 * CNPM Tuần 7: Tiến hóa kiến trúc ứng dụng quản lý công việc
 */

const API_BASE = '/api/tasks';
const POLL_INTERVAL_MS = 2500;

// Application State
let tasks = [];
let isInitialLoad = true;
let isPolling = false;

// DOM Elements
const taskForm = document.getElementById('task-form');
const taskInput = document.getElementById('task-title-input');
const loadingState = document.getElementById('loading-state');
const refreshBtn = document.getElementById('refresh-btn');
const toastContainer = document.getElementById('toast-container');

// Kanban Elements
const listPending = document.getElementById('list-pending');
const listCompleted = document.getElementById('list-completed');
const dropzonePending = document.getElementById('dropzone-pending');
const dropzoneCompleted = document.getElementById('dropzone-completed');
const badgePendingCount = document.getElementById('badge-pending-count');
const badgeCompletedCount = document.getElementById('badge-completed-count');
const emptyHintPending = document.getElementById('empty-hint-pending');
const emptyHintCompleted = document.getElementById('empty-hint-completed');

// Multi-Client / Network Elements
const clientNameEl = document.getElementById('client-name');
const renameClientBtn = document.getElementById('rename-client-btn');
const syncDot = document.getElementById('sync-dot');
const syncText = document.getElementById('sync-text');
const shareUrlText = document.getElementById('share-url-text');
const copyShareUrlBtn = document.getElementById('copy-share-url-btn');

// Stats Elements
const statTotal = document.getElementById('stat-total');
const statPending = document.getElementById('stat-pending');
const statCompleted = document.getElementById('stat-completed');
const statPercent = document.getElementById('stat-percent');
const progressBar = document.getElementById('progress-bar');

// Status Elements
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');

// --- Helper: Setup Client Identity ---
function initClientIdentity() {
  let clientName = sessionStorage.getItem('taskflow_client_name');
  if (!clientName) {
    const letters = ['A', 'B', 'C', 'D'];
    const randomLetter = letters[Math.floor(Math.random() * letters.length)];
    const randomNum = Math.floor(100 + Math.random() * 900);
    clientName = `Thiết bị ${randomLetter} (#${randomNum})`;
    sessionStorage.setItem('taskflow_client_name', clientName);
  }
  if (clientNameEl) {
    clientNameEl.textContent = clientName;
  }

  if (shareUrlText) {
    shareUrlText.textContent = window.location.origin;
  }
}

if (renameClientBtn) {
  renameClientBtn.addEventListener('click', () => {
    const current = sessionStorage.getItem('taskflow_client_name') || 'Thiết bị';
    const newName = prompt('Nhập tên đại diện cho thiết bị / trình duyệt này:', current);
    if (newName && newName.trim()) {
      sessionStorage.setItem('taskflow_client_name', newName.trim());
      clientNameEl.textContent = newName.trim();
      showToast(`Đã đổi tên thiết bị thành: "${newName.trim()}"`, 'info');
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

// Toast notification helper
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  let icon = 'ℹ️';
  if (type === 'success') icon = '✅';
  if (type === 'error') icon = '❌';

  toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.25s ease';
    setTimeout(() => toast.remove(), 250);
  }, 3200);
}

// Update Server Connection Status
function setServerStatus(online, details = '') {
  if (online) {
    statusIndicator.className = 'pulse-indicator connected';
    statusText.textContent = details || 'SQLite Backend :8080';
  } else {
    statusIndicator.className = 'pulse-indicator error';
    statusText.textContent = details || 'Mất kết nối server';
  }
}

// Format Timestamp
function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp * 1000);
  return date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) + 
         ' ' + date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
}

// Deep Comparison of task arrays to avoid unnecessary DOM re-renders
function areTasksEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || 
        a[i].completed !== b[i].completed || 
        a[i].title !== b[i].title) {
      return false;
    }
  }
  return true;
}

// Fetch all tasks from SQLite Backend
async function loadTasks(silent = false) {
  if (isPolling) return;
  isPolling = true;

  try {
    const res = await fetch(API_BASE, {
      headers: {
        'ngrok-skip-browser-warning': 'true',
        'Cache-Control': 'no-cache'
      }
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    
    const newTasks = await res.json();
    setServerStatus(true, 'SQLite3: tasks.db');

    if (!areTasksEqual(tasks, newTasks)) {
      const isRemoteChange = !isInitialLoad && tasks.length > 0;
      tasks = newTasks;
      renderKanban();

      if (isRemoteChange && !silent) {
        showToast('🔄 Đã đồng bộ bảng Kanban mới nhất từ server!', 'info');
      }
    }

    if (syncDot) {
      syncDot.style.opacity = '1';
      setTimeout(() => { if (syncDot) syncDot.style.opacity = '0.7'; }, 300);
    }
    if (syncText) {
      syncText.textContent = `Đồng bộ: ${new Date().toLocaleTimeString('vi-VN')}`;
    }

    isInitialLoad = false;
  } catch (err) {
    console.error('Lỗi nạp tasks:', err);
    setServerStatus(false, 'Không thể kết nối C server');
    if (!silent) {
      showToast('Lỗi khi tải dữ liệu từ C SQLite backend!', 'error');
    }
  } finally {
    isPolling = false;
    if (loadingState) loadingState.style.display = 'none';
  }
}

// Add a new task
async function handleAddTask(e) {
  e.preventDefault();
  const title = taskInput.value.trim();
  if (!title) return;

  const submitBtn = document.getElementById('add-task-btn');
  submitBtn.disabled = true;

  try {
    const res = await fetch(API_BASE, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true'
      },
      body: JSON.stringify({ title })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }

    const newTask = await res.json();
    tasks.unshift(newTask);
    taskInput.value = '';
    renderKanban();
    showToast(`Đã thêm task: "${newTask.title}" vào SQLite`, 'success');
  } catch (err) {
    console.error('Lỗi tạo task:', err);
    showToast(`Không thể thêm task: ${err.message}`, 'error');
  } finally {
    submitBtn.disabled = false;
    taskInput.focus();
  }
}

// Update task completion status
async function updateTaskStatus(id, newStatus) {
  const task = tasks.find(t => t.id === id);
  if (!task || task.completed === newStatus) return;

  // Optimistic update
  const previousStatus = task.completed;
  task.completed = newStatus;
  renderKanban();

  try {
    const res = await fetch(`${API_BASE}/${id}`, {
      method: 'PUT',
      headers: { 
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true'
      },
      body: JSON.stringify({ completed: newStatus })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    showToast(newStatus ? `Đã chuyển task #${id} sang Hoàn thành!` : `Đã chuyển task #${id} sang Chưa hoàn thành!`, 'info');
  } catch (err) {
    console.error('Lỗi cập nhật task:', err);
    task.completed = previousStatus;
    renderKanban();
    showToast('Không thể cập nhật trạng thái!', 'error');
  }
}

// Delete a task
async function deleteTask(id) {
  const task = tasks.find(t => t.id === id);
  const taskTitle = task ? task.title : `#${id}`;

  try {
    const res = await fetch(`${API_BASE}/${id}`, {
      method: 'DELETE',
      headers: {
        'ngrok-skip-browser-warning': 'true'
      }
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    tasks = tasks.filter(t => t.id !== id);
    renderKanban();
    showToast(`Đã xóa task: "${taskTitle}" khỏi SQLite database`, 'info');
  } catch (err) {
    console.error('Lỗi xóa task:', err);
    showToast('Không thể xóa task!', 'error');
  }
}

// Update Counters & Progress Bar
function updateStats() {
  const total = tasks.length;
  const completed = tasks.filter(t => t.completed).length;
  const pending = total - completed;
  const pct = total === 0 ? 0 : Math.round((completed / total) * 100);

  statTotal.textContent = total;
  statPending.textContent = pending;
  statCompleted.textContent = completed;
  statPercent.textContent = `${pct}%`;
  progressBar.style.width = `${pct}%`;

  badgePendingCount.textContent = pending;
  badgeCompletedCount.textContent = completed;

  emptyHintPending.style.display = pending === 0 ? 'block' : 'none';
  emptyHintCompleted.style.display = completed === 0 ? 'block' : 'none';
}

// Render Kanban Board (2 Columns: Pending & Completed)
function renderKanban() {
  updateStats();

  listPending.innerHTML = '';
  listCompleted.innerHTML = '';

  const pendingTasks = tasks.filter(t => !t.completed);
  const completedTasks = tasks.filter(t => t.completed);

  pendingTasks.forEach(task => {
    listPending.appendChild(createKanbanCard(task, false));
  });

  completedTasks.forEach(task => {
    listCompleted.appendChild(createKanbanCard(task, true));
  });
}

// Create Kanban Card Element with Drag & Drop + Action Buttons
function createKanbanCard(task, isCompleted) {
  const card = document.createElement('li');
  card.className = `kanban-card ${isCompleted ? 'completed' : ''}`;
  card.id = `kanban-card-${task.id}`;
  card.draggable = true;

  card.innerHTML = `
    <div class="kanban-card-header">
      <div class="kanban-card-meta">
        <span class="task-id-badge">#${task.id}</span>
        <span>${task.created_at ? formatTime(task.created_at) : 'Vừa xong'}</span>
      </div>
      <button 
        type="button" 
        class="btn-delete" 
        id="task-delete-${task.id}" 
        title="Xóa công việc khỏi SQLite"
        aria-label="Xóa task ${task.id}"
      >
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
      <button 
        type="button" 
        class="btn-move-status" 
        id="task-move-${task.id}" 
        title="${isCompleted ? 'Chuyển về Chưa hoàn thành' : 'Đánh dấu Hoàn thành'}"
      >
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

  // HTML5 Drag and Drop events
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', String(task.id));
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });

  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
  });

  // Action button toggle
  const moveBtn = card.querySelector(`#task-move-${task.id}`);
  moveBtn.addEventListener('click', () => {
    updateTaskStatus(task.id, !isCompleted);
  });

  // Delete button
  const deleteBtn = card.querySelector(`#task-delete-${task.id}`);
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteTask(task.id);
  });

  return card;
}

// Setup Dropzones for HTML5 Drag & Drop
function setupDropzones() {
  [dropzonePending, dropzoneCompleted].forEach(zone => {
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      zone.classList.add('drag-over');
    });

    zone.addEventListener('dragleave', (e) => {
      if (!zone.contains(e.relatedTarget)) {
        zone.classList.remove('drag-over');
      }
    });

    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const taskIdStr = e.dataTransfer.getData('text/plain');
      const taskId = parseInt(taskIdStr, 10);
      const targetStatus = zone.dataset.targetStatus === 'true';

      if (taskId > 0) {
        updateTaskStatus(taskId, targetStatus);
      }
    });
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Event Listeners
taskForm.addEventListener('submit', handleAddTask);
refreshBtn.addEventListener('click', () => {
  showToast('Đang làm mới dữ liệu từ SQLite database...', 'info');
  loadTasks(false);
});

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  initClientIdentity();
  setupDropzones();
  loadTasks(true);

  // Auto-sync polling every 2.5 seconds
  setInterval(() => {
    loadTasks(true);
  }, POLL_INTERVAL_MS);
});
