/**
 * TaskFlow - Version 4 (P2P Collaboration via WebRTC DataChannel + N-Layer SQLite Backend)
 * CNPM Tuần 7: Tiến hóa kiến trúc ứng dụng quản lý công việc
 *
 * V4 features:
 *  - High Availability when central server loses connection
 *  - Direct Peer-to-Peer synchronization via WebRTC RTCDataChannel
 *  - 1-Click Fast Pairing (via BroadcastChannel for 2 tabs on the same machine)
 *  - Manual SDP Token Exchange (for independent cross-device LAN operation without any server)
 *  - Last-Write-Wins (LWW) conflict resolution with Logical / Lamport Timestamp
 *  - Seamless offline-first fallback: CRUD operations update local state and broadcast via DataChannel
 */

const API_BASE         = '/api/tasks';
const POLL_INTERVAL_MS = 2500;

// WebRTC Configuration: Public Google STUN servers + LAN local host candidates
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// Application State
let tasks          = [];
let isInitialLoad  = true;
let isPolling      = false;
let isServerOnline = true;

// Logical / Lamport Timestamp Clock for Last-Write-Wins (LWW) Conflict Resolution
let lamportClock   = 0;

// WebRTC P2P State
let p2pConnection       = null;
let p2pChannel          = null;
let p2pSignalingChannel = null;
let p2pStatus           = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'

// DOM Elements - General
const taskForm        = document.getElementById('task-form');
const taskInput       = document.getElementById('task-title-input');
const loadingState    = document.getElementById('loading-state');
const refreshBtn      = document.getElementById('refresh-btn');
const toastContainer  = document.getElementById('toast-container');

// DOM Elements - Kanban Board
const listPending         = document.getElementById('list-pending');
const listCompleted       = document.getElementById('list-completed');
const dropzonePending     = document.getElementById('dropzone-pending');
const dropzoneCompleted   = document.getElementById('dropzone-completed');
const badgePendingCount   = document.getElementById('badge-pending-count');
const badgeCompletedCount = document.getElementById('badge-completed-count');
const emptyHintPending    = document.getElementById('empty-hint-pending');
const emptyHintCompleted  = document.getElementById('empty-hint-completed');

// DOM Elements - Network Bar & Online Panel
const clientNameEl     = document.getElementById('client-name');
const renameClientBtn  = document.getElementById('rename-client-btn');
const syncDot          = document.getElementById('sync-dot');
const syncText         = document.getElementById('sync-text');
const shareUrlText     = document.getElementById('share-url-text');
const copyShareUrlBtn  = document.getElementById('copy-share-url-btn');
const onlineCountEl    = document.getElementById('online-count');
const onlineAvatarsEl  = document.getElementById('online-avatars');

// DOM Elements - Statistics
const statTotal      = document.getElementById('stat-total');
const statPending    = document.getElementById('stat-pending');
const statCompleted  = document.getElementById('stat-completed');
const statPercent    = document.getElementById('stat-percent');
const progressBar    = document.getElementById('progress-bar');

// DOM Elements - Server Status
const statusIndicator = document.getElementById('status-indicator');
const statusText       = document.getElementById('status-text');

// DOM Elements - V4 P2P Controls & Modal
const p2pBadge          = document.getElementById('p2p-badge');
const p2pDot            = document.getElementById('p2p-dot');
const p2pText           = document.getElementById('p2p-text');
const btnOpenP2pModal   = document.getElementById('btn-open-p2p-modal');
const p2pModal          = document.getElementById('p2p-modal');
const btnCloseP2pModal  = document.getElementById('btn-close-p2p-modal');
const tabBtnFast        = document.getElementById('tab-btn-fast');
const tabBtnManual      = document.getElementById('tab-btn-manual');
const paneFast          = document.getElementById('pane-fast');
const paneManual        = document.getElementById('pane-manual');
const btnFastPair       = document.getElementById('btn-fast-pair');
const btnP2pDisconnect  = document.getElementById('btn-p2p-disconnect');
const p2pStatusDetails  = document.getElementById('p2p-status-details');

// DOM Elements - Manual SDP Token Exchange
const btnGenerateOffer  = document.getElementById('btn-generate-offer');
const offerSdpOutput    = document.getElementById('offer-sdp-output');
const btnCopyOffer      = document.getElementById('btn-copy-offer');
const offerSdpInput     = document.getElementById('offer-sdp-input');
const btnGenerateAnswer = document.getElementById('btn-generate-answer');
const answerSdpOutput   = document.getElementById('answer-sdp-output');
const btnCopyAnswer     = document.getElementById('btn-copy-answer');
const answerSdpInput    = document.getElementById('answer-sdp-input');
const btnAcceptAnswer   = document.getElementById('btn-accept-answer');

// =============================================================================
// Client identity
// =============================================================================

function initClientIdentity() {
  let clientName = sessionStorage.getItem('taskflow_client_name');
  if (!clientName) {
    const letters      = ['A', 'B', 'C', 'D', 'E', 'F'];
    const randomLetter = letters[Math.floor(Math.random() * letters.length)];
    const randomNum    = Math.floor(100 + Math.random() * 900);
    clientName = `Thiết bị ${randomLetter} (#${randomNum})`;
    sessionStorage.setItem('taskflow_client_name', clientName);
  }
  if (clientNameEl) clientNameEl.textContent = clientName;
  if (shareUrlText) shareUrlText.textContent = window.location.origin;
}

function getClientName() {
  return sessionStorage.getItem('taskflow_client_name') || 'Thiết bị';
}

if (renameClientBtn) {
  renameClientBtn.addEventListener('click', () => {
    const current = getClientName();
    const newName = prompt('Nhập tên đại diện cho thiết bị / trình duyệt này:', current);
    if (newName && newName.trim()) {
      sessionStorage.setItem('taskflow_client_name', newName.trim());
      if (clientNameEl) clientNameEl.textContent = newName.trim();
      showToast(`Đã đổi tên thiết bị thành: "${newName.trim()}"`, 'info');
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
// Toast & UI Alerts
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
    toast.style.opacity    = '0';
    toast.style.transform  = 'translateY(10px)';
    toast.style.transition = 'all 0.25s ease';
    setTimeout(() => toast.remove(), 250);
  }, 3500);
}

// =============================================================================
// Server Status & Online Panel
// =============================================================================

function setServerStatus(online, details = '') {
  isServerOnline = online;
  if (online) {
    statusIndicator.className = 'pulse-indicator connected';
    statusText.textContent    = details || 'SQLite Backend :8080 (Online)';
  } else {
    statusIndicator.className = 'pulse-indicator error';
    statusText.textContent    = details || 'Mất kết nối server (Offline)';
  }
}

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
// Version 4: WebRTC DataChannel P2P Manager
// =============================================================================

function updateP2PUI(status, label = '', details = '') {
  p2pStatus = status;
  if (!p2pDot || !p2pText) return;

  p2pDot.className = `p2p-dot ${status}`;
  if (status === 'connected') {
    p2pText.textContent = label || 'P2P: Trực tiếp (DataChannel) ✓';
    if (btnFastPair) btnFastPair.style.display = 'none';
    if (btnP2pDisconnect) btnP2pDisconnect.style.display = 'inline-flex';
    if (p2pStatusDetails) {
      p2pStatusDetails.textContent = details || '🟢 Đã kết nối WebRTC DataChannel! Đồng bộ trực tiếp không qua server.';
      p2pStatusDetails.style.color = '#c084fc';
    }
  } else if (status === 'connecting') {
    p2pText.textContent = label || 'P2P: Đang kết nối...';
    if (p2pStatusDetails) {
      p2pStatusDetails.textContent = details || '🟡 Đang trao đổi tín hiệu bắt tay WebRTC...';
      p2pStatusDetails.style.color = '#f59e0b';
    }
  } else {
    p2pText.textContent = label || 'P2P: Chưa kết nối';
    if (btnFastPair) {
      btnFastPair.style.display = 'inline-flex';
      btnFastPair.disabled = false;
      btnFastPair.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
        </svg>
        Bấm để ghép nối với Tab kia ngay
      `;
    }
    if (btnP2pDisconnect) btnP2pDisconnect.style.display = 'none';
    if (p2pStatusDetails) {
      p2pStatusDetails.textContent = details || '⚪ Trạng thái P2P: Sẵn sàng kết nối';
      p2pStatusDetails.style.color = '#cbd5e1';
    }
  }
}

/**
 * Configure events for an RTCDataChannel
 */
function setupDataChannel(channel) {
  channel.onopen = () => {
    console.log('[P2P] RTCDataChannel opened successfully');
    updateP2PUI('connected');
    showToast('🎉 Kênh P2P WebRTC đã kết nối trực tiếp! Sẵn sàng đồng bộ ngay cả khi tắt server.', 'success');

    // Synchronize current local task state upon initial P2P connection
    if (tasks.length > 0) {
      channel.send(JSON.stringify({
        type: 'initial_sync',
        data: tasks,
        lamport_ts: lamportClock,
        peer_id: getClientName()
      }));
    }
  };

  channel.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleP2PMessage(msg);
    } catch (err) {
      console.error('[P2P] Error parsing message:', err);
    }
  };

  channel.onclose = () => {
    console.warn('[P2P] RTCDataChannel closed');
    updateP2PUI('disconnected', 'P2P: Đã ngắt kết nối', '⚪ Kênh P2P đã đóng.');
  };

  channel.onerror = (err) => {
    console.error('[P2P] RTCDataChannel error:', err);
    updateP2PUI('disconnected', 'P2P: Lỗi kênh truyền', '❌ Lỗi kết nối P2P DataChannel');
  };
}

/**
 * Handle incoming P2P JSON events with Last-Write-Wins (LWW) Lamport Logical Clock
 */
function handleP2PMessage(msg) {
  if (!msg || !msg.type) return;

  // Advance local Lamport logical clock: L = max(local_L, remote_L) + 1
  const remoteLamport = msg.lamport_ts || 0;
  lamportClock = Math.max(lamportClock, remoteLamport) + 1;

  switch (msg.type) {
    case 'task_created': {
      const newTask = msg.data;
      if (!tasks.find(t => t.id === newTask.id)) {
        newTask.is_p2p = true;
        newTask.lamport_ts = remoteLamport;
        tasks.unshift(newTask);
        renderKanban();
        showToast(`📡 [P2P] Nhận task mới từ Peer: "${newTask.title}"`, 'success');
      }
      break;
    }

    case 'task_updated': {
      const updated = msg.data;
      const task = tasks.find(t => t.id === updated.id);
      if (task) {
        // Last-Write-Wins (LWW) check: compare Lamport timestamps
        const localLamport = task.lamport_ts || 0;
        const remoteWins   = remoteLamport > localLamport ||
          (remoteLamport === localLamport && (msg.peer_id || '') >= (task.peer_id || ''));

        if (remoteWins) {
          task.completed  = updated.completed;
          if (updated.title) task.title = updated.title;
          task.lamport_ts = remoteLamport;
          task.peer_id    = msg.peer_id;
          renderKanban();
          const statusText = updated.completed ? 'Hoàn thành' : 'Chưa hoàn thành';
          showToast(`📡 [P2P] Peer đã chuyển task #${task.id} sang "${statusText}"!`, 'info');
        } else {
          console.warn(`[LWW Conflict] Local update (ts:${localLamport}) wins over remote update (ts:${remoteLamport}) for task #${task.id}`);
        }
      }
      break;
    }

    case 'task_deleted': {
      const { deleted_id } = msg.data;
      const before = tasks.length;
      tasks = tasks.filter(t => t.id !== deleted_id);
      if (tasks.length !== before) {
        renderKanban();
        showToast(`📡 [P2P] Peer đã xóa task #${deleted_id}`, 'info');
      }
      break;
    }

    case 'initial_sync': {
      if (Array.isArray(msg.data)) {
        let mergedCount = 0;
        msg.data.forEach(remoteTask => {
          const local = tasks.find(t => t.id === remoteTask.id);
          if (!local) {
            tasks.push(remoteTask);
            mergedCount++;
          } else {
            // LWW comparison
            if ((remoteTask.lamport_ts || 0) > (local.lamport_ts || 0)) {
              local.completed  = remoteTask.completed;
              local.title      = remoteTask.title;
              local.lamport_ts = remoteTask.lamport_ts;
            }
          }
        });
        if (mergedCount > 0) {
          renderKanban();
          showToast(`📡 [P2P] Đã đồng bộ ${mergedCount} task từ Peer!`, 'info');
        }
      }
      break;
    }

    default:
      console.log('[P2P] Unknown message type:', msg);
  }
}

/**
 * Initialize BroadcastChannel for 1-Click Fast Pairing (Same machine / multi-tab)
 */
function initP2PSignaling() {
  if (typeof BroadcastChannel === 'undefined') return;

  p2pSignalingChannel = new BroadcastChannel('taskflow_p2p_channel');
  p2pSignalingChannel.onmessage = async (e) => {
    const msg = e.data;
    if (!msg || msg.from === getClientName()) return;

    if (msg.type === 'signal_offer') {
      console.log('[P2P Signal] Received Offer from', msg.from);
      updateP2PUI('connecting', 'P2P: Nhận yêu cầu...', `Đang bắt tay với ${msg.from}...`);

      if (p2pConnection) {
        try { p2pConnection.close(); } catch {}
      }

      p2pConnection = new RTCPeerConnection(RTC_CONFIG);
      p2pConnection.ondatachannel = (ev) => {
        p2pChannel = ev.channel;
        setupDataChannel(p2pChannel);
      };

      p2pConnection.onicecandidate = (ev) => {
        if (ev.candidate) {
          p2pSignalingChannel.postMessage({
            type: 'signal_ice',
            candidate: ev.candidate,
            from: getClientName()
          });
        }
      };

      await p2pConnection.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      const answer = await p2pConnection.createAnswer();
      await p2pConnection.setLocalDescription(answer);

      p2pSignalingChannel.postMessage({
        type: 'signal_answer',
        sdp: answer,
        from: getClientName()
      });
    } else if (msg.type === 'signal_answer') {
      console.log('[P2P Signal] Received Answer from', msg.from);
      if (p2pConnection && p2pConnection.signalingState !== 'stable') {
        await p2pConnection.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      }
    } else if (msg.type === 'signal_ice') {
      if (p2pConnection && p2pConnection.remoteDescription) {
        try {
          await p2pConnection.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } catch (err) {
          console.warn('[P2P] ICE candidate addition error:', err);
        }
      }
    }
  };
}

/**
 * 1-Click Fast Pair Trigger (Tab A Initiator)
 */
async function startFastPair() {
  try {
    updateP2PUI('connecting', 'P2P: Đang phát tín hiệu...', 'Đang gửi broadcast tìm peer trên trình duyệt...');

    if (p2pConnection) {
      try { p2pConnection.close(); } catch {}
    }

    p2pConnection = new RTCPeerConnection(RTC_CONFIG);
    p2pChannel = p2pConnection.createDataChannel('taskflow-p2p', { ordered: true });
    setupDataChannel(p2pChannel);

    p2pConnection.onicecandidate = (ev) => {
      if (ev.candidate && p2pSignalingChannel) {
        p2pSignalingChannel.postMessage({
          type: 'signal_ice',
          candidate: ev.candidate,
          from: getClientName()
        });
      }
    };

    const offer = await p2pConnection.createOffer();
    await p2pConnection.setLocalDescription(offer);

    p2pSignalingChannel.postMessage({
      type: 'signal_offer',
      sdp: offer,
      from: getClientName()
    });

    if (p2pStatusDetails) {
      p2pStatusDetails.textContent = 'Đã phát Offer! Mở Tab thứ hai hoặc bấm ghép nối để liên kết.';
    }
  } catch (err) {
    console.error('Fast pair error:', err);
    updateP2PUI('disconnected', 'P2P: Thất bại', 'Lỗi khi khởi tạo Fast Pair: ' + err.message);
  }
}

/**
 * Disconnect active P2P connection
 */
function disconnectP2P() {
  if (p2pChannel) {
    try { p2pChannel.close(); } catch {}
    p2pChannel = null;
  }
  if (p2pConnection) {
    try { p2pConnection.close(); } catch {}
    p2pConnection = null;
  }
  updateP2PUI('disconnected', 'P2P: Chưa kết nối', 'Đã ngắt kết nối P2P.');
  showToast('Đã ngắt kết nối P2P.', 'info');
}

// =============================================================================
// Manual SDP Token Exchange (For independent machines on LAN without server)
// =============================================================================

function encodeToken(obj) {
  return btoa(encodeURIComponent(JSON.stringify(obj)));
}

function decodeToken(str) {
  return JSON.parse(decodeURIComponent(atob(str.trim())));
}

async function generateManualOffer() {
  try {
    btnGenerateOffer.disabled = true;
    btnGenerateOffer.textContent = 'Đang thu thập ICE...';

    if (p2pConnection) {
      try { p2pConnection.close(); } catch {}
    }

    p2pConnection = new RTCPeerConnection(RTC_CONFIG);
    p2pChannel = p2pConnection.createDataChannel('taskflow-p2p', { ordered: true });
    setupDataChannel(p2pChannel);

    const offer = await p2pConnection.createOffer();
    await p2pConnection.setLocalDescription(offer);

    // Wait for ICE gathering to complete or timeout after 1.2s
    await new Promise(resolve => {
      if (p2pConnection.iceGatheringState === 'complete') resolve();
      const check = () => {
        if (p2pConnection.iceGatheringState === 'complete') {
          p2pConnection.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      };
      p2pConnection.addEventListener('icegatheringstatechange', check);
      setTimeout(resolve, 1200);
    });

    const token = encodeToken(p2pConnection.localDescription);
    offerSdpOutput.value = token;
    btnCopyOffer.disabled = false;
    btnGenerateOffer.textContent = 'Đã tạo mã Offer ✓';
    showToast('Đã tạo mã Offer! Hãy sao chép sang Máy B.', 'info');
  } catch (err) {
    console.error('Manual offer error:', err);
    showToast('Lỗi tạo Offer: ' + err.message, 'error');
    btnGenerateOffer.textContent = 'Tạo lại mã (Offer)';
  } finally {
    btnGenerateOffer.disabled = false;
  }
}

async function acceptManualOfferAndGenerateAnswer() {
  const token = offerSdpInput.value.trim();
  if (!token) {
    showToast('Vui lòng dán mã Offer từ Máy A trước!', 'error');
    return;
  }

  try {
    btnGenerateAnswer.disabled = true;
    btnGenerateAnswer.textContent = 'Đang thu thập ICE...';

    const desc = decodeToken(token);
    if (p2pConnection) {
      try { p2pConnection.close(); } catch {}
    }

    p2pConnection = new RTCPeerConnection(RTC_CONFIG);
    p2pConnection.ondatachannel = (e) => {
      p2pChannel = e.channel;
      setupDataChannel(p2pChannel);
    };

    await p2pConnection.setRemoteDescription(desc);
    const answer = await p2pConnection.createAnswer();
    await p2pConnection.setLocalDescription(answer);

    await new Promise(resolve => {
      if (p2pConnection.iceGatheringState === 'complete') resolve();
      const check = () => {
        if (p2pConnection.iceGatheringState === 'complete') {
          p2pConnection.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      };
      p2pConnection.addEventListener('icegatheringstatechange', check);
      setTimeout(resolve, 1200);
    });

    const answerToken = encodeToken(p2pConnection.localDescription);
    answerSdpOutput.value = answerToken;
    btnCopyAnswer.disabled = false;
    btnGenerateAnswer.textContent = 'Đã tạo mã Answer ✓';
    showToast('Đã tạo mã Answer! Hãy sao chép dán lại vào Máy A.', 'info');
  } catch (err) {
    console.error('Manual answer error:', err);
    showToast('Lỗi tạo Answer: ' + err.message, 'error');
    btnGenerateAnswer.textContent = 'Tạo lại mã (Answer)';
  } finally {
    btnGenerateAnswer.disabled = false;
  }
}

async function acceptManualAnswer() {
  const token = answerSdpInput.value.trim();
  if (!token) {
    showToast('Vui lòng dán mã Answer từ Máy B!', 'error');
    return;
  }

  try {
    const desc = decodeToken(token);
    if (!p2pConnection) throw new Error('Chưa khởi tạo Peer A!');
    await p2pConnection.setRemoteDescription(desc);
    showToast('Đang kết nối WebRTC DataChannel...', 'info');
  } catch (err) {
    console.error('Accept answer error:', err);
    showToast('Lỗi chấp nhận Answer: ' + err.message, 'error');
  }
}

function setupP2PModal() {
  if (btnOpenP2pModal && p2pModal) {
    btnOpenP2pModal.addEventListener('click', () => { p2pModal.style.display = 'flex'; });
  }
  if (btnCloseP2pModal && p2pModal) {
    btnCloseP2pModal.addEventListener('click', () => { p2pModal.style.display = 'none'; });
    p2pModal.addEventListener('click', (e) => {
      if (e.target === p2pModal) p2pModal.style.display = 'none';
    });
  }

  // Tabs
  if (tabBtnFast && tabBtnManual && paneFast && paneManual) {
    tabBtnFast.addEventListener('click', () => {
      tabBtnFast.classList.add('active');
      tabBtnManual.classList.remove('active');
      paneFast.style.display = 'block';
      paneManual.style.display = 'none';
    });

    tabBtnManual.addEventListener('click', () => {
      tabBtnManual.classList.add('active');
      tabBtnFast.classList.remove('active');
      paneManual.style.display = 'block';
      paneFast.style.display = 'none';
    });
  }

  // Fast pair action
  if (btnFastPair) btnFastPair.addEventListener('click', startFastPair);
  if (btnP2pDisconnect) btnP2pDisconnect.addEventListener('click', disconnectP2P);

  // Manual actions
  if (btnGenerateOffer) btnGenerateOffer.addEventListener('click', generateManualOffer);
  if (btnCopyOffer) {
    btnCopyOffer.addEventListener('click', async () => {
      await navigator.clipboard.writeText(offerSdpOutput.value);
      showToast('Đã sao chép mã Offer!', 'success');
    });
  }
  if (btnGenerateAnswer) btnGenerateAnswer.addEventListener('click', acceptManualOfferAndGenerateAnswer);
  if (btnCopyAnswer) {
    btnCopyAnswer.addEventListener('click', async () => {
      await navigator.clipboard.writeText(answerSdpOutput.value);
      showToast('Đã sao chép mã Answer!', 'success');
    });
  }
  if (btnAcceptAnswer) btnAcceptAnswer.addEventListener('click', acceptManualAnswer);
}

// =============================================================================
// CRUD Operations (Seamless Server & P2P Offline-First Routing)
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
    setServerStatus(true, 'SQLite Backend :8080 (Online)');

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
    console.warn('Lỗi nạp tasks từ server:', err.message);
    setServerStatus(false, 'Mất kết nối server');
    if (!silent && !p2pChannel) {
      showToast('Không thể kết nối C backend. Sử dụng dữ liệu cục bộ / P2P.', 'info');
    }
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
    let newTask = null;
    let savedViaServer = false;

    // 1. Try persisting via central server if online
    if (isServerOnline) {
      try {
        const res = await fetch(API_BASE, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
          body:    JSON.stringify({ title })
        });
        if (res.ok) {
          newTask = await res.json();
          savedViaServer = true;
        }
      } catch (netErr) {
        console.warn('Backend unreachable — falling back to P2P/Offline creation:', netErr.message);
        setServerStatus(false, 'Mất kết nối server');
      }
    }

    // 2. If server failed or offline, generate local offline/P2P task
    if (!newTask) {
      lamportClock++;
      newTask = {
        id: Date.now(),
        title: title,
        completed: false,
        created_at: Math.floor(Date.now() / 1000),
        lamport_ts: lamportClock,
        peer_id: getClientName(),
        is_p2p: true
      };
    } else {
      lamportClock++;
      newTask.lamport_ts = lamportClock;
      newTask.peer_id = getClientName();
    }

    // 3. Optimistic local insert & DOM render
    if (!tasks.find(t => t.id === newTask.id)) {
      tasks.unshift(newTask);
      renderKanban();
    }

    // 4. Send directly to peer via WebRTC DataChannel if connected
    if (p2pChannel && p2pChannel.readyState === 'open') {
      p2pChannel.send(JSON.stringify({
        type: 'task_created',
        data: newTask,
        lamport_ts: lamportClock,
        peer_id: getClientName()
      }));
    }

    taskInput.value = '';

    if (savedViaServer) {
      showToast(`Đã thêm task: "${newTask.title}"`, 'success');
    } else if (p2pChannel && p2pChannel.readyState === 'open') {
      showToast(`📡 [P2P] Đã tạo task và gửi trực tiếp cho Peer: "${newTask.title}"`, 'success');
    } else {
      showToast(`💾 [Offline] Đã tạo task cục bộ: "${newTask.title}"`, 'info');
    }
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

  // Advance Lamport Clock for mutation
  lamportClock++;
  task.completed  = newStatus;
  task.lamport_ts = lamportClock;
  task.peer_id    = getClientName();
  renderKanban();

  let savedViaServer = false;
  if (isServerOnline) {
    try {
      const res = await fetch(`${API_BASE}/${id}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
        body:    JSON.stringify({ completed: newStatus })
      });
      if (res.ok) savedViaServer = true;
    } catch (netErr) {
      console.warn('Backend unreachable during update, broadcasting via P2P:', netErr.message);
      setServerStatus(false, 'Mất kết nối server');
    }
  }

  // Send update via P2P DataChannel
  if (p2pChannel && p2pChannel.readyState === 'open') {
    p2pChannel.send(JSON.stringify({
      type: 'task_updated',
      data: { id: task.id, completed: newStatus, title: task.title },
      lamport_ts: lamportClock,
      peer_id: getClientName()
    }));
  }

  const statusLabel = newStatus ? 'Hoàn thành' : 'Chưa hoàn thành';
  if (savedViaServer) {
    showToast(`Đã chuyển task #${id} sang ${statusLabel}!`, 'info');
  } else if (p2pChannel && p2pChannel.readyState === 'open') {
    showToast(`📡 [P2P] Đã đổi trạng thái task #${id} và gửi trực tiếp cho Peer!`, 'info');
  } else {
    showToast(`💾 [Offline] Đã chuyển task #${id} sang ${statusLabel}!`, 'info');
  }
}

async function deleteTask(id) {
  const task      = tasks.find(t => t.id === id);
  const taskTitle = task ? task.title : `#${id}`;

  tasks = tasks.filter(t => t.id !== id);
  lamportClock++;
  renderKanban();

  let savedViaServer = false;
  if (isServerOnline) {
    try {
      const res = await fetch(`${API_BASE}/${id}`, {
        method:  'DELETE',
        headers: { 'ngrok-skip-browser-warning': 'true' }
      });
      if (res.ok) savedViaServer = true;
    } catch (netErr) {
      console.warn('Backend unreachable during delete, broadcasting via P2P:', netErr.message);
      setServerStatus(false, 'Mất kết nối server');
    }
  }

  // Send delete event via P2P DataChannel
  if (p2pChannel && p2pChannel.readyState === 'open') {
    p2pChannel.send(JSON.stringify({
      type: 'task_deleted',
      data: { deleted_id: id },
      lamport_ts: lamportClock,
      peer_id: getClientName()
    }));
  }

  if (savedViaServer) {
    showToast(`Đã xóa task: "${taskTitle}"`, 'info');
  } else if (p2pChannel && p2pChannel.readyState === 'open') {
    showToast(`📡 [P2P] Đã xóa task và thông báo cho Peer!`, 'info');
  } else {
    showToast(`💾 [Offline] Đã xóa task: "${taskTitle}"`, 'info');
  }
}

// =============================================================================
// SSE Real-time connection (Unchanged from V3.5)
// =============================================================================

let eventSource       = null;
let fallbackPollingId = null;

function connectSSE() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  const encodedName = encodeURIComponent(getClientName());
  const url         = `/api/events?name=${encodedName}`;

  eventSource = new EventSource(url);

  eventSource.addEventListener('task_created', (e) => {
    const task = JSON.parse(e.data);
    if (!tasks.find(t => t.id === task.id)) {
      tasks.unshift(task);
      renderKanban();
      showToast(`🆕 Task mới từ người dùng khác: "${task.title}"`, 'info');
    }
    updateSyncBadge();
  });

  eventSource.addEventListener('task_updated', (e) => {
    const updated = JSON.parse(e.data);
    const idx = tasks.findIndex(t => t.id === updated.id);
    if (idx >= 0) {
      tasks[idx] = updated;
      renderKanban();
    }
    updateSyncBadge();
  });

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

  eventSource.addEventListener('client_joined', (e) => {
    const data = JSON.parse(e.data);
    updateOnlineUsers(data);
    if (data.client_name !== getClientName()) {
      showToast(`👋 ${data.client_name} đã tham gia`, 'info');
    }
  });

  eventSource.addEventListener('client_left', (e) => {
    const data = JSON.parse(e.data);
    updateOnlineUsers(data);
    showToast(`👋 ${data.client_name} đã rời phòng`, 'info');
  });

  eventSource.onopen = () => {
    setServerStatus(true, 'SQLite Backend :8080 (SSE Connected ✓)');
    console.log('[SSE] Connected to /api/events');
    if (fallbackPollingId) {
      clearInterval(fallbackPollingId);
      fallbackPollingId = null;
    }
  };

  eventSource.onerror = () => {
    setServerStatus(false, 'Mất kết nối server');
    console.warn('[SSE] Connection error — server may be down');

    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }

    if (!fallbackPollingId) {
      fallbackPollingId = setInterval(() => loadTasks(true), POLL_INTERVAL_MS);
    }

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
// Kanban Rendering
// =============================================================================

function updateStats() {
  const total     = tasks.length;
  const completed = tasks.filter(t => t.completed).length;
  const pending   = total - completed;
  const pct       = total === 0 ? 0 : Math.round((completed / total) * 100);

  statTotal.textContent      = total;
  statPending.textContent    = pending;
  statCompleted.textContent  = completed;
  statPercent.textContent    = `${pct}%`;
  progressBar.style.width    = `${pct}%`;

  badgePendingCount.textContent   = pending;
  badgeCompletedCount.textContent = completed;

  emptyHintPending.style.display   = pending   === 0 ? 'block' : 'none';
  emptyHintCompleted.style.display = completed === 0 ? 'block' : 'none';
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

  const isP2P = Boolean(task.is_p2p);

  card.innerHTML = `
    <div class="kanban-card-header">
      <div class="kanban-card-meta">
        <span class="task-id-badge ${isP2P ? 'p2p' : ''}">#${task.id}${isP2P ? ' (P2P)' : ''}</span>
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
      const taskId       = parseInt(e.dataTransfer.getData('text/plain'), 10);
      const targetStatus = zone.dataset.targetStatus === 'true';
      if (taskId > 0) updateTaskStatus(taskId, targetStatus);
    });
  });
}

// =============================================================================
// Event Listeners & Startup Initialization
// =============================================================================

taskForm.addEventListener('submit', handleAddTask);
refreshBtn.addEventListener('click', () => {
  showToast('Đang làm mới dữ liệu...', 'info');
  loadTasks(false);
});

document.addEventListener('DOMContentLoaded', () => {
  initClientIdentity();
  setupDropzones();
  setupP2PModal();
  initP2PSignaling();
  loadTasks(true);
  connectSSE();
});
