// ==================== FlashFire BDA Attendance - Background Service Worker ====================

import { API_URLS } from './exports.js';

const API = {
  MY_MEETINGS: API_URLS.MY_MEETINGS,
  REPORT_JOIN: API_URLS.REPORT_JOIN,
  REPORT_LEAVE: API_URLS.REPORT_LEAVE,
  REPORT_END_EVENT: API_URLS.REPORT_END_EVENT,
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

const warnAbsentInFlight = new Set();

const leaveReportInFlight = new Set();

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

  if (state.reported && !state.leaveReported) {
    await startKeepalive();
  } else {
    await stopKeepaliveIfIdle();
  }
}

function isHandled(bookingId) {
  const t = trackedMeetings[bookingId];
  return t && t.reported;
}


function hasActiveTracking() {
  return Object.values(trackedMeetings).some((t) => t.reported && !t.leaveReported);
}

async function startKeepalive() {
  const existing = await chrome.alarms.get('keepalive');
  if (!existing) {
    chrome.alarms.create('keepalive', { periodInMinutes: 0.4 }); // ~24 seconds
    console.log('[BDA-BG] Keepalive alarm started (active tracking in progress)');
  }
}

async function stopKeepaliveIfIdle() {
  if (!hasActiveTracking()) {
    chrome.alarms.clear('keepalive');
  }
}

// ==================== Pending Request Queue (network failure resilience) ====================

async function queuePendingRequest(type, data) {
  const result = await chrome.storage.local.get(['bda_pending_requests']);
  const queue = result.bda_pending_requests || [];
  queue.push({ type, data, queuedAt: Date.now() });
  await chrome.storage.local.set({ bda_pending_requests: queue.slice(-20) }); // Keep last 20
}

async function flushPendingRequests() {
  const result = await chrome.storage.local.get(['bda_pending_requests']);
  const queue = result.bda_pending_requests || [];
  if (queue.length === 0) return;

  const remaining = [];
  for (const req of queue) {
    // Skip requests older than 3 hours
    if (Date.now() - req.queuedAt > 3 * 60 * 60 * 1000) continue;

    let endpoint = API.REPORT_LEAVE;
    if (req.type === 'join') endpoint = API.REPORT_JOIN;
    else if (req.type === 'end_event') endpoint = API.REPORT_END_EVENT;

    const apiResult = await apiFetch(endpoint, {
      method: 'POST',
      keepalive: true,
      body: JSON.stringify(req.data),
    });

    if (!apiResult?.success) {
      remaining.push(req); // Keep for retry
    } else {
      const id = req.data?.bookingId || req.data?.requestId || 'ok';
      console.log(`[BDA-BG] Flushed pending ${req.type} for ${id}`);
    }
  }

  await chrome.storage.local.set({ bda_pending_requests: remaining });
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
  const { keepalive, ...fetchOpts } = options;
  try {
    const res = await fetch(url, {
      ...fetchOpts,
      ...(keepalive === true ? { keepalive: true } : {}),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(fetchOpts.headers || {}),
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
  if (!match2) return null;
  const seg = match2[1].toLowerCase();
  if (seg === 'landing' || seg === 'new' || seg === 'about' || seg === 'getting-started') {
    return null;
  }
  return seg;
}

function isGoogleMeetLandingUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /meet\.google\.com\/landing(\/|\?|#|$)/i.test(url.trim());
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

  // Clean up old tracked entries (meetings older than 1 hour)
  const oneHourAgo = nowMs - 1 * 60 * 60 * 1000;
  let cleanupNeeded = false;
  for (const bookingId of Object.keys(trackedMeetings)) {
    const tracked = trackedMeetings[bookingId];
    if (tracked.trackedAt && tracked.trackedAt < oneHourAgo) {
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
      if (isGoogleMeetLandingUrl(t.url)) return false;
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

        if (result?.markedAbsent) {
          await setTracked(bookingId, {
            reported: true,
            leaveReported: true,
            trackedAt: nowMs,
          });
          addEventLog({
            type: 'absent',
            bookingId,
            clientName: meeting.clientName,
          });
          await fetchMeetings(true);
          console.warn(`[BDA-BG] Meet landing URL for ${bookingId} — marked absent on server`);
        } else if (result?.success) {
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
              clientName: meeting.clientName,
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

    // ---- 60-second warning: BDA not in meet, send Discord reminder (once per booking, server + client dedupe) ----
    if (nowMs >= startMs + 60 * 1000 && !isHandled(bookingId)) {
      const warnKey = `bda_warned_${bookingId}`;
      const warnData = await chrome.storage.local.get([warnKey]);

      if (!warnData[warnKey] && !warnAbsentInFlight.has(bookingId)) {
        warnAbsentInFlight.add(bookingId);
        try {
          const warnResult = await apiFetch(API.REPORT_JOIN.replace('/report-join', '/warn-absent'), {
            method: 'POST',
            body: JSON.stringify({ bookingId }),
          }).catch(() => null);

          if (warnResult?.success) {
            await chrome.storage.local.set({ [warnKey]: Date.now() });
            console.log(`[BDA-BG] 2-min warn-absent sent for ${bookingId}`);
          } else {
            warnAbsentInFlight.delete(bookingId);
            console.warn(`[BDA-BG] warn-absent not confirmed for ${bookingId}, will retry`);
          }
        } catch {
          warnAbsentInFlight.delete(bookingId);
        }
      }
    }

    // ---- 60-second absent check popup ----
    if (nowMs >= startMs + 60 * 1000 && !isHandled(bookingId)) {
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
  await loadTrackedState();

  const tracked = trackedMeetings[bookingId];
  if (!tracked || tracked.leaveReported || leaveReportInFlight.has(bookingId)) return;

  leaveReportInFlight.add(bookingId);

  const leftAt = new Date();
  let durationMs = 0;
  if (tracked.joinedAt) {
    durationMs = leftAt.getTime() - tracked.joinedAt;
  }

  try {
    await loadAuth();
    const result = await apiFetch(API.REPORT_LEAVE, {
      method: 'POST',
      keepalive: true,
      body: JSON.stringify({
        bookingId,
        leftAt: leftAt.toISOString(),
        durationMs: durationMs || undefined,
      }),
    });

    if (result?.success) {
      await setTracked(bookingId, { leaveReported: true, leftAt: leftAt.getTime() });

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
    } else {
      console.warn(`[BDA-BG] LEAVE API failed for ${bookingId}; queuing for retry`);
      // Queue for retry on next checkMeetings cycle
      await queuePendingRequest('leave', {
        bookingId,
        leftAt: leftAt.toISOString(),
        durationMs: durationMs || undefined,
      });
      // Still mark as leaveReported locally to prevent duplicate attempts
      await setTracked(bookingId, { leaveReported: true, leftAt: leftAt.getTime() });
    }
  } finally {
    leaveReportInFlight.delete(bookingId);
  }
}

function newEndRequestId() {
  return `ff_end_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

const finalizeEndInFlight = new Set();

/** Single path for End Meet: closes session + immutable end-event row on server */
async function finalizeMeetingEnd({
  bookingId: explicitBookingId,
  meetLink,
  endSource,
  requestId: incomingRequestId,
  joinedAtMs,
  tabId,
  durationMs,
}) {
  await loadAuth();
  if (!token) {
    console.warn('[BDA-BG] finalizeMeetingEnd: no token');
    return { success: false, error: 'Not authenticated' };
  }

  const requestId = incomingRequestId || newEndRequestId();
  if (finalizeEndInFlight.has(requestId)) {
    return { success: true, skipped: true };
  }
  finalizeEndInFlight.add(requestId);

  try {
    const leftAt = new Date().toISOString();

    let bookingId = explicitBookingId || null;

    await loadTrackedState();

    if (!bookingId && tabId != null) {
      for (const bid of Object.keys(trackedMeetings)) {
        const t = trackedMeetings[bid];
        if (t.tabId === tabId && t.reported && !t.leaveReported) {
          bookingId = bid;
          break;
        }
      }
    }

    let effectiveJoinedAtMs = joinedAtMs;
    if (bookingId && effectiveJoinedAtMs == null) {
      const t = trackedMeetings[bookingId];
      if (t?.joinedAt) effectiveJoinedAtMs = t.joinedAt;
    }

    const joinedAtSnapshot =
      effectiveJoinedAtMs != null
        ? new Date(effectiveJoinedAtMs).toISOString()
        : undefined;

    if (!bookingId && meetLink) {
      await fetchMeetings(true);
      const code = extractMeetCode(meetLink);
      const all = [...(meetings?.upcoming || []), ...(meetings?.previous || [])];
      const m = all.find((b) => doesMeetMatchBooking(code, b));
      if (m) bookingId = m.bookingId;
    }

    const body = {
      requestId,
      endSource,
      leftAt,
      ...(meetLink ? { meetLink } : {}),
      ...(bookingId ? { bookingId } : {}),
      ...(joinedAtSnapshot ? { joinedAtSnapshot } : {}),
      ...(durationMs != null ? { durationMsSnapshot: durationMs } : {}),
    };

    const result = await apiFetch(API.REPORT_END_EVENT, {
      method: 'POST',
      keepalive: true,
      body: JSON.stringify(body),
    });

    if (result?.success) {
      const resolvedBooking = result.bookingId || bookingId || null;

      if (resolvedBooking) {
        await setTracked(resolvedBooking, {
          leaveReported: true,
          leftAt: Date.now(),
        });
      }

      const allMeetings = [...(meetings?.upcoming || []), ...(meetings?.previous || [])];
      const meeting = allMeetings.find((m) => m.bookingId === resolvedBooking);
      const durationMin =
        durationMs != null ? Math.round(durationMs / 60000) : undefined;
      addEventLog({
        type: 'leave',
        bookingId: resolvedBooking,
        clientName: meeting?.clientName || 'Meeting ended',
        ...(durationMin != null ? { duration: `${durationMin} min` } : {}),
      });

      await fetchMeetings(true);
      console.log(
        `[BDA-BG] END EVENT ok requestId=${requestId} booking=${resolvedBooking}`
      );
      return result;
    }

    console.warn('[BDA-BG] REPORT_END_EVENT failed; queueing');
    await queuePendingRequest('end_event', body);
    if (bookingId) {
      await setTracked(bookingId, { leaveReported: true, leftAt: Date.now() });
    }
    return result || { success: false };
  } finally {
    finalizeEndInFlight.delete(requestId);
  }
}

// ==================== Alarm Handlers ====================

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'check-meetings') {
    await checkMeetings();
    // Also flush any pending requests from network failures
    await loadAuth();
    if (token) await flushPendingRequests();
    return;
  }

  // Keepalive: check tab existence for all active-tracked meetings every ~24s
  if (alarm.name === 'keepalive') {
    await loadTrackedState();
    let anyActive = false;

    for (const bookingId of Object.keys(trackedMeetings)) {
      const tracked = trackedMeetings[bookingId];
      if (!tracked.reported || tracked.leaveReported) continue;
      anyActive = true;

      // Save lastAliveAt for crash recovery
      tracked.lastAliveAt = Date.now();

      // Verify tab still exists and is on Meet
      if (tracked.tabId) {
        try {
          const tab = await chrome.tabs.get(tracked.tabId).catch(() => null);
          if (!tab || !tab.url?.includes('meet.google.com')) {
            console.log(`[BDA-BG] Keepalive: tab ${tracked.tabId} gone, reporting leave for ${bookingId}`);
            await saveTrackedState(); // Save lastAliveAt before reporting
            await reportLeave(bookingId);
            continue;
          }
        } catch {
          console.log(`[BDA-BG] Keepalive: tab ${tracked.tabId} error, reporting leave for ${bookingId}`);
          await saveTrackedState();
          await reportLeave(bookingId);
          continue;
        }
      }
    }

    await saveTrackedState(); // Persist lastAliveAt updates

    if (!anyActive) {
      chrome.alarms.clear('keepalive');
      console.log('[BDA-BG] Keepalive: no active tracking, alarm cleared');
    }
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
    warnAbsentInFlight.clear();
    leaveReportInFlight.clear();
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

      if (message.url && isGoogleMeetLandingUrl(message.url)) {
        sendResponse({ booking: null, landingPage: true });
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

      if (message.meetLink && isGoogleMeetLandingUrl(message.meetLink)) {
        sendResponse({
          success: false,
          error: 'Open the real Google Meet room (not meet.google.com/landing).',
        });
        return;
      }

      const joinData = {
        bookingId: message.bookingId,
        meetLink: message.meetLink,
        joinedAt: new Date().toISOString(),
      };

      const result = await apiFetch(API.REPORT_JOIN, {
        method: 'POST',
        body: JSON.stringify(joinData),
      });

      if (result?.markedAbsent) {
        await setTracked(message.bookingId, {
          reported: true,
          leaveReported: true,
          trackedAt: Date.now(),
        });
        addEventLog({
          type: 'absent',
          bookingId: message.bookingId,
          clientName: message.clientName || 'Manual via Meet',
        });
        await fetchMeetings(true);
        sendResponse({
          success: false,
          markedAbsent: true,
          error: result.message || 'Meet landing URL — marked absent.',
        });
        return;
      }

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

      if (result?.markedAbsent) {
        await setTracked(matched.bookingId, {
          reported: true,
          leaveReported: true,
          trackedAt: nowMs,
        });
        addEventLog({
          type: 'absent',
          bookingId: matched.bookingId,
          clientName: matched.clientName,
        });
        await fetchMeetings(true);
        sendResponse({
          success: false,
          landingPage: true,
          markedAbsent: true,
          error: result.message || 'Meet landing URL — not a real room; marked absent.',
        });
        return;
      }

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
    (async () => {
      const tabId = sender.tab?.id;
      const result = await finalizeMeetingEnd({
        bookingId: message.bookingId || null,
        meetLink: message.url,
        endSource: message.endSource || 'meet_call_ended',
        requestId: message.requestId,
        joinedAtMs: message.joinedAtMs,
        tabId,
        durationMs: message.durationMs,
      });
      sendResponse(result || { success: true });
    })();
    return true;
  }

  if (message.type === 'PANEL_END_MEET') {
    (async () => {
      await loadAuth();
      if (!token) {
        sendResponse({ success: false, error: 'Not authenticated' });
        return;
      }

      let meetLink = message.meetLink;
      if (!meetLink && message.bookingId) {
        await fetchMeetings(true);
        const allMeetings = [...(meetings?.upcoming || []), ...(meetings?.previous || [])];
        const m = allMeetings.find((x) => x.bookingId === message.bookingId);
        meetLink = m?.googleMeetUrl || m?.calendlyMeetLink || null;
      }

      const result = await finalizeMeetingEnd({
        bookingId: message.bookingId,
        meetLink: meetLink || undefined,
        endSource: 'panel',
        requestId: message.requestId,
        joinedAtMs: message.joinedAtMs,
        tabId: null,
        durationMs: message.durationMs,
      });
      sendResponse(result || { success: false });
    })();
    return true;
  }

  if (message.type === 'MANUAL_MARK') {
    (async () => {
      await loadAuth();
      await loadTrackedState();

      // Try to find meetLink from meetings data
      const allMeetings = [...(meetings?.upcoming || []), ...(meetings?.previous || [])];
      const meetingData = allMeetings.find(m => m.bookingId === message.bookingId);
      const meetLink = meetingData?.googleMeetUrl || meetingData?.calendlyMeetLink || null;

      const result = await apiFetch(API.MANUAL_MARK, {
        method: 'POST',
        body: JSON.stringify({ bookingId: message.bookingId, meetLink }),
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

  // Recovery: check for tracked meetings that were never left (Chrome crash / force close)
  await loadAuth();
  await loadTrackedState();

  for (const bookingId of Object.keys(trackedMeetings)) {
    const tracked = trackedMeetings[bookingId];
    if (tracked.reported && !tracked.leaveReported) {
      // Use lastAliveAt for more accurate duration (instead of Date.now() which could be hours later)
      const recoveryLeftAt = tracked.lastAliveAt ? new Date(tracked.lastAliveAt) : new Date();
      let durationMs = 0;
      if (tracked.joinedAt) {
        durationMs = recoveryLeftAt.getTime() - tracked.joinedAt;
      }

      console.log(`[BDA-BG] RECOVERY: reporting leave for ${bookingId} (lastAliveAt: ${recoveryLeftAt.toISOString()}, duration: ${Math.round(durationMs / 60000)} min)`);

      if (token) {
        const result = await apiFetch(API.REPORT_LEAVE, {
          method: 'POST',
          keepalive: true,
          body: JSON.stringify({
            bookingId,
            leftAt: recoveryLeftAt.toISOString(),
            durationMs: durationMs || undefined,
          }),
        });

        if (result?.success) {
          await setTracked(bookingId, { leaveReported: true, leftAt: recoveryLeftAt.getTime() });
          addEventLog({
            type: 'leave',
            bookingId,
            clientName: 'Unknown (recovered after restart)',
            duration: `${Math.round(durationMs / 60000)} min`,
          });
        } else {
          // Queue for retry
          await queuePendingRequest('leave', {
            bookingId,
            leftAt: recoveryLeftAt.toISOString(),
            durationMs: durationMs || undefined,
          });
        }
      }
    }
  }

  await checkMeetings();
});

// Initial check on service worker load
(async () => {
  const hasAuth = await loadAuth();
  if (hasAuth) {
    chrome.alarms.create('check-meetings', { periodInMinutes: 1 });

    // Restart keepalive if there are active tracked meetings from previous session
    await loadTrackedState();
    if (hasActiveTracking()) {
      await startKeepalive();
    }

    await checkMeetings();
  }
})();
