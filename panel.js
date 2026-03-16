// ==================== FlashFire BDA Attendance - Panel Logic ====================

import { API_URLS, API_BASE_URL } from './exports.js';

// ==================== DOM Elements ====================

const setupScreen = document.getElementById('setup-screen');
const dashboardScreen = document.getElementById('dashboard-screen');
const setupForm = document.getElementById('setup-form');
const setupBtn = document.getElementById('setup-btn');
const setupError = document.getElementById('setup-error');
const bdaNameInput = document.getElementById('bda-name');
const bdaEmailInput = document.getElementById('bda-email');
const bdaDisplayName = document.getElementById('bda-display-name');
const bdaDisplayEmail = document.getElementById('bda-display-email');
const logoutBtn = document.getElementById('logout-btn');
const upcomingContainer = document.getElementById('upcoming-meetings');
const previousContainer = document.getElementById('previous-meetings');
const eventLogList = document.getElementById('event-log-list');
const eventEmpty = document.getElementById('event-empty');
const connectionDot = document.getElementById('connection-dot');
const connectionStatus = document.getElementById('connection-status');
const refreshBtn = document.getElementById('refresh-btn');

// ==================== State ====================

let token = null;
let bdaInfo = null;
let meetings = null;
let eventSource = null;
let sseReconnectTimeout = null;
let sseReconnectDelay = 1000;

// ==================== Init ====================

async function init() {
  const auth = await sendMessage({ type: 'GET_AUTH' });
  if (auth?.token) {
    token = auth.token;
    bdaInfo = auth.bdaInfo;
    showDashboard();
  } else {
    showSetup();
  }
}

// ==================== Setup ====================

function showSetup() {
  setupScreen.style.display = 'flex';
  dashboardScreen.style.display = 'none';
  disconnectSSE();
}

setupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = bdaNameInput.value.trim();
  const email = bdaEmailInput.value.trim();

  if (!name || !email) return;

  setupBtn.disabled = true;
  setupBtn.innerHTML = '<span class="spinner"></span> Registering...';
  setupError.style.display = 'none';

  try {
    const res = await fetch(API_URLS.REGISTER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email }),
    });

    const data = await res.json();

    if (!data.success) {
      throw new Error(data.error || 'Registration failed');
    }

    token = data.token;
    bdaInfo = data.bda;

    // Save to background
    await sendMessage({
      type: 'SET_AUTH',
      token: data.token,
      bdaInfo: data.bda,
    });

    showDashboard();
  } catch (err) {
    setupError.textContent = err.message;
    setupError.style.display = 'block';
  } finally {
    setupBtn.disabled = false;
    setupBtn.innerHTML = 'Get Started';
  }
});

// ==================== Dashboard ====================

function showDashboard() {
  setupScreen.style.display = 'none';
  dashboardScreen.style.display = 'flex';

  if (bdaInfo) {
    bdaDisplayName.textContent = bdaInfo.name;
    bdaDisplayEmail.textContent = bdaInfo.email;
  }

  loadMeetings();
  loadEventLog();
  connectSSE();
}

logoutBtn.addEventListener('click', async () => {
  if (!confirm('Are you sure you want to logout?')) return;
  await sendMessage({ type: 'LOGOUT' });
  token = null;
  bdaInfo = null;
  meetings = null;
  showSetup();
});

refreshBtn.addEventListener('click', () => {
  loadMeetings(true);
  loadEventLog();
});

// ==================== Meetings ====================

async function loadMeetings(force = false) {
  const result = await sendMessage({ type: 'GET_MEETINGS', force });
  if (result?.meetings) {
    meetings = result.meetings;
    renderMeetings();
  }
}

function renderMeetings() {
  if (!meetings) return;

  // Upcoming
  if (meetings.upcoming && meetings.upcoming.length > 0) {
    upcomingContainer.innerHTML = meetings.upcoming
      .map((m) => renderMeetingCard(m, 'upcoming'))
      .join('');
  } else {
    upcomingContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📅</div>
        <p>No upcoming meetings</p>
      </div>`;
  }

  // Previous
  if (meetings.previous && meetings.previous.length > 0) {
    previousContainer.innerHTML = meetings.previous
      .map((m) => renderMeetingCard(m, 'previous'))
      .join('');
  } else {
    previousContainer.innerHTML = `
      <div class="empty-state">
        <p>No previous meetings</p>
      </div>`;
  }

  // Attach event listeners for manual mark buttons
  document.querySelectorAll('.btn-mark').forEach((btn) => {
    btn.addEventListener('click', handleManualMark);
  });
}

function renderMeetingCard(meeting, context) {
  const now = meetings?.serverTime ? new Date(meetings.serverTime) : new Date();
  const start = new Date(meeting.scheduledStart);
  const end = meeting.scheduledEnd ? new Date(meeting.scheduledEnd) : null;

  // Determine status
  let status = 'pending';
  let badgeText = 'Upcoming';
  let badgeClass = 'badge-pending';

  if (meeting.attendance) {
    switch (meeting.attendance.status) {
      case 'present':
        status = 'present';
        badgeText = meeting.attendance.source === 'auto' ? 'Present (Auto)' : 'Present';
        badgeClass = 'badge-present';
        break;
      case 'manual':
        status = 'manual';
        badgeText = 'Present (Manual)';
        badgeClass = 'badge-manual';
        break;
      case 'absent':
        status = 'absent';
        badgeText = 'Absent';
        badgeClass = 'badge-absent';
        break;
    }
  } else if (now >= new Date(start.getTime() - 2 * 60 * 1000) && now <= (end || new Date(start.getTime() + 30 * 60 * 1000))) {
    status = 'active';
    badgeText = 'Live Now';
    badgeClass = 'badge-active';
  } else if (now > start && context === 'previous') {
    status = 'pending';
    badgeText = 'No Data';
    badgeClass = 'badge-pending';
  }

  // Can mark manually?
  const canMark = !meeting.attendance && now >= start && now <= new Date(start.getTime() + 2 * 60 * 60 * 1000);

  const timeStr = formatDateTime(start);

  const claimedByStr = meeting.claimedBy
    ? `<div class="meeting-assigned">Assigned: ${escapeHtml(meeting.claimedBy.name || meeting.claimedBy.email)}</div>`
    : '';

  return `
    <div class="meeting-card status-${status}">
      <div class="meeting-client">${escapeHtml(meeting.clientName)}</div>
      <div class="meeting-time">${timeStr}</div>
      ${claimedByStr}
      <div class="meeting-meta">
        <span class="meeting-badge ${badgeClass}">${badgeText}</span>
        ${
          canMark
            ? `<button class="btn-mark" data-booking-id="${meeting.bookingId}" data-client-name="${escapeHtml(meeting.clientName)}">Mark Present</button>`
            : ''
        }
      </div>
    </div>`;
}

async function handleManualMark(e) {
  const btn = e.target;
  const bookingId = btn.dataset.bookingId;
  const clientName = btn.dataset.clientName;

  btn.disabled = true;
  btn.textContent = 'Marking...';

  const result = await sendMessage({
    type: 'MANUAL_MARK',
    bookingId,
    clientName,
  });

  if (result?.success) {
    await loadMeetings(true);
  } else {
    btn.textContent = result?.error || 'Failed';
    setTimeout(() => {
      btn.textContent = 'Mark Present';
      btn.disabled = false;
    }, 2000);
  }
}

// ==================== Event Log ====================

async function loadEventLog() {
  const result = await sendMessage({ type: 'GET_EVENT_LOG' });
  if (result?.log) {
    renderEventLog(result.log);
  }
}

function renderEventLog(log) {
  if (!log || log.length === 0) {
    eventLogList.innerHTML = `<div class="empty-state" id="event-empty"><p>No activity yet</p></div>`;
    return;
  }

  eventLogList.innerHTML = log
    .slice(0, 20)
    .map((entry) => {
      const icons = {
        join: '&#x2705;',
        leave: '&#x1F6AA;',
        absent: '&#x274C;',
        manual: '&#x270B;',
        absent_check: '&#x26A0;',
      };

      const texts = {
        join: `Joined meeting for <strong>${escapeHtml(entry.clientName || '')}</strong>`,
        leave: `Left meeting for <strong>${escapeHtml(entry.clientName || '')}</strong>`,
        absent: `Marked absent for <strong>${escapeHtml(entry.clientName || '')}</strong>`,
        manual: `Manually marked present for <strong>${escapeHtml(entry.clientName || '')}</strong>`,
        absent_check: `Attendance check for <strong>${escapeHtml(entry.clientName || '')}</strong>`,
      };

      return `
        <div class="event-item">
          <div class="event-icon ${entry.type}">${icons[entry.type] || '&#x1F4CB;'}</div>
          <div class="event-details">
            <div class="event-text">${texts[entry.type] || entry.type}</div>
            <div class="event-time">${formatTime(entry.timestamp)}</div>
          </div>
        </div>`;
    })
    .join('');
}

// ==================== SSE ====================

function connectSSE() {
  if (!token) return;
  disconnectSSE();

  const url = `${API_URLS.SSE}?token=${encodeURIComponent(token)}`;
  eventSource = new EventSource(url);

  eventSource.addEventListener('connected', () => {
    setConnectionStatus('connected');
    sseReconnectDelay = 1000;
  });

  eventSource.addEventListener('heartbeat', () => {
    setConnectionStatus('connected');
  });

  eventSource.addEventListener('meeting_update', () => {
    loadMeetings(true);
  });

  eventSource.addEventListener('attendance_update', () => {
    loadMeetings(true);
    loadEventLog();
  });

  eventSource.onerror = () => {
    setConnectionStatus('disconnected');
    disconnectSSE();

    // Reconnect with backoff
    sseReconnectTimeout = setTimeout(() => {
      connectSSE();
    }, sseReconnectDelay);
    sseReconnectDelay = Math.min(sseReconnectDelay * 2, 30000);
  };

  setConnectionStatus('connecting');
}

function disconnectSSE() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  if (sseReconnectTimeout) {
    clearTimeout(sseReconnectTimeout);
    sseReconnectTimeout = null;
  }
}

function setConnectionStatus(status) {
  connectionDot.className = `connection-dot ${status}`;
  const labels = {
    connected: 'Connected',
    disconnected: 'Disconnected',
    connecting: 'Connecting...',
  };
  connectionStatus.textContent = labels[status] || status;
}

// ==================== Listen for background messages ====================

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'MEETINGS_UPDATE') {
    meetings = message.data;
    renderMeetings();
  }
  if (message.type === 'EVENT_LOG_UPDATE') {
    loadEventLog();
  }
});

// ==================== Utilities ====================

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      resolve(response);
    });
  });
}

function formatDateTime(date) {
  if (!date) return 'N/A';
  const d = new Date(date);
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatTime(date) {
  if (!date) return '';
  const d = new Date(date);
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ==================== Start ====================

init();
