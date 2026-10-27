/**
 * TaskFlow - Version 2 (Client–Server Multi-Device Collaboration)
 * CNPM Tuần 7: Tiến hóa kiến trúc ứng dụng quản lý công việc
 */

const API_BASE = '/api/tasks';
const POLL_INTERVAL_MS = 2500; // Poll server every 2.5 seconds

// Application State
let tasks = [];
let currentFilter = 'all';
let isInitialLoad = true;
let isPolling = false;

// DOM Elements
const taskForm = document.getElementById('task-form');
const taskInput = document.getElementById('task-title-input');
const taskList = document.getElementById('task-list');
const loadingState = document.getElementById('loading-state');
const emptyState = document.getElementById('empty-state');
const refreshBtn = document.getElementById('refresh-btn');
const toastContainer = document.getElementById('toast-container');

// Multi-Client / Network Elements (V2)
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

const countAll = document.getElementById('count-all');
const countActive = document.getElementById('count-active');
const countCompleted = document.getElementById('count-completed');

// Status Elements
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');

// Filter tabs
const filterTabs = document.querySelectorAll('.filter-tab');

// --- Helper: Setup Client Identity (V2) ---
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

  // Setup Share URL
  if (shareUrlText) {
    const currentOrigin = window.location.origin;
    shareUrlText.textContent = currentOrigin;
  }
}

// Rename Client
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

// Copy Share URL
if (copyShareUrlBtn) {
  copyShareUrlBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(window.location.origin);
      showToast('Đã sao chép link truy cập vào clipboard! Mở trên thiết bị khác để thử nghiệm.', 'success');
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
    statusText.textContent = details || 'Hoạt động (C Server :8080)';
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

// Fetch all tasks from C Backend
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
    setServerStatus(true, 'Kết nối: 0.0.0.0:8080');

    // Detect remote changes from other clients
    if (!areTasksEqual(tasks, newTasks)) {
      const isRemoteChange = !isInitialLoad && tasks.length > 0;
      tasks = newTasks;
      render();

      if (isRemoteChange && !silent) {
        showToast('🔄 Đã tự động đồng bộ dữ liệu mới nhất từ server!', 'info');
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
      showToast('Lỗi khi tải dữ liệu từ C backend!', 'error');
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
    render();
    showToast(`Đã thêm task: "${newTask.title}" lên server`, 'success');
  } catch (err) {
    console.error('Lỗi tạo task:', err);
    showToast(`Không thể thêm task: ${err.message}`, 'error');
  } finally {
    submitBtn.disabled = false;
    taskInput.focus();
  }
}

// Toggle completed status
async function toggleTask(id) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;

  const newStatus = !task.completed;

  // Optimistic update
  task.completed = newStatus;
  render();

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

    showToast(newStatus ? `Đã hoàn thành task #${id}!` : `Đã mở lại task #${id}!`, 'info');
  } catch (err) {
    console.error('Lỗi cập nhật task:', err);
    // Revert
    task.completed = !newStatus;
    render();
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
    render();
    showToast(`Đã xóa task: "${taskTitle}" khỏi server`, 'info');
  } catch (err) {
    console.error('Lỗi xóa task:', err);
    showToast('Không thể xóa task!', 'error');
  }
}

// Update Counters & Progress Bar
function updateStats() {
  const total = tasks.length;
  const completed = tasks.filter(t => t.completed).length;
  const active = total - completed;
  const pct = total === 0 ? 0 : Math.round((completed / total) * 100);

  statTotal.textContent = total;
  statPending.textContent = active;
  statCompleted.textContent = completed;
  statPercent.textContent = `${pct}%`;
  progressBar.style.width = `${pct}%`;

  countAll.textContent = total;
  countActive.textContent = active;
  countCompleted.textContent = completed;
}

// Render task list based on current filter
function render() {
  updateStats();

  const filteredTasks = tasks.filter(task => {
    if (currentFilter === 'active') return !task.completed;
    if (currentFilter === 'completed') return task.completed;
    return true;
  });

  taskList.innerHTML = '';

  if (tasks.length === 0) {
    emptyState.style.display = 'flex';
    emptyState.querySelector('h3').textContent = 'Chưa có công việc nào';
    emptyState.querySelector('p').innerHTML = 'Hãy nhập tên công việc ở trên và bấm "Thêm công việc" để lưu vào <code>tasks.json</code>.';
    return;
  }

  if (filteredTasks.length === 0) {
    emptyState.style.display = 'flex';
    emptyState.querySelector('h3').textContent = 'Không có kết quả lọc';
    emptyState.querySelector('p').textContent = 'Không có công việc nào trong danh mục này.';
    return;
  }

  emptyState.style.display = 'none';

  filteredTasks.forEach(task => {
    const li = document.createElement('li');
    li.className = `task-item ${task.completed ? 'completed' : ''}`;
    li.id = `task-item-${task.id}`;

    li.innerHTML = `
      <div class="task-left">
        <button 
          type="button" 
          class="task-checkbox-btn" 
          id="task-toggle-${task.id}" 
          title="${task.completed ? 'Đánh dấu chưa hoàn thành' : 'Đánh dấu hoàn thành'}"
          aria-label="Đổi trạng thái task ${task.id}"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        </button>
        <div class="task-details">
          <span class="task-title" id="task-title-${task.id}">${escapeHtml(task.title)}</span>
          <div class="task-meta-row">
            <span class="task-id-badge">ID #${task.id}</span>
            <span>${task.created_at ? formatTime(task.created_at) : 'Vừa xong'}</span>
          </div>
        </div>
      </div>
      <div class="task-right">
        <span class="status-pill ${task.completed ? 'done' : 'pending'}">
          ${task.completed ? 'Hoàn thành' : 'Chờ làm'}
        </span>
        <button 
          type="button" 
          class="btn-delete" 
          id="task-delete-${task.id}" 
          title="Xóa công việc"
          aria-label="Xóa task ${task.id}"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            <line x1="10" y1="11" x2="10" y2="17"></line>
            <line x1="14" y1="11" x2="14" y2="17"></line>
          </svg>
        </button>
      </div>
    `;

    // Event listeners
    const toggleBtn = li.querySelector(`#task-toggle-${task.id}`);
    toggleBtn.addEventListener('click', () => toggleTask(task.id));

    const deleteBtn = li.querySelector(`#task-delete-${task.id}`);
    deleteBtn.addEventListener('click', () => deleteTask(task.id));

    taskList.appendChild(li);
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
  showToast('Đang tải lại dữ liệu từ C server...', 'info');
  loadTasks(false);
});

filterTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    filterTabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentFilter = tab.dataset.filter;
    render();
  });
});

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  initClientIdentity();
  loadTasks(true);

  // Version 2: Periodic polling to auto-sync with server and other devices
  setInterval(() => {
    loadTasks(true);
  }, POLL_INTERVAL_MS);
});
