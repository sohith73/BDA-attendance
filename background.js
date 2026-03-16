// ==================== FlashFire BDA Attendance - Background Service Worker ====================

const API_BASE_URL = 'http://localhost:5000';
// const API_BASE_URL = 'https://your-production-api.com';

const API = {
  MY_MEETINGS: `${API_BASE_URL}/api/bda-attendance/my-meetings`,
  REPORT_JOIN: `${API_BASE_URL}/api/bda-attendance/report-join`,
  REPORT_LEAVE: `${API_BASE_URL}/api/bda-attendance/report-leave`,
  MARK_ABSENT: `${API_BASE_URL}/api/bda-attendance/mark-absent`,
  MANUAL_MARK: `${API_BASE_URL}/api/bda-attendance/manual-mark`,
};

// ==================== In-Memory Cache (rebuilt from storage on wake) ====================

let token = null;
let bdaInfo = null;
let meetings = null;
let meetingsLastFetched = 0;
const MEETINGS_CACHE_MS = 5 * 60 * 1000;

// Runtime map rebuilt from chrome.storage.local on each wake
// Key: bookingId, Value: { tabId, meetCode, joinedAt, reported, leaveReported }
let trackedMeetings = {};

// ==================== Storage Helpers ====================

// Load tracked meetings from persistent storage
async function loadTrackedState() {
  const data = await chrome.storage.local.get(['bda_tracked_meetings']);
  trackedMeetings = data.bda_tracked_meetings || {};
}

// Save tracked meetings to persistent storage
async function saveTrackedState() {
  await chrome.storage.local.set({ bda_tracked_meetings: trackedMeetings });
}

// Mark a booking as handled (join reported, absent marked, etc.) - persists across restarts
async function setTracked(bookingId, state) {
  trackedMeetings[bookingId] = { ...(trackedMeetings[bookingId] || {}), ...state };
  await saveTrackedState();
}

// Check if a booking is already handled
function isHandled(bookingId) {
  const t = trackedMeetings[bookingId];
  return t && t.reported;
}

// ==================== Auth ====================

async function loadAuth() {
  const data = await chrome.storage.local.get(['bda_token', 'bda_info', 'bda_expires_at']);
  if (data.bda_token && data.bda_expires_at) {
    if (Date.now() < data.bda_expires_at) {
      token = data.bda_token;
      bdaInfo = data.bda_info;
      return true;
    }
    await chrome.storage.local.remove(['bda_token', 'bda_info', 'bda_expires_at']);
  }
  token = null;
  bdaInfo = null;
  return false;
}

// ==================== API ====================

async function apiFetch(url, options = {}) {
  if (!token) return null;
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      console.warn(`[BDA-BG] API error: ${res.status} ${url}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`[BDA-BG] Fetch error: ${url}`, err.message);
    return null;
  }
}

async function fetchMeetings(force = false) {
  if (!token) return;
  if (!force && meetings && Date.now() - meetingsLastFetched < MEETINGS_CACHE_MS) return;

  const data = await apiFetch(API.MY_MEETINGS);
  if (data?.success) {
    meetings = data;
    meetingsLastFetched = Date.now();
    broadcastToPanel({ type: 'MEETINGS_UPDATE', data: meetings });
  }
}

// ==================== Utilities ====================

function extractMeetCode(url) {
  if (!url) return null;
  // Match standard meet codes: abc-defg-hij
  const match = url.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/);
  if (match) return match[1];
  // Also match meet codes with query params or different formats
  const match2 = url.match(/meet\.google\.com\/([a-zA-Z0-9-]+)/);
  return match2 ? match2[1].toLowerCase() : null;
}

function doesMeetMatchBooking(tabMeetCode, booking) {
  if (!tabMeetCode) return false;
  if (booking.googleMeetCode && tabMeetCode === booking.googleMeetCode.toLowerCase()) return true;
  if (booking.googleMeetUrl && booking.googleMeetUrl.toLowerCase().includes(tabMeetCode)) return true;
  if (booking.calendlyMeetLink && booking.calendlyMeetLink.toLowerCase().includes(tabMeetCode)) return true;
  return false;
}

function getServerTime() {
  if (meetings?.serverTime) {
    const serverOffset = new Date(meetings.serverTime).getTime() - meetingsLastFetched;
    return new Date(Date.now() + serverOffset);
  }
  return new Date();
}

function broadcastToPanel(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

function addEventLog(entry) {
  chrome.storage.local.get(['bda_event_log'], (result) => {
    const log = result.bda_event_log || [];
    log.unshift({ ...entry, timestamp: new Date().toISOString() });
    chrome.storage.local.set({ bda_event_log: log.slice(0, 50) });
    broadcastToPanel({ type: 'EVENT_LOG_UPDATE', entry: { ...entry, timestamp: new Date().toISOString() } });
  });
}

// Check if a meeting already has ANY attendance status from server
function hasServerAttendance(meeting) {
  return meeting.attendance && ['present', 'manual', 'absent'].includes(meeting.attendance.status);
}

// ==================== Core Meeting Check Logic ====================

async function checkMeetings() {
  const hasAuth = await loadAuth();
  if (!hasAuth) return;

  // Restore tracked state from storage (survives service worker restarts)
  await loadTrackedState();
  await fetchMeetings();

  if (!meetings) return;

  const allMeetings = [...(meetings.upcoming || []), ...(meetings.previous || [])];
  const now = getServerTime();
  const nowMs = now.getTime();

  // Clean up old tracked entries (meetings older than 3 hours)
  const threeHoursAgo = nowMs - 3 * 60 * 60 * 1000;
  let cleanupNeeded = false;
  for (const bookingId of Object.keys(trackedMeetings)) {
    const meeting = allMeetings.find((m) => m.bookingId === bookingId);
    if (!meeting) {
      // Meeting no longer in list, check age
      const tracked = trackedMeetings[bookingId];
      if (tracked.trackedAt && tracked.trackedAt < threeHoursAgo) {
        delete trackedMeetings[bookingId];
        cleanupNeeded = true;
      }
    }
  }
  if (cleanupNeeded) await saveTrackedState();

  // Count active meetings (within window, not yet handled)
  const activeMeetings = allMeetings.filter((m) => {
    const startMs = new Date(m.scheduledStart).getTime();
    return nowMs >= startMs - 2 * 60 * 1000 && nowMs <= startMs + 2 * 60 * 60 * 1000 && !hasServerAttendance(m) && !isHandled(m.bookingId);
  });

  for (const meeting of allMeetings) {
    const startMs = new Date(meeting.scheduledStart).getTime();
    const bookingId = meeting.bookingId;

    // ---- Skip if server already has attendance (present, manual, OR absent) ----
    if (hasServerAttendance(meeting)) {
      // Mark as handled locally so we don't process it again
      if (!isHandled(bookingId)) {
        await setTracked(bookingId, { reported: true, leaveReported: true, trackedAt: nowMs });
      }
      // Clear any pending alarm/notification for this meeting
      chrome.alarms.clear(`absent-check-${bookingId}`);
      chrome.notifications.clear(`attend-${bookingId}`);
      continue;
    }

    // ---- Skip if we already handled it locally ----
    if (isHandled(bookingId)) continue;

    // ---- Only process meetings within the active window (2 min before start to 2 hrs after) ----
    if (nowMs < startMs - 2 * 60 * 1000 || nowMs > startMs + 2 * 60 * 60 * 1000) continue;

    // ---- Try to find matching Meet tab ----
    try {
      const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });

      for (const tab of tabs) {
        const tabMeetCode = extractMeetCode(tab.url);

        // Match by meet code, OR if there's only 1 active meeting and 1 meet tab (auto-match)
        const isMatch =
          doesMeetMatchBooking(tabMeetCode, meeting) ||
          (activeMeetings.length === 1 && tabs.length === 1 && activeMeetings[0].bookingId === bookingId);

        if (isMatch) {
          const joinData = {
            bookingId,
            meetLink: tab.url,
            joinedAt: new Date().toISOString(),
          };

          const result = await apiFetch(API.REPORT_JOIN, {
            method: 'POST',
            body: JSON.stringify(joinData),
          });

          if (result?.success) {
            await setTracked(bookingId, {
              meetCode: tabMeetCode,
              tabId: tab.id,
              reported: true,
              joinedAt: Date.now(),
              leaveReported: false,
              trackedAt: nowMs,
            });

            addEventLog({
              type: 'join',
              bookingId,
              clientName: meeting.clientName,
              meetLink: tab.url,
            });

            // Clear any pending absent alarm/notification
            chrome.alarms.clear(`absent-check-${bookingId}`);
            chrome.notifications.clear(`attend-${bookingId}`);

            await fetchMeetings(true);
          }
          break;
        }
      }
    } catch (err) {
      console.error('[BDA-BG] Tab query error:', err.message);
    }

    // ---- 5-minute absent check (only once per meeting) ----
    if (nowMs >= startMs + 5 * 60 * 1000 && !isHandled(bookingId)) {
      // Check if we already sent a notification for this meeting
      const notifKey = `bda_notified_${bookingId}`;
      const notifData = await chrome.storage.local.get([notifKey]);

      if (!notifData[notifKey]) {
        // Mark that we've notified for this meeting (persists across restarts)
        await chrome.storage.local.set({ [notifKey]: Date.now() });

        chrome.notifications.create(`attend-${bookingId}`, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: 'Meeting Attendance Check',
          message: `Are you in the meeting for ${meeting.clientName}? Open the extension to mark attendance.`,
          priority: 2,
          requireInteraction: true,
        });

        // Set alarm for final absent mark (60 seconds from now)
        chrome.alarms.create(`absent-check-${bookingId}`, { delayInMinutes: 1 });

        addEventLog({
          type: 'absent_check',
          bookingId,
          clientName: meeting.clientName,
        });
      }
    }
  }

  // ---- Check tracked meetings for tab closure (leave detection) ----
  for (const bookingId of Object.keys(trackedMeetings)) {
    const tracked = trackedMeetings[bookingId];
    if (!tracked.reported || tracked.leaveReported || !tracked.tabId) continue;

    try {
      const tab = await chrome.tabs.get(tracked.tabId).catch(() => null);
      if (!tab || !tab.url || !tab.url.includes('meet.google.com')) {
        await reportLeave(bookingId);
      }
    } catch {
      await reportLeave(bookingId);
    }
  }
}

// ==================== Leave Reporting ====================

async function reportLeave(bookingId) {
  const tracked = trackedMeetings[bookingId];
  if (!tracked || tracked.leaveReported) return;

  await setTracked(bookingId, { leaveReported: true });

  const result = await apiFetch(API.REPORT_LEAVE, {
    method: 'POST',
    body: JSON.stringify({
      bookingId,
      leftAt: new Date().toISOString(),
    }),
  });

  if (result?.success) {
    const allMeetings = [...(meetings?.upcoming || []), ...(meetings?.previous || [])];
    const meeting = allMeetings.find((m) => m.bookingId === bookingId);

    addEventLog({
      type: 'leave',
      bookingId,
      clientName: meeting?.clientName || 'Unknown',
    });

    await fetchMeetings(true);
  }
}

// ==================== Alarm Handlers ====================

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'check-meetings') {
    await checkMeetings();
    return;
  }

  if (alarm.name.startsWith('absent-check-')) {
    const bookingId = alarm.name.replace('absent-check-', '');

    // Reload state in case service worker restarted
    await loadTrackedState();

    // If already handled (user joined or manually marked), skip
    if (isHandled(bookingId)) {
      chrome.notifications.clear(`attend-${bookingId}`);
      return;
    }

    // Re-fetch meetings to check if server already marked it
    await loadAuth();
    await fetchMeetings(true);

    const allMeetings = [...(meetings?.upcoming || []), ...(meetings?.previous || [])];
    const meeting = allMeetings.find((m) => m.bookingId === bookingId);

    // If server already has attendance, don't mark absent again
    if (meeting && hasServerAttendance(meeting)) {
      await setTracked(bookingId, { reported: true, leaveReported: true, trackedAt: Date.now() });
      chrome.notifications.clear(`attend-${bookingId}`);
      return;
    }

    // Still no attendance - mark absent via API
    const result = await apiFetch(API.MARK_ABSENT, {
      method: 'POST',
      body: JSON.stringify({
        bookingId,
        reason: 'no_response_to_popup',
      }),
    });

    if (result?.success) {
      addEventLog({
        type: 'absent',
        bookingId,
        clientName: meeting?.clientName || 'Unknown',
      });

      await setTracked(bookingId, { reported: true, leaveReported: true, trackedAt: Date.now() });
      await fetchMeetings(true);
    }

    chrome.notifications.clear(`attend-${bookingId}`);
  }
});

// ==================== Tab Monitoring ====================

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await loadTrackedState();
  for (const bookingId of Object.keys(trackedMeetings)) {
    const tracked = trackedMeetings[bookingId];
    if (tracked.tabId === tabId && tracked.reported && !tracked.leaveReported) {
      await reportLeave(bookingId);
      break;
    }
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  await loadTrackedState();
  for (const bookingId of Object.keys(trackedMeetings)) {
    const tracked = trackedMeetings[bookingId];
    if (
      tracked.tabId === tabId &&
      tracked.reported &&
      !tracked.leaveReported &&
      !changeInfo.url.includes('meet.google.com')
    ) {
      await reportLeave(bookingId);
      break;
    }
  }
});

// ==================== Notification Click ====================

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId.startsWith('attend-')) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'togglePanel' }).catch(() => {});
      }
    });
  }
});

// ==================== Extension Icon Click ====================

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'togglePanel' });
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      });
      setTimeout(() => {
        chrome.tabs.sendMessage(tab.id, { action: 'togglePanel' }).catch(() => {});
      }, 300);
    } catch (err) {
      console.error('[BDA-BG] Cannot inject content script:', err.message);
    }
  }
});

// ==================== Message Handlers (from panel) ====================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_AUTH') {
    chrome.storage.local.get(['bda_token', 'bda_info', 'bda_expires_at'], (data) => {
      sendResponse({
        token: data.bda_token || null,
        bdaInfo: data.bda_info || null,
        expiresAt: data.bda_expires_at || null,
      });
    });
    return true;
  }

  if (message.type === 'SET_AUTH') {
    token = message.token;
    bdaInfo = message.bdaInfo;
    const expiresAt = Date.now() + 90 * 24 * 60 * 60 * 1000;
    chrome.storage.local.set({
      bda_token: message.token,
      bda_info: message.bdaInfo,
      bda_expires_at: expiresAt,
    });
    checkMeetings();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'LOGOUT') {
    token = null;
    bdaInfo = null;
    meetings = null;
    trackedMeetings = {};
    // Clear all tracked state and notification flags
    chrome.storage.local.get(null, (allData) => {
      const keysToRemove = Object.keys(allData).filter(
        (k) => k.startsWith('bda_') || k.startsWith('bda_notified_')
      );
      chrome.storage.local.remove(keysToRemove);
    });
    chrome.alarms.clearAll();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'GET_MEETINGS') {
    (async () => {
      await loadAuth();
      await fetchMeetings(message.force);
      sendResponse({ meetings });
    })();
    return true;
  }

  if (message.type === 'GET_EVENT_LOG') {
    chrome.storage.local.get(['bda_event_log'], (result) => {
      sendResponse({ log: result.bda_event_log || [] });
    });
    return true;
  }

  if (message.type === 'MANUAL_MARK') {
    (async () => {
      await loadAuth();
      await loadTrackedState();
      const result = await apiFetch(API.MANUAL_MARK, {
        method: 'POST',
        body: JSON.stringify({ bookingId: message.bookingId }),
      });
      if (result?.success) {
        await setTracked(message.bookingId, { reported: true, leaveReported: false, trackedAt: Date.now() });

        // Clear any pending absent alarm/notification
        chrome.alarms.clear(`absent-check-${message.bookingId}`);
        chrome.notifications.clear(`attend-${message.bookingId}`);

        addEventLog({
          type: 'manual',
          bookingId: message.bookingId,
          clientName: message.clientName || 'Unknown',
        });
        await fetchMeetings(true);
      }
      sendResponse(result || { success: false, error: 'Failed to mark attendance' });
    })();
    return true;
  }
});

// ==================== Startup ====================

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('check-meetings', { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create('check-meetings', { periodInMinutes: 1 });
  await checkMeetings();
});

// Initial check on service worker load
(async () => {
  const hasAuth = await loadAuth();
  if (hasAuth) {
    chrome.alarms.create('check-meetings', { periodInMinutes: 1 });
    await checkMeetings();
  }
})();
