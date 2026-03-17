// ==================== FlashFire BDA Attendance - Background Service Worker ====================

import { API_URLS } from './exports.js';

const API = {
  MY_MEETINGS: API_URLS.MY_MEETINGS,
  REPORT_JOIN: API_URLS.REPORT_JOIN,
  REPORT_LEAVE: API_URLS.REPORT_LEAVE,
  MARK_ABSENT: API_URLS.MARK_ABSENT,
  MANUAL_MARK: API_URLS.MANUAL_MARK,
};

// ==================== In-Memory Cache (rebuilt from storage on wake) ====================

let token = null;
let bdaInfo = null;
let meetings = null;
let meetingsLastFetched = 0;
const MEETINGS_CACHE_MS = 60 * 1000; // 1 minute - refresh often for accurate detection

// Runtime map rebuilt from chrome.storage.local on each wake
let trackedMeetings = {};

// ==================== Storage Helpers ====================

async function loadTrackedState() {
  const data = await chrome.storage.local.get(['bda_tracked_meetings']);
  trackedMeetings = data.bda_tracked_meetings || {};
}

async function saveTrackedState() {
  await chrome.storage.local.set({ bda_tracked_meetings: trackedMeetings });
}

async function setTracked(bookingId, state) {
  trackedMeetings[bookingId] = { ...(trackedMeetings[bookingId] || {}), ...state };
  await saveTrackedState();
}

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
  // Also match other formats
  const match2 = url.match(/meet\.google\.com\/([a-zA-Z0-9_-]+)/);
  return match2 ? match2[1].toLowerCase() : null;
}

function doesMeetMatchBooking(tabMeetCode, booking) {
  if (!tabMeetCode) return false;
  const code = tabMeetCode.toLowerCase();
  if (booking.googleMeetCode && code === booking.googleMeetCode.toLowerCase()) return true;
  if (booking.googleMeetUrl && booking.googleMeetUrl.toLowerCase().includes(code)) return true;
  if (booking.calendlyMeetLink && booking.calendlyMeetLink.toLowerCase().includes(code)) return true;
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

function hasServerAttendance(meeting) {
  return meeting.attendance && ['present', 'manual', 'absent'].includes(meeting.attendance.status);
}

// ==================== Core Meeting Check Logic ====================

async function checkMeetings() {
  const hasAuth = await loadAuth();
  if (!hasAuth) return;

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
    const tracked = trackedMeetings[bookingId];
    if (tracked.trackedAt && tracked.trackedAt < threeHoursAgo) {
      delete trackedMeetings[bookingId];
      cleanupNeeded = true;
    }
  }
  if (cleanupNeeded) await saveTrackedState();

  // Get all active (within window) unhandled meetings
  const activeMeetings = allMeetings.filter((m) => {
    const startMs = new Date(m.scheduledStart).getTime();
    return nowMs >= startMs - 2 * 60 * 1000 && nowMs <= startMs + 2 * 60 * 60 * 1000 && !hasServerAttendance(m) && !isHandled(m.bookingId);
  });

  // Get all Google Meet tabs ONCE
  let meetTabs = [];
  try {
    meetTabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
    // Filter out meet landing/home pages - only actual meeting tabs
    meetTabs = meetTabs.filter((t) => {
      const code = extractMeetCode(t.url);
      return code && code.length >= 3; // has a real meeting code
    });
  } catch (err) {
    console.error('[BDA-BG] Tab query error:', err.message);
  }

  console.log(`[BDA-BG] Check: ${allMeetings.length} meetings, ${activeMeetings.length} active, ${meetTabs.length} meet tabs`);

  for (const meeting of allMeetings) {
    const startMs = new Date(meeting.scheduledStart).getTime();
    const bookingId = meeting.bookingId;

    // ---- Skip if server already has attendance ----
    if (hasServerAttendance(meeting)) {
      if (!isHandled(bookingId)) {
        await setTracked(bookingId, { reported: true, leaveReported: true, trackedAt: nowMs });
      }
      chrome.alarms.clear(`absent-check-${bookingId}`);
      chrome.alarms.clear(`warning-${bookingId}`);
      chrome.notifications.clear(`attend-${bookingId}`);
      continue;
    }

    if (isHandled(bookingId)) continue;

    // ---- Only process meetings within the active window ----
    if (nowMs < startMs - 2 * 60 * 1000 || nowMs > startMs + 2 * 60 * 60 * 1000) continue;

    // ---- Try to find matching Meet tab ----
    if (meetTabs.length > 0) {
      let matchedTab = null;

      // Strategy 1: Direct code match against booking meet fields
      for (const tab of meetTabs) {
        const tabMeetCode = extractMeetCode(tab.url);
        if (doesMeetMatchBooking(tabMeetCode, meeting)) {
          matchedTab = tab;
          break;
        }
      }

      // Strategy 2: If only 1 active meeting and 1 meet tab, auto-match
      if (!matchedTab && activeMeetings.length === 1 && meetTabs.length === 1 && activeMeetings[0].bookingId === bookingId) {
        matchedTab = meetTabs[0];
        console.log(`[BDA-BG] Auto-match: 1 active meeting + 1 meet tab -> ${bookingId}`);
      }

      // Strategy 3: If only 1 active meeting and ANY meet tabs exist, pick the first one
      // (handles case where booking has no meet code stored but BDA is in a meet)
      if (!matchedTab && activeMeetings.length === 1 && meetTabs.length > 0 && activeMeetings[0].bookingId === bookingId) {
        matchedTab = meetTabs[0];
        console.log(`[BDA-BG] Fallback match: 1 active meeting + meet tab open -> ${bookingId}`);
      }

      if (matchedTab) {
        const tabMeetCode = extractMeetCode(matchedTab.url);

        const joinData = {
          bookingId,
          meetLink: matchedTab.url,
          joinedAt: new Date().toISOString(),
        };

        const result = await apiFetch(API.REPORT_JOIN, {
          method: 'POST',
          body: JSON.stringify(joinData),
        });

        if (result?.success) {
          await setTracked(bookingId, {
            meetCode: tabMeetCode,
            tabId: matchedTab.id,
            reported: true,
            joinedAt: Date.now(),
            leaveReported: false,
            trackedAt: nowMs,
          });

          addEventLog({
            type: 'join',
            bookingId,
            clientName: meeting.clientName,
            meetLink: matchedTab.url,
          });

          // Clear any pending absent/warning alarms
          chrome.alarms.clear(`absent-check-${bookingId}`);
          chrome.alarms.clear(`warning-${bookingId}`);
          chrome.notifications.clear(`attend-${bookingId}`);

          await fetchMeetings(true);

          // Notify Meet content script that attendance is confirmed
          try {
            chrome.tabs.sendMessage(matchedTab.id, {
              type: 'MEET_ATTENDANCE_CONFIRMED',
              bookingId,
            }).catch(() => {});
          } catch {}

          // Also send booking info to the meet tab widget
          try {
            chrome.tabs.sendMessage(matchedTab.id, {
              type: 'MEET_BOOKING_INFO',
              bookingId,
              clientName: meeting.clientName,
            }).catch(() => {});
          } catch {}

          console.log(`[BDA-BG] AUTO JOIN reported for ${bookingId} via ${matchedTab.url}`);
        }
        continue; // Move to next meeting
      }
    }

    // ---- 2-minute warning: BDA not in meet, send Discord reminder ----
    if (nowMs >= startMs + 2 * 60 * 1000 && !isHandled(bookingId)) {
      const warnKey = `bda_warned_${bookingId}`;
      const warnData = await chrome.storage.local.get([warnKey]);

      if (!warnData[warnKey]) {
        await chrome.storage.local.set({ [warnKey]: Date.now() });

        // Send warning to present webhook
        const warnResult = await apiFetch(API.REPORT_JOIN.replace('/report-join', '/warn-absent'), {
          method: 'POST',
          body: JSON.stringify({ bookingId }),
        }).catch(() => null);

        // If no special endpoint, we'll handle this in the absent check below
        console.log(`[BDA-BG] 2-min warning for ${bookingId}`);
      }
    }

    // ---- 1-minute absent check popup (changed from 5 min) ----
    if (nowMs >= startMs + 1 * 60 * 1000 && !isHandled(bookingId)) {
      const notifKey = `bda_notified_${bookingId}`;
      const notifData = await chrome.storage.local.get([notifKey]);

      if (!notifData[notifKey]) {
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

  const leftAt = new Date();
  await setTracked(bookingId, { leaveReported: true, leftAt: leftAt.getTime() });

  // Calculate duration from tracked joinedAt
  let durationMs = 0;
  if (tracked.joinedAt) {
    durationMs = leftAt.getTime() - tracked.joinedAt;
  }

  const result = await apiFetch(API.REPORT_LEAVE, {
    method: 'POST',
    body: JSON.stringify({
      bookingId,
      leftAt: leftAt.toISOString(),
    }),
  });

  if (result?.success) {
    const allMeetings = [...(meetings?.upcoming || []), ...(meetings?.previous || [])];
    const meeting = allMeetings.find((m) => m.bookingId === bookingId);
    const durationMin = Math.round(durationMs / 60000);

    addEventLog({
      type: 'leave',
      bookingId,
      clientName: meeting?.clientName || 'Unknown',
      duration: `${durationMin} min`,
    });

    await fetchMeetings(true);
    console.log(`[BDA-BG] LEAVE reported for ${bookingId}, duration: ${durationMin} min`);
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

    await loadTrackedState();

    if (isHandled(bookingId)) {
      chrome.notifications.clear(`attend-${bookingId}`);
      return;
    }

    await loadAuth();
    await fetchMeetings(true);

    const allMeetings = [...(meetings?.upcoming || []), ...(meetings?.previous || [])];
    const meeting = allMeetings.find((m) => m.bookingId === bookingId);

    if (meeting && hasServerAttendance(meeting)) {
      await setTracked(bookingId, { reported: true, leaveReported: true, trackedAt: Date.now() });
      chrome.notifications.clear(`attend-${bookingId}`);
      return;
    }

    // Still no attendance after 2 min - mark absent
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
    chrome.storage.local.get(null, (allData) => {
      const keysToRemove = Object.keys(allData).filter(
        (k) => k.startsWith('bda_') || k.startsWith('bda_notified_') || k.startsWith('bda_warned_')
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

  // ---- Messages from Google Meet content script ----

  if (message.type === 'MEET_TAB_READY') {
    // Meet content script loaded, check if this tab matches any active meeting
    (async () => {
      await loadAuth();
      await loadTrackedState();
      await fetchMeetings();

      if (!meetings) {
        sendResponse({ booking: null });
        return;
      }

      const allMeetings = [...(meetings.upcoming || []), ...(meetings.previous || [])];
      const now = getServerTime();
      const nowMs = now.getTime();
      const tabMeetCode = message.meetCode;

      let matched = null;

      // Try direct match first
      for (const m of allMeetings) {
        const startMs = new Date(m.scheduledStart).getTime();
        if (nowMs < startMs - 2 * 60 * 1000 || nowMs > startMs + 2 * 60 * 60 * 1000) continue;

        if (doesMeetMatchBooking(tabMeetCode, m)) {
          matched = m;
          break;
        }
      }

      // Fallback: single active meeting
      if (!matched) {
        const activeMeetings = allMeetings.filter((m) => {
          const startMs = new Date(m.scheduledStart).getTime();
          return nowMs >= startMs - 2 * 60 * 1000 && nowMs <= startMs + 2 * 60 * 60 * 1000 && !hasServerAttendance(m) && !isHandled(m.bookingId);
        });
        if (activeMeetings.length === 1) {
          matched = activeMeetings[0];
        }
      }

      if (matched) {
        sendResponse({ booking: { bookingId: matched.bookingId, clientName: matched.clientName } });
      } else {
        sendResponse({ booking: null });
      }
    })();
    return true;
  }

  if (message.type === 'MEET_MANUAL_MARK') {
    // BDA clicked "Mark Present" inside the Meet page widget
    (async () => {
      await loadAuth();
      await loadTrackedState();

      const joinData = {
        bookingId: message.bookingId,
        meetLink: message.meetLink,
        joinedAt: new Date().toISOString(),
      };

      const result = await apiFetch(API.REPORT_JOIN, {
        method: 'POST',
        body: JSON.stringify(joinData),
      });

      if (result?.success) {
        await setTracked(message.bookingId, {
          meetCode: extractMeetCode(message.meetLink),
          tabId: sender.tab?.id || null,
          reported: true,
          joinedAt: Date.now(),
          leaveReported: false,
          trackedAt: Date.now(),
        });

        chrome.alarms.clear(`absent-check-${message.bookingId}`);
        chrome.alarms.clear(`warning-${message.bookingId}`);
        chrome.notifications.clear(`attend-${message.bookingId}`);

        addEventLog({
          type: 'join',
          bookingId: message.bookingId,
          clientName: message.clientName || 'Manual via Meet',
          meetLink: message.meetLink,
        });

        await fetchMeetings(true);
        console.log(`[BDA-BG] MEET WIDGET join reported for ${message.bookingId}`);
      }

      sendResponse(result || { success: false, error: 'Failed' });
    })();
    return true;
  }

  if (message.type === 'MEET_AUTO_JOIN') {
    // PRIMARY AUTO-DETECTION: Meet content script detected BDA is in a call
    // Immediately find matching meeting and report join
    (async () => {
      await loadAuth();
      if (!token) {
        sendResponse({ success: false, error: 'Not authenticated' });
        return;
      }

      await loadTrackedState();
      await fetchMeetings(true); // Force fresh fetch

      if (!meetings) {
        sendResponse({ success: false, noMatch: true, error: 'No meetings loaded' });
        return;
      }

      const allMeetings = [...(meetings.upcoming || []), ...(meetings.previous || [])];
      const now = getServerTime();
      const nowMs = now.getTime();
      const tabMeetCode = message.meetCode;
      const tabId = sender.tab?.id;

      let matched = null;

      // Strategy 1: Direct code match
      for (const m of allMeetings) {
        const startMs = new Date(m.scheduledStart).getTime();
        if (nowMs < startMs - 5 * 60 * 1000 || nowMs > startMs + 2 * 60 * 60 * 1000) continue;
        if (hasServerAttendance(m) || isHandled(m.bookingId)) continue;
        if (doesMeetMatchBooking(tabMeetCode, m)) {
          matched = m;
          break;
        }
      }

      // Strategy 2: Single active unhandled meeting = auto-match
      if (!matched) {
        const activeMeetings = allMeetings.filter((m) => {
          const startMs = new Date(m.scheduledStart).getTime();
          return nowMs >= startMs - 5 * 60 * 1000 && nowMs <= startMs + 2 * 60 * 60 * 1000 && !hasServerAttendance(m) && !isHandled(m.bookingId);
        });
        if (activeMeetings.length === 1) {
          matched = activeMeetings[0];
          console.log(`[BDA-BG] MEET_AUTO_JOIN fallback: single active meeting -> ${matched.bookingId}`);
        }
      }

      if (!matched) {
        sendResponse({ success: false, noMatch: true, error: 'No matching meeting' });
        return;
      }

      // Report join to API
      const joinData = {
        bookingId: matched.bookingId,
        meetLink: message.url,
        joinedAt: message.joinedAt || new Date().toISOString(),
      };

      const result = await apiFetch(API.REPORT_JOIN, {
        method: 'POST',
        body: JSON.stringify(joinData),
      });

      if (result?.success) {
        await setTracked(matched.bookingId, {
          meetCode: tabMeetCode,
          tabId: tabId,
          reported: true,
          joinedAt: Date.now(),
          leaveReported: false,
          trackedAt: nowMs,
        });

        chrome.alarms.clear(`absent-check-${matched.bookingId}`);
        chrome.alarms.clear(`warning-${matched.bookingId}`);
        chrome.notifications.clear(`attend-${matched.bookingId}`);

        addEventLog({
          type: 'join',
          bookingId: matched.bookingId,
          clientName: matched.clientName,
          meetLink: message.url,
        });

        await fetchMeetings(true);
        console.log(`[BDA-BG] MEET_AUTO_JOIN success: ${matched.bookingId} via ${message.url}`);

        sendResponse({
          success: true,
          booking: { bookingId: matched.bookingId, clientName: matched.clientName },
        });
      } else {
        sendResponse({ success: false, error: 'API call failed' });
      }
    })();
    return true;
  }

  if (message.type === 'MEET_CALL_ENDED') {
    // Meet content script detected call ended - report leave with duration
    (async () => {
      await loadTrackedState();
      // Find which booking was tracked on this tab
      const tabId = sender.tab?.id;
      for (const bookingId of Object.keys(trackedMeetings)) {
        const tracked = trackedMeetings[bookingId];
        if (tracked.tabId === tabId && tracked.reported && !tracked.leaveReported) {
          await reportLeave(bookingId);
          break;
        }
      }
      sendResponse({ success: true });
    })();
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

        chrome.alarms.clear(`absent-check-${message.bookingId}`);
        chrome.alarms.clear(`warning-${message.bookingId}`);
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
