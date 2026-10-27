/**
 * TaskFlow - Version 1 (Local C Backend + JSON File Storage)
 * CNPM Tuần 7: Tiến hóa kiến trúc ứng dụng quản lý công việc
 */

const API_BASE = '/api/tasks';

// Application State
let tasks = [];
let currentFilter = 'all';

// DOM Elements
const taskForm = document.getElementById('task-form');
const taskInput = document.getElementById('task-title-input');
const taskList = document.getElementById('task-list');
const loadingState = document.getElementById('loading-state');
const emptyState = document.getElementById('empty-state');
const refreshBtn = document.getElementById('refresh-btn');
const toastContainer = document.getElementById('toast-container');

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
    statusText.textContent = details || 'Hoạt động (C Backend)';
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

// Fetch all tasks from C Backend
async function loadTasks() {
  try {
    const res = await fetch(API_BASE);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    
    tasks = await res.json();
    setServerStatus(true, 'Kết nối: 127.0.0.1');
    render();
  } catch (err) {
    console.error('Lỗi nạp tasks:', err);
    setServerStatus(false, 'Không thể kết nối C server');
    showToast('Lỗi khi tải dữ liệu từ C backend!', 'error');
  } finally {
    loadingState.style.display = 'none';
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
      headers: { 'Content-Type': 'application/json' },
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
    showToast(`Đã thêm task: "${newTask.title}" vào tasks.json`, 'success');
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

  try {
    const res = await fetch(`${API_BASE}/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ completed: newStatus })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    task.completed = newStatus;
    render();
    showToast(newStatus ? `Đã hoàn thành task #${id}!` : `Đã mở lại task #${id}!`, 'info');
  } catch (err) {
    console.error('Lỗi cập nhật task:', err);
    showToast('Không thể cập nhật trạng thái!', 'error');
  }
}

// Delete a task
async function deleteTask(id) {
  const task = tasks.find(t => t.id === id);
  const taskTitle = task ? task.title : `#${id}`;

  try {
    const res = await fetch(`${API_BASE}/${id}`, {
      method: 'DELETE'
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    tasks = tasks.filter(t => t.id !== id);
    render();
    showToast(`Đã xóa task: "${taskTitle}" khỏi tasks.json`, 'info');
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
  loadTasks();
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
document.addEventListener('DOMContentLoaded', loadTasks);
