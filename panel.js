// ==================== FlashFire BDA Attendance - Panel Logic ====================

import { API_URLS, API_BASE_URL } from './exports.js';

// ==================== DOM Elements ====================

const setupScreen = document.getElementById('setup-screen');
const otpScreen = document.getElementById('otp-screen');
const dashboardScreen = document.getElementById('dashboard-screen');

// Email step
const emailForm = document.getElementById('email-form');
const emailBtn = document.getElementById('email-btn');
const emailError = document.getElementById('email-error');
const emailInfo = document.getElementById('email-info');
const bdaEmailInput = document.getElementById('bda-email');

// OTP step
const otpForm = document.getElementById('otp-form');
const otpBtn = document.getElementById('otp-btn');
const otpError = document.getElementById('otp-error');
const otpInput = document.getElementById('otp-input');
const otpEmailDisplay = document.getElementById('otp-email-display');
const changeEmailBtn = document.getElementById('change-email-btn');
const resendOtpBtn = document.getElementById('resend-otp-btn');

// Name step
const nameScreen = document.getElementById('name-screen');
const nameForm = document.getElementById('name-form');
const nameBtn = document.getElementById('name-btn');
const nameError = document.getElementById('name-error');
const bdaNameInput = document.getElementById('bda-name-input');

// Dashboard
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
let pendingEmail = null; // email waiting for OTP verification

// ==================== Init ====================

async function init() {
  const auth = await sendMessage({ type: 'GET_AUTH' });
  if (auth?.token) {
    token = auth.token;
    bdaInfo = auth.bdaInfo;
    // Check if name is a placeholder (email local-part) — prompt for real name
    const emailLocal = bdaInfo?.email?.split('@')[0];
    const needsName = !bdaInfo?.name || bdaInfo.name === emailLocal;
    if (needsName) {
      showNameStep();
    } else {
      showDashboard();
    }
  } else {
    showEmailStep();
  }
}

// ==================== Auth Flow - Step 1: Email ====================

function showEmailStep() {
  setupScreen.style.display = 'flex';
  otpScreen.style.display = 'none';
  nameScreen.style.display = 'none';
  dashboardScreen.style.display = 'none';
  disconnectSSE();
  emailError.style.display = 'none';
  emailInfo.style.display = 'none';
}

// ==================== Auth Flow - Step 3: Name ====================

function showNameStep() {
  setupScreen.style.display = 'none';
  otpScreen.style.display = 'none';
  nameScreen.style.display = 'flex';
  dashboardScreen.style.display = 'none';
  nameError.style.display = 'none';
  bdaNameInput.value = '';
  bdaNameInput.focus();
}

nameForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = bdaNameInput.value.trim();
  if (!name || name.length < 2) return;

  nameBtn.disabled = true;
  nameBtn.innerHTML = '<span class="spinner"></span> Saving...';
  nameError.style.display = 'none';

  try {
    const res = await fetch(API_URLS.UPDATE_NAME, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name }),
    });

    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed to update name');

    // Update token and bdaInfo with new name
    token = data.token;
    bdaInfo = data.bda;

    await sendMessage({
      type: 'SET_AUTH',
      token: data.token,
      bdaInfo: data.bda,
    });

    showDashboard();
  } catch (err) {
    nameError.textContent = err.message;
    nameError.style.display = 'block';
  } finally {
    nameBtn.disabled = false;
    nameBtn.innerHTML = 'Continue';
  }
});

emailForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = bdaEmailInput.value.trim();
  if (!email) return;

  await requestOtp(email);
});

async function requestOtp(email) {
  emailBtn.disabled = true;
  emailBtn.innerHTML = '<span class="spinner"></span> Sending OTP...';
  emailError.style.display = 'none';
  emailInfo.style.display = 'none';

  try {
    const res = await fetch(API_URLS.REQUEST_OTP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Failed to send OTP');
    }

    pendingEmail = email;
    showOtpStep();
  } catch (err) {
    emailError.textContent = err.message;
    emailError.style.display = 'block';
  } finally {
    emailBtn.disabled = false;
    emailBtn.innerHTML = 'Send OTP';
  }
}

// ==================== Auth Flow - Step 2: OTP ====================

function showOtpStep() {
  setupScreen.style.display = 'none';
  otpScreen.style.display = 'flex';
  nameScreen.style.display = 'none';
  dashboardScreen.style.display = 'none';
  otpEmailDisplay.textContent = pendingEmail;
  otpInput.value = '';
  otpError.style.display = 'none';
  otpBtn.disabled = true;
  otpInput.focus();
}

// Enable verify button only when 6 digits entered
otpInput.addEventListener('input', () => {
  // Only allow digits
  otpInput.value = otpInput.value.replace(/\D/g, '');
  otpBtn.disabled = otpInput.value.length !== 6;
});

otpForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const otp = otpInput.value.trim();
  if (!otp || otp.length !== 6 || !pendingEmail) return;

  otpBtn.disabled = true;
  otpBtn.innerHTML = '<span class="spinner"></span> Verifying...';
  otpError.style.display = 'none';

  try {
    const res = await fetch(API_URLS.VERIFY_OTP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: pendingEmail, otp }),
    });

    const data = await res.json();

    if (!data.success) {
      throw new Error(data.error || 'Verification failed');
    }

    token = data.token;
    bdaInfo = data.bda;

    // Save to background
    await sendMessage({
      type: 'SET_AUTH',
      token: data.token,
      bdaInfo: data.bda,
    });

    pendingEmail = null;

    // Show name prompt if needed, otherwise go to dashboard
    if (data.needsName) {
      showNameStep();
    } else {
      showDashboard();
    }
  } catch (err) {
    otpError.textContent = err.message;
    otpError.style.display = 'block';
    otpInput.value = '';
    otpBtn.disabled = true;
    otpInput.focus();
  } finally {
    otpBtn.disabled = otpInput.value.length !== 6;
    otpBtn.innerHTML = 'Verify & Login';
  }
});

// Change email - go back to step 1
changeEmailBtn.addEventListener('click', () => {
  pendingEmail = null;
  showEmailStep();
});

// Resend OTP
resendOtpBtn.addEventListener('click', async () => {
  if (!pendingEmail) return;
  resendOtpBtn.disabled = true;
  resendOtpBtn.textContent = 'Sending...';
  otpError.style.display = 'none';

  try {
    const res = await fetch(API_URLS.REQUEST_OTP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: pendingEmail }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to resend');

    resendOtpBtn.textContent = 'OTP Sent!';
    otpInput.value = '';
    otpBtn.disabled = true;
    otpInput.focus();

    setTimeout(() => {
      resendOtpBtn.textContent = 'Resend OTP';
      resendOtpBtn.disabled = false;
    }, 3000);
  } catch (err) {
    otpError.textContent = err.message;
    otpError.style.display = 'block';
    resendOtpBtn.textContent = 'Resend OTP';
    resendOtpBtn.disabled = false;
  }
});

// ==================== Dashboard ====================

function showDashboard() {
  setupScreen.style.display = 'none';
  otpScreen.style.display = 'none';
  nameScreen.style.display = 'none';
  dashboardScreen.style.display = 'flex';

  if (bdaInfo) {
    const displayName =
      bdaInfo.name && String(bdaInfo.name).trim() ? String(bdaInfo.name).trim() : bdaInfo.email || '';
    bdaDisplayName.textContent = displayName;
    bdaDisplayEmail.textContent = bdaInfo.email || '';
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
  showEmailStep();
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

  // Upcoming — show only next 5 from current time
  const now = new Date();
  const upcomingFiltered = (meetings.upcoming || [])
    .filter((m) => new Date(m.scheduledStart) >= new Date(now.getTime() - 30 * 60 * 1000)) // include meetings started up to 30min ago
    .slice(0, 5);

  if (upcomingFiltered.length > 0) {
    upcomingContainer.innerHTML = upcomingFiltered
      .map((m) => renderMeetingCard(m, 'upcoming'))
      .join('');
  } else {
    upcomingContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📅</div>
        <p>No upcoming meetings</p>
      </div>`;
  }

  // Previous — show only last 5
  const previousFiltered = (meetings.previous || []).slice(-5);
  if (previousFiltered.length > 0) {
    previousContainer.innerHTML = previousFiltered
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
  document.querySelectorAll('.btn-end').forEach((btn) => {
    btn.addEventListener('click', handlePanelEndMeet);
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

  const inLiveWindow =
    now >= new Date(start.getTime() - 5 * 60 * 1000) &&
    now <= new Date(start.getTime() + 3 * 60 * 60 * 1000);
  const hasRecorded =
    meeting.attendance && ['present', 'manual'].includes(meeting.attendance.status);
  const canEnd = Boolean(hasRecorded && inLiveWindow);

  const meetUrl = meeting.googleMeetUrl || meeting.calendlyMeetLink || '';
  const meetAttr = meetUrl ? encodeURIComponent(meetUrl) : '';

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
            ? `<button type="button" class="btn-mark" data-booking-id="${meeting.bookingId}" data-client-name="${escapeHtml(meeting.clientName)}">Mark Present</button>`
            : ''
        }
        ${
          canEnd
            ? `<button type="button" class="btn-end" data-booking-id="${meeting.bookingId}" data-meet-link="${meetAttr}">End Meet</button>`
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

function newPanelEndRequestId() {
  return `ff_panel_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

async function handlePanelEndMeet(e) {
  const btn = e.target.closest('.btn-end');
  if (!btn) return;

  const bookingId = btn.dataset.bookingId;
  const meetAttr = btn.dataset.meetLink || '';
  const meetLink = meetAttr ? decodeURIComponent(meetAttr) : '';

  btn.disabled = true;
  btn.textContent = 'Ending...';

  const result = await sendMessage({
    type: 'PANEL_END_MEET',
    bookingId,
    meetLink: meetLink || undefined,
    requestId: newPanelEndRequestId(),
  });

  if (result?.success) {
    await loadMeetings(true);
    await loadEventLog();
  } else {
    btn.textContent = result?.error || 'Failed';
    setTimeout(() => {
      btn.textContent = 'End Meet';
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

  // Fallback: onopen fires when HTTP connection succeeds (even before named events)
  eventSource.onopen = () => {
    setConnectionStatus('connected');
    sseReconnectDelay = 1000;
  };

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

  eventSource.onerror = (e) => {
    console.error('[SSE] Connection error:', e);
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
