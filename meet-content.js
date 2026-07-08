// ==================== FlashFire BDA Attendance - Google Meet Content Script ====================
// Injected ONLY into meet.google.com/* pages.
// IMPORTANT: This is a CLASSIC content script — Chrome content scripts do NOT support
// ES modules, so no import statements here. An `import` would throw a SyntaxError and
// the whole script (widget included) would silently never run.
// PRIMARY auto-detection: detects when BDA joins a call and immediately reports to background
// Uses MutationObserver for near-instant join/leave detection + sendBeacon for reliable leave reporting

(function () {
  if (window.__ffMeetContentInjected) return;
  window.__ffMeetContentInjected = true;

  // ==================== Constants ====================
  // Same base as panel/background (exports.js) — main backend only. Kept inline
  // because this classic script cannot import exports.js.
  const API_BASE_URL = 'https://flashfire-backend-9wv0.onrender.com';
  const BEACON_LEAVE_URL = `${API_BASE_URL}/api/bda-attendance/beacon-leave`;
  const BEACON_END_EVENT_URL = `${API_BASE_URL}/api/bda-attendance/beacon-end-event`;
  const FALLBACK_POPUP_DELAY_MS = 30000; // Show fallback popup after 30s if auto-attendance fails
  // Confirmation windows: the "Leave call" button must persist before we trust a
  // join (kills momentary DOM flickers) and must stay gone before we trust a leave
  // (Meet rebuilds its control bar constantly during the call).
  const JOIN_DWELL_MS = 3000; // leave-call must be present continuously for 3s (flicker guard, stays near real-time)
  const LEAVE_DEBOUNCE_MS = 10000; // leave-call must be gone continuously for 10s
  // Manual "Mark Present" only unlocks from 1 min before the scheduled start, so a
  // BDA who opens the room early can't stamp attendance before the meeting window.
  const MARK_WINDOW_LEAD_MS = 60 * 1000;

  // ==================== State ====================

  let currentBooking = null; // { bookingId, clientName }
  let isInCall = false;
  let joinReported = false;
  let callStartTime = null;
  // After a manual "End Meet" the BDA is often still physically in the Meet (the
  // leave-call button is still on screen). Suppress auto re-confirm until they truly
  // leave (button disappears), so ending tracking doesn't instantly re-start it.
  let suppressUntilRejoin = false;
  let checkInterval = null;
  let initStarted = false; // init() setup ran once (observers + call-detection loop)
  let widget = null;
  // Overlay hidden for screen sharing. In-memory only, so a page reload always
  // brings the overlay back; opening the extension panel un-hides it too
  // (SHOW_OVERLAY message). Tracking keeps running while hidden.
  let overlayHidden = false;
  let bdaInfo = null;
  let authChecked = false;
  let storedToken = null; // Cached for sendBeacon (can't set auth headers)
  let fallbackPopupTimeout = null;
  let noMatchRetryTimeout = null; // pending retry of onCallDetected after a noMatch reply
  let beaconSent = false; // Prevent duplicate beacons per session
  let currentMeetLink = null; // The meet link for this session
  /** Stable id per in-call session for deduping end events (message + beacon) */
  let sessionEndRequestId = null;

  function getSessionEndRequestId() {
    if (!sessionEndRequestId) {
      sessionEndRequestId = `ff_sess_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    }
    return sessionEndRequestId;
  }

  const FF_WIDGET_POS_KEY = 'ffMeetWidgetPos';
  const FF_SESSION_KEY = 'ff_active_session';
  const SESSION_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour max session
  const DRAG_THRESHOLD_PX = 8;
  let widgetDrag = null;

  // ==================== Meet-Link Session Tracking ====================
  // Persists join timestamp to chrome.storage so duration survives page reloads

  function saveSession(meetLink, joinedAt) {
    currentMeetLink = meetLink;
    try {
      chrome.storage.local.set({
        [FF_SESSION_KEY]: { meetLink, joinedAt, bookingId: currentBooking?.bookingId || null },
      });
    } catch (_) {}
  }

  function clearSession() {
    try {
      chrome.storage.local.remove(FF_SESSION_KEY);
    } catch (_) {}
  }

  async function restoreSession() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(FF_SESSION_KEY, (data) => {
          const session = data?.[FF_SESSION_KEY];
          if (!session) return resolve(null);
          // Expire sessions older than 1 hour
          if (Date.now() - session.joinedAt > SESSION_MAX_AGE_MS) {
            clearSession();
            return resolve(null);
          }
          resolve(session);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  // ==================== Call State Detection ====================

  // ONLY the "Leave call" button proves the BDA is actually IN the call.
  // The mic/camera toggles, self-preview <video>, and participant labels are ALL
  // present in the pre-join green room too — using them counted lobby-sitting as
  // "attended" (the false-positive that wrecked accuracy). Leave-call appears only
  // after a real join, so it is the single trustworthy signal.
  function detectInCall() {
    return !!(
      document.querySelector('[aria-label="Leave call"]') ||
      document.querySelector('[aria-label="leave call"]') ||
      document.querySelector('[data-tooltip="Leave call"]') ||
      document.querySelector('button[jsname="CQylAd"]')
    );
  }

  // ==================== sendBeacon Leave (fire-and-forget) ====================

  function sendBeaconLeave() {
    if (beaconSent || !storedToken) return;
    beaconSent = true;

    const requestId = getSessionEndRequestId();
    const meetLink = currentMeetLink || window.location.href;
    const leftAt = new Date().toISOString();
    const joinedAtSnapshot = callStartTime ? new Date(callStartTime).toISOString() : undefined;
    const durationMsSnapshot = callStartTime ? Date.now() - callStartTime : undefined;

    try {
      if (currentBooking?.bookingId) {
        const blob = new Blob(
          [
            JSON.stringify({
              bookingId: currentBooking.bookingId,
              leftAt,
              token: storedToken,
              endRequestId: requestId,
              endMeetLink: meetLink,
              endSource: 'beacon',
              joinedAtSnapshot,
              durationMsSnapshot,
            }),
          ],
          { type: 'application/json' }
        );
        navigator.sendBeacon(BEACON_LEAVE_URL, blob);
        console.log('[FF-MEET] Beacon leave sent for', currentBooking.bookingId);
      } else {
        const blob = new Blob(
          [
            JSON.stringify({
              token: storedToken,
              meetLink,
              leftAt,
              endSource: 'beacon',
              requestId,
              joinedAtSnapshot,
              durationMsSnapshot,
            }),
          ],
          { type: 'application/json' }
        );
        navigator.sendBeacon(BEACON_END_EVENT_URL, blob);
        console.log('[FF-MEET] Beacon end-event sent (no booking id)');
      }
    } catch (err) {
      console.warn('[FF-MEET] sendBeacon failed:', err.message);
      beaconSent = false;
    }
  }

  /** Extension UI / call-ended → background → report-end-event */
  function notifyMeetingEnd(endSource) {
    const requestId = getSessionEndRequestId();
    const durationMs = callStartTime ? Date.now() - callStartTime : 0;
    const duration = getElapsedStr();
    chrome.runtime.sendMessage({
      type: 'MEET_CALL_ENDED',
      url: currentMeetLink || window.location.href,
      duration,
      durationMs,
      endSource,
      requestId,
      joinedAtMs: callStartTime,
      bookingId: currentBooking?.bookingId || undefined,
    });
  }

  // ==================== Leave Button Click Interceptor ====================

  function attachLeaveButtonInterceptor() {
    const selectors = [
      '[aria-label="Leave call"]',
      '[aria-label="leave call"]',
      '[data-tooltip="Leave call"]',
      'button[jsname="CQylAd"]',
    ];

    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn && !btn.__ffIntercepted) {
        btn.addEventListener(
          'click',
          () => {
            console.log('[FF-MEET] Leave button clicked — sending beacon');
            sendBeaconLeave();
          },
          { capture: true, once: true }
        );
        btn.__ffIntercepted = true;
      }
    }
  }

  // ==================== Duration Scraping ====================

  function scrapeMeetDuration() {
    const selectors = ['[data-call-duration]', '.vpMJed', '.r6xAKc'];

    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          const text = el.getAttribute('data-call-duration') || el.textContent?.trim();
          if (text && /\d/.test(text)) return text;
        }
      } catch {}
    }

    // Search all spans for timer pattern
    const allSpans = document.querySelectorAll('span');
    for (const span of allSpans) {
      const t = span.textContent?.trim();
      if (t && /^\d{1,2}:\d{2}(:\d{2})?$/.test(t) && t !== '0:00') return t;
    }

    return null;
  }

  function getElapsedStr() {
    if (!callStartTime) return '0:00';
    const elapsed = Date.now() - callStartTime;
    const hrs = Math.floor(elapsed / 3600000);
    const mins = Math.floor((elapsed % 3600000) / 60000);
    const secs = Math.floor((elapsed % 60000) / 1000);
    if (hrs > 0) return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }

  function getElapsedMinStr() {
    if (!callStartTime) return '0 min';
    const elapsed = Date.now() - callStartTime;
    const mins = Math.round(elapsed / 60000);
    return `${mins} min`;
  }

  // Wall-clock "In" time (local), e.g. "3:55 PM".
  function formatClockTime(ms) {
    if (!ms) return '—';
    try {
      return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
    } catch {
      return '—';
    }
  }

  // ==================== Fallback In-Page Popup ====================

  function setOverlayHidden(hidden) {
    overlayHidden = hidden;
    // !important so no widget stylesheet rule can override the hide.
    if (widget) {
      if (hidden) widget.style.setProperty('display', 'none', 'important');
      else widget.style.removeProperty('display');
    }
    const popup = document.getElementById('ff-fallback-popup');
    if (popup) {
      if (hidden) popup.style.setProperty('display', 'none', 'important');
      else popup.style.removeProperty('display');
    }
  }

  // Bind a hide control via raw pointer events in the CAPTURE phase.
  // Plain 'click' is unreliable here: the drag system's pointer capture (and
  // Meet's own listeners) can retarget or swallow the synthesized click, but
  // pointerdown/up always fire on the element actually under the pointer.
  function bindHideControl(el) {
    if (!el) return;
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
    }, true);
    el.addEventListener('pointerup', (e) => {
      e.stopPropagation();
      e.preventDefault();
      setOverlayHidden(true);
    }, true);
  }

  function showFallbackPopup() {
    // Don't show if attendance already confirmed
    if (joinReported) return;
    // Don't pop up over a screen share the BDA explicitly hid the overlay for
    if (overlayHidden) return;
    if (document.getElementById('ff-fallback-popup')) return;

    const hasBooking = !!currentBooking;
    const clientName = currentBooking?.clientName || '';

    const popup = document.createElement('div');
    popup.id = 'ff-fallback-popup';
    popup.innerHTML = `
      <style>
        #ff-fallback-popup {
          position: fixed;
          top: 16px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 2147483647;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          animation: ff-popup-in 0.3s ease-out;
        }
        #ff-fallback-popup * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes ff-popup-in {
          from { opacity: 0; transform: translateX(-50%) translateY(-12px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        .ff-popup-card {
          background: white;
          border-radius: 12px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25), 0 0 0 2px #ff5722;
          padding: 16px 20px;
          min-width: 340px;
          max-width: 440px;
        }
        .ff-popup-card.minimized {
          min-width: auto;
          padding: 8px 16px;
          cursor: pointer;
          border-radius: 24px;
        }
        .ff-popup-card.minimized .ff-popup-full { display: none; }
        .ff-popup-card.minimized .ff-popup-pill { display: flex; }
        .ff-popup-pill {
          display: none;
          align-items: center;
          gap: 8px;
          font-size: 12px;
          font-weight: 600;
          color: #ff5722;
        }
        .ff-popup-pill-dot {
          width: 8px; height: 8px; border-radius: 50%;
          background: #ff5722;
          animation: ff-blink 1.5s infinite;
        }
        @keyframes ff-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        .ff-popup-title {
          font-size: 14px; font-weight: 700; color: #dc2626;
          margin-bottom: 4px;
        }
        .ff-popup-dur {
          font-size: 12px; color: #6b7280; margin-bottom: 8px;
          font-weight: 600;
        }
        .ff-popup-dur span { color: #374151; font-weight: 700; }
        .ff-popup-meet {
          font-size: 10px; color: #9ca3af; margin-bottom: 8px;
          word-break: break-all;
        }
        .ff-popup-msg {
          font-size: 12px; color: #4b5563;
          margin-bottom: 12px; line-height: 1.4;
        }
        .ff-popup-actions {
          display: flex; gap: 8px; flex-wrap: wrap;
        }
        .ff-popup-mark {
          flex: 1; min-width: 100px;
          padding: 8px 12px;
          background: #10b981; color: white; border: none;
          border-radius: 8px; font-size: 12px; font-weight: 600;
          cursor: pointer; transition: background 0.2s;
        }
        .ff-popup-mark:hover { background: #059669; }
        .ff-popup-mark:disabled { background: #d1d5db; color: #6b7280; cursor: not-allowed; }
        .ff-popup-end {
          flex: 1; min-width: 100px;
          padding: 8px 12px;
          background: #dc2626; color: white; border: none;
          border-radius: 8px; font-size: 12px; font-weight: 600;
          cursor: pointer; transition: background 0.2s;
        }
        .ff-popup-end:hover { background: #b91c1c; }
        .ff-popup-end:disabled { background: #d1d5db; color: #6b7280; cursor: not-allowed; }
        .ff-popup-min {
          padding: 8px 12px;
          background: #f3f4f6; color: #6b7280; border: none;
          border-radius: 8px; font-size: 12px;
          cursor: pointer; transition: background 0.2s;
        }
        .ff-popup-min:hover { background: #e5e7eb; }
      </style>
      <div class="ff-popup-card" id="ff-popup-card">
        <div class="ff-popup-full">
          <div class="ff-popup-title">
            ${hasBooking ? 'Mark Attendance' : 'Attendance Not Detected'}
          </div>
          <div class="ff-popup-dur">
            Duration: <span id="ff-popup-dur-val">${getElapsedStr()}</span>
          </div>
          <div class="ff-popup-meet">${window.location.href}</div>
          <div class="ff-popup-msg">
            ${
              hasBooking
                ? `Meeting: <strong>${clientName}</strong> — mark present or end meet.`
                : `No scheduled meeting found for this call. Use <strong>End Meet</strong> to record time spent (meet link is sent to the server).`
            }
          </div>
          <div class="ff-popup-actions" style="flex-direction:column;">
            <button class="ff-popup-end" id="ff-popup-end-btn" style="width:100%;">End Meet</button>
            <div style="display:flex; gap:8px;">
              <button class="ff-popup-mark" id="ff-popup-mark-btn"${hasBooking ? '' : ' style="display:none;"'}>
                Mark Present
              </button>
              <button class="ff-popup-min" id="ff-popup-min-btn">Minimize</button>
              <button class="ff-popup-min" id="ff-popup-hide-btn" title="Hide the overlay completely (e.g. while screen sharing). Reopen the extension or reload the page to show it again.">Hide</button>
            </div>
          </div>
        </div>
        <div class="ff-popup-pill">
          <div class="ff-popup-pill-dot"></div>
          <span id="ff-popup-pill-text">In call — ${getElapsedStr()}</span>
        </div>
      </div>
    `;

    document.body.appendChild(popup);

    // Update duration in popup every second
    const popupDurInterval = setInterval(() => {
      const durEl = document.getElementById('ff-popup-dur-val');
      const pillText = document.getElementById('ff-popup-pill-text');
      if (durEl) durEl.textContent = getElapsedStr();
      if (pillText) pillText.textContent = `In call — ${getElapsedStr()}`;
      if (!document.getElementById('ff-fallback-popup')) clearInterval(popupDurInterval);
    }, 1000);

    // Mark Present button
    const markBtn = document.getElementById('ff-popup-mark-btn');
    if (markBtn && hasBooking) {
      markBtn.addEventListener('click', () => {
        markBtn.disabled = true;
        markBtn.textContent = 'Marking...';
        chrome.runtime.sendMessage(
          {
            type: 'MEET_MANUAL_MARK',
            bookingId: currentBooking.bookingId,
            meetLink: window.location.href,
          },
          (response) => {
            if (response?.success) {
              joinReported = true;
              removeFallbackPopup();
              updateWidgetState('present', 'Present - Attendance recorded');
            } else {
              markBtn.disabled = false;
              markBtn.textContent = 'Mark Present';
              if (response?.markedAbsent || response?.error) {
                updateWidgetState('idle', response.error || 'Use the real Meet room link.');
              }
            }
          }
        );
      });
    }

    // End Meet button in popup
    const popupEndBtn = document.getElementById('ff-popup-end-btn');
    if (popupEndBtn) {
      popupEndBtn.addEventListener('click', () => {
        popupEndBtn.disabled = true;
        popupEndBtn.textContent = 'Ending...';

        const duration = getElapsedStr();
        const durationMs = callStartTime ? Date.now() - callStartTime : 0;
        console.log('[FF-MEET] Popup End Meet clicked. Duration:', duration, `(${Math.round(durationMs / 60000)} min)`, 'Meet:', currentMeetLink || window.location.href);

        notifyMeetingEnd('fallback_popup');

        isInCall = false;
        suppressUntilRejoin = true;
        callStartTime = null;
        joinReported = false;
        clearTimeout(noMatchRetryTimeout);
        noMatchRetryTimeout = null;
        clearSession();
        clearInterval(popupDurInterval);
        removeFallbackPopup();
        updateWidgetState('idle', 'Call ended - ' + duration);
      });
    }

    // Minimize button
    const minBtn = document.getElementById('ff-popup-min-btn');
    if (minBtn) {
      minBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const card = document.getElementById('ff-popup-card');
        if (card) card.classList.add('minimized');
      });
    }

    // Hide button — hides BOTH the popup and the floating widget (screen share)
    bindHideControl(document.getElementById('ff-popup-hide-btn'));

    // Click on pill area to expand back
    const pillArea = popup.querySelector('.ff-popup-pill');
    if (pillArea) {
      pillArea.addEventListener('click', (e) => {
        e.stopPropagation();
        const card = document.getElementById('ff-popup-card');
        if (card?.classList.contains('minimized')) {
          card.classList.remove('minimized');
        }
      });
    }
  }

  function removeFallbackPopup() {
    clearTimeout(fallbackPopupTimeout);
    fallbackPopupTimeout = null;
    document.getElementById('ff-fallback-popup')?.remove();
  }

  // ==================== Core: Report join immediately ====================

  function onCallDetected() {
    if (joinReported) return;
    isInCall = true;
    if (!callStartTime) callStartTime = Date.now();
    beaconSent = false; // Reset for new session
    currentMeetLink = window.location.href;

    // Persist session so duration survives page reloads
    saveSession(currentMeetLink, callStartTime);

    console.log('[FF-MEET] In-call detected! Reporting to background...');

    // Attach leave button interceptor for earliest-possible leave detection
    attachLeaveButtonInterceptor();

    // Schedule fallback popup if auto-attendance doesn't work within 30s
    if (!fallbackPopupTimeout) {
      fallbackPopupTimeout = setTimeout(() => {
        if (!joinReported) {
          console.log('[FF-MEET] Auto-attendance not confirmed after 30s — showing fallback popup');
          showFallbackPopup();
        }
      }, FALLBACK_POPUP_DELAY_MS);
    }

    // Immediately tell background to report join. Report the REAL join moment
    // (callStartTime === leaveSeenSince, when the Leave-call button was first seen),
    // not "now" — otherwise the dwell/confirmation delay skews the recorded join time
    // and the server-side duration.
    chrome.runtime.sendMessage(
      {
        type: 'MEET_AUTO_JOIN',
        url: window.location.href,
        meetCode: extractMeetCode(),
        joinedAt: new Date(callStartTime || Date.now()).toISOString(),
      },
      (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[FF-MEET] Background response error:', chrome.runtime.lastError.message);
          return;
        }
        if (response?.success) {
          joinReported = true;
          if (response.booking) {
            currentBooking = response.booking;
          }
          removeFallbackPopup();
          const clientLabel = currentBooking?.clientName ? ` - ${currentBooking.clientName}` : '';
          updateWidgetState('present', `Present${clientLabel}`);
          console.log('[FF-MEET] Join reported successfully!', response.booking?.clientName);
        } else if (response?.landingPage || response?.markedAbsent) {
          joinReported = false;
          removeFallbackPopup();
          updateWidgetState(
            'idle',
            'Open your real Meet link — landing page was marked absent on server.'
          );
          console.warn('[FF-MEET] Meet landing / absent:', response?.error);
        } else if (response?.noMatch) {
          console.log('[FF-MEET] No matching meeting found, will retry...');
          clearTimeout(noMatchRetryTimeout);
          noMatchRetryTimeout = setTimeout(() => {
            // Only retry if still genuinely in the call and not yet reported —
            // guards against resurrecting a session that ended during the wait.
            if (isInCall && !joinReported) onCallDetected();
          }, 10000);
        } else {
          console.warn('[FF-MEET] Join report failed:', response?.error);
        }
      }
    );
  }

  function onCallEnded() {
    if (!isInCall) return;
    isInCall = false;

    const duration = getElapsedStr();
    const durationMs = callStartTime ? Date.now() - callStartTime : 0;
    console.log('[FF-MEET] Call ended. Duration:', duration, `(${Math.round(durationMs / 60000)} min)`, 'Meet:', currentMeetLink || window.location.href);

    notifyMeetingEnd('meet_call_ended');

    // Reset session state so the live timer stops and a genuine re-join is
    // re-confirmed (and re-reported) as a fresh segment.
    callStartTime = null;
    joinReported = false;
    clearTimeout(noMatchRetryTimeout); // cancel any pending noMatch retry
    noMatchRetryTimeout = null;
    clearSession();
    removeFallbackPopup();
    // Screen share is over with the call — bring a hidden overlay back so the
    // next call always starts visible.
    setOverlayHidden(false);
    updateWidgetState('idle', 'Call ended - ' + duration);
  }

  // ==================== Utility ====================

  function isGoogleMeetLandingUrl(href) {
    if (!href) return false;
    return /meet\.google\.com\/landing(\/|\?|#|$)/i.test(String(href).trim());
  }

  function extractMeetCode() {
    const href = window.location.href;
    const match = href.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/);
    if (match) return match[1];
    const match2 = href.match(/meet\.google\.com\/([a-zA-Z0-9_-]+)/);
    if (!match2) return null;
    const seg = match2[1].toLowerCase();
    if (seg === 'landing' || seg === 'new' || seg === 'about' || seg === 'getting-started') {
      return null;
    }
    return seg;
  }

  // ==================== Widget position (draggable) ====================

  function applyWidgetPosition(left, top) {
    if (!widget) return;
    widget.style.left = `${Math.round(left)}px`;
    widget.style.top = `${Math.round(top)}px`;
    widget.style.right = 'auto';
    widget.style.bottom = 'auto';
  }

  function defaultWidgetPosition() {
    const pad = 16;
    const bottom = 80;
    const toggleH = 48;
    return {
      left: pad,
      top: Math.max(pad, window.innerHeight - bottom - toggleH),
    };
  }

  function clampWidgetPosition(left, top) {
    if (!widget) return { left, top };
    applyWidgetPosition(left, top);
    const toggle = widget.querySelector('.ff-toggle');
    const card = widget.querySelector('.ff-card');
    const pad = 8;
    let minL = Infinity;
    let minT = Infinity;
    let maxR = -Infinity;
    let maxB = -Infinity;
    const rects = [toggle.getBoundingClientRect()];
    if (card && card.classList.contains('open')) rects.push(card.getBoundingClientRect());
    for (const r of rects) {
      minL = Math.min(minL, r.left);
      minT = Math.min(minT, r.top);
      maxR = Math.max(maxR, r.right);
      maxB = Math.max(maxB, r.bottom);
    }
    if (minL === Infinity) return { left, top };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nl = left;
    let nt = top;
    if (minL < pad) nl += pad - minL;
    if (minT < pad) nt += pad - minT;
    if (maxR > vw - pad) nl -= maxR - (vw - pad);
    if (maxB > vh - pad) nt -= maxB - (vh - pad);
    return { left: nl, top: nt };
  }

  function persistWidgetPosition(left, top) {
    try {
      chrome.storage.local.set({ [FF_WIDGET_POS_KEY]: { left, top } });
    } catch (_) {}
  }

  function loadWidgetPositionThen(then) {
    chrome.storage.local.get(FF_WIDGET_POS_KEY, (data) => {
      const pos = data && data[FF_WIDGET_POS_KEY];
      if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
        const c = clampWidgetPosition(pos.left, pos.top);
        applyWidgetPosition(c.left, c.top);
      }
      if (typeof then === 'function') then();
    });
  }

  function attachWidgetDrag() {
    if (!widget || widget.dataset.ffDragBound === '1') return;
    widget.dataset.ffDragBound = '1';

    widget.addEventListener(
      'pointerdown',
      (e) => {
        if (e.button !== 0) return;
        // Never start a drag (pointer capture) from an interactive control —
        // capture retargets the click away from the button, so its handler
        // never fires. The toggle logo stays draggable (click = open card).
        if (e.target.closest('button') && !e.target.closest('#ff-toggle')) return;
        const toggleEl = e.target.closest('#ff-toggle');
        const rect = widget.getBoundingClientRect();
        widgetDrag = {
          startX: e.clientX,
          startY: e.clientY,
          startLeft: rect.left,
          startTop: rect.top,
          pointerId: e.pointerId,
          togglePointer: !!toggleEl,
          dragging: false,
        };
        try {
          widget.setPointerCapture(e.pointerId);
        } catch (_) {}
      },
      true
    );

    widget.addEventListener('pointermove', (e) => {
      if (!widgetDrag || e.pointerId !== widgetDrag.pointerId) return;
      const dx = e.clientX - widgetDrag.startX;
      const dy = e.clientY - widgetDrag.startY;
      if (!widgetDrag.dragging) {
        if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
        widgetDrag.dragging = true;
        widget.classList.add('ff-dragging');
      }
      let left = widgetDrag.startLeft + dx;
      let top = widgetDrag.startTop + dy;
      const c = clampWidgetPosition(left, top);
      applyWidgetPosition(c.left, c.top);
    });

    widget.addEventListener('pointerup', (e) => {
      if (!widgetDrag || e.pointerId !== widgetDrag.pointerId) return;
      const wasDrag = widgetDrag.dragging;
      const fromToggle = widgetDrag.togglePointer;
      try {
        widget.releasePointerCapture(e.pointerId);
      } catch (_) {}
      widget.classList.remove('ff-dragging');
      widgetDrag = null;

      if (wasDrag) {
        const rect = widget.getBoundingClientRect();
        persistWidgetPosition(rect.left, rect.top);
        e.preventDefault();
        return;
      }
      if (fromToggle) {
        document.getElementById('ff-card').classList.toggle('open');
        const rect = widget.getBoundingClientRect();
        const c = clampWidgetPosition(rect.left, rect.top);
        applyWidgetPosition(c.left, c.top);
      }
    });

    widget.addEventListener('pointercancel', (e) => {
      if (!widgetDrag || e.pointerId !== widgetDrag.pointerId) return;
      try {
        widget.releasePointerCapture(e.pointerId);
      } catch (_) {}
      widget.classList.remove('ff-dragging');
      if (widgetDrag.dragging) {
        const rect = widget.getBoundingClientRect();
        persistWidgetPosition(rect.left, rect.top);
      }
      widgetDrag = null;
    });

    let resizeT = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeT);
      resizeT = setTimeout(() => {
        if (!widget) return;
        const rect = widget.getBoundingClientRect();
        const c = clampWidgetPosition(rect.left, rect.top);
        applyWidgetPosition(c.left, c.top);
      }, 100);
    });
  }

  // ==================== Widget ====================

  function createWidget() {
    if (widget) return;

    widget = document.createElement('div');
    widget.id = 'ff-bda-meet-widget';
    widget.innerHTML = `
      <style>
        #ff-bda-meet-widget {
          position: fixed;
          z-index: 2147483647;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          touch-action: none;
          user-select: none;
          -webkit-user-select: none;
        }
        #ff-bda-meet-widget.ff-dragging { cursor: grabbing; }
        #ff-bda-meet-widget.ff-dragging .ff-toggle { cursor: grabbing; }
        #ff-bda-meet-widget .ff-hdr { cursor: grab; }
        #ff-bda-meet-widget .ff-toggle { cursor: grab; }
        #ff-bda-meet-widget .ff-btn { cursor: pointer; }
        #ff-bda-meet-widget * { box-sizing: border-box; margin: 0; padding: 0; }

        .ff-toggle {
          width: 48px; height: 48px; border-radius: 50%;
          background: linear-gradient(135deg, #ff5722, #ff6b00);
          border: none; cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          box-shadow: 0 4px 16px rgba(255, 87, 34, 0.4);
          transition: transform 0.2s; position: relative;
        }
        .ff-toggle:hover { transform: scale(1.1); }
        .ff-toggle svg { width: 24px; height: 24px; fill: white; }
        .ff-toggle .ff-logo {
          width: 32px; height: 32px; border-radius: 50%;
          object-fit: contain; pointer-events: none;
          -webkit-user-drag: none; user-select: none;
        }
        .ff-toggle .ff-pulse {
          position: absolute; inset: -4px; border-radius: 50%;
          border: 2px solid #ff5722;
          animation: ff-ring 2s ease-in-out infinite;
        }
        .ff-toggle.marked { background: linear-gradient(135deg, #10b981, #059669); }
        .ff-toggle.marked .ff-pulse { display: none; }
        @keyframes ff-ring {
          0%, 100% { opacity: 0; transform: scale(0.8); }
          50% { opacity: 0.6; transform: scale(1.2); }
        }

        .ff-card {
          position: absolute; bottom: 56px; left: 0; width: 280px;
          background: white; border-radius: 12px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
          overflow: hidden; display: none;
        }
        .ff-card.open { display: block; animation: ff-up 0.2s ease-out; }
        @keyframes ff-up {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .ff-hdr {
          padding: 12px 14px;
          background: linear-gradient(135deg, #ff5722, #ff6b00);
          color: white;
        }
        .ff-hdr h3 { font-size: 13px; font-weight: 700; }
        .ff-hdr p { font-size: 11px; opacity: 0.85; margin-top: 2px; }

        .ff-body { padding: 12px 14px; }

        .ff-row {
          display: flex; align-items: center; gap: 8px;
          margin-bottom: 8px; font-size: 12px; color: #374151;
        }
        .ff-dot {
          width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
        }
        .ff-dot.detecting { background: #f59e0b; animation: ff-blink 1.5s infinite; }
        .ff-dot.in-call { background: #10b981; }
        .ff-dot.present { background: #10b981; }
        .ff-dot.idle { background: #9ca3af; }
        @keyframes ff-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

        .ff-dur { font-size: 11px; color: #6b7280; margin-bottom: 10px; }
        .ff-dur span { font-weight: 600; color: #374151; }

        .ff-stats {
          display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
          margin-bottom: 10px;
        }
        .ff-stat {
          display: flex; flex-direction: column; gap: 2px;
          padding: 8px 10px; background: #f9fafb;
          border: 1px solid #f3f4f6; border-radius: 8px;
        }
        .ff-stat-l {
          font-size: 9px; font-weight: 700; letter-spacing: 0.5px;
          text-transform: uppercase; color: #9ca3af;
        }
        .ff-stat-v {
          font-size: 15px; font-weight: 700; color: #374151;
          font-variant-numeric: tabular-nums;
        }
        .ff-stat-v.ff-stat-dur { color: #ff5722; }

        .ff-info {
          font-size: 11px; color: #6b7280; margin-bottom: 10px;
          padding: 8px; background: #f9fafb; border-radius: 6px;
        }
        .ff-info strong { color: #374151; }

        .ff-btn {
          width: 100%; padding: 8px;
          background: #10b981; color: white; border: none;
          border-radius: 6px; font-size: 12px; font-weight: 600;
          cursor: pointer; transition: background 0.2s;
        }
        .ff-btn:hover { background: #059669; }
        .ff-btn:disabled { background: #d1d5db; color: #6b7280; cursor: not-allowed; }
        .ff-btn.done { background: #ecfdf5; color: #065f46; border: 1px solid #a7f3d0; cursor: default; }

        .ff-end-btn {
          width: 100%; padding: 8px; margin-top: 6px;
          background: #dc2626; color: white; border: none;
          border-radius: 6px; font-size: 12px; font-weight: 600;
          cursor: pointer; transition: background 0.2s;
          display: none;
        }
        .ff-end-btn:hover { background: #b91c1c; }
        .ff-end-btn:disabled { background: #d1d5db; color: #6b7280; cursor: not-allowed; }

        .ff-ext-end {
          display: none;
          margin-top: 8px;
          padding: 6px 14px;
          background: #dc2626; color: white; border: none;
          border-radius: 20px; font-size: 11px; font-weight: 600;
          cursor: pointer; transition: background 0.2s;
          box-shadow: 0 2px 8px rgba(220, 38, 38, 0.4);
          white-space: nowrap;
        }
        .ff-ext-end:hover { background: #b91c1c; }
        .ff-ext-end:disabled { background: #d1d5db; cursor: not-allowed; }

        .ff-ext-mark {
          display: none;
          margin-top: 8px;
          padding: 6px 14px;
          background: #10b981; color: white; border: none;
          border-radius: 20px; font-size: 11px; font-weight: 600;
          cursor: pointer; transition: background 0.2s;
          box-shadow: 0 2px 8px rgba(16, 185, 129, 0.4);
          white-space: nowrap;
        }
        .ff-ext-mark:hover { background: #059669; }
        .ff-ext-mark:disabled { background: #d1d5db; color: #6b7280; cursor: not-allowed; }
        .ff-ext-mark.done { background: #ecfdf5; color: #065f46; border: 1px solid #a7f3d0; cursor: default; }

        .ff-ext-hide {
          display: none;
          margin-top: 6px;
          padding: 4px 12px;
          background: rgba(0,0,0,0.7); color: #d1d5db; border: none;
          border-radius: 20px; font-size: 10px; font-weight: 600;
          cursor: pointer; transition: background 0.2s;
          white-space: nowrap;
        }
        .ff-ext-hide:hover { background: rgba(0,0,0,0.9); color: #fff; }

        .ff-ext-dur {
          display: none;
          margin-top: 4px;
          padding: 2px 10px;
          background: rgba(0,0,0,0.7); color: #fff;
          border-radius: 12px; font-size: 11px; font-weight: 700;
          text-align: center;
          font-variant-numeric: tabular-nums;
        }

        .ff-empty { font-size: 12px; color: #9ca3af; text-align: center; padding: 8px 0; }

        .ff-hdr { position: relative; }
        .ff-hide {
          position: absolute; top: 8px; right: 8px;
          width: 20px; height: 20px; border: none; border-radius: 50%;
          background: rgba(255,255,255,0.25); color: #fff;
          font-size: 11px; line-height: 20px; text-align: center;
          cursor: pointer; padding: 0;
        }
        .ff-hide:hover { background: rgba(255,255,255,0.5); }
      </style>

      <button class="ff-toggle" id="ff-toggle" title="FlashFire Attendance">
        <div class="ff-pulse" id="ff-pulse"></div>
        <img class="ff-logo" src="${chrome.runtime.getURL('icons/icon48.png')}" alt="FlashFire" draggable="false" />
      </button>
      <div class="ff-ext-dur" id="ff-ext-dur">0:00</div>
      <button class="ff-ext-mark" id="ff-ext-mark">Mark Present</button>
      <button class="ff-ext-end" id="ff-ext-end">End Meet</button>
      <button class="ff-ext-hide" id="ff-ext-hide" title="Hide the overlay completely (e.g. while screen sharing). Reopen the extension or reload the page to show it again.">&#x2715; Hide</button>

      <div class="ff-card" id="ff-card">
        <div class="ff-hdr">
          <button class="ff-hide" id="ff-hide" title="Hide the overlay completely (e.g. while screen sharing). Reopen the extension or reload the page to show it again.">&#x2715;</button>
          <h3>FlashFire Attendance</h3>
          <p id="ff-name">Loading...</p>
        </div>
        <div class="ff-body">
          <div class="ff-row">
            <div class="ff-dot detecting" id="ff-dot"></div>
            <span id="ff-status">Detecting call...</span>
          </div>
          <div class="ff-stats" id="ff-dur" style="display:none;">
            <div class="ff-stat">
              <span class="ff-stat-l">In</span>
              <span class="ff-stat-v" id="ff-in-val">—</span>
            </div>
            <div class="ff-stat">
              <span class="ff-stat-l">Duration</span>
              <span class="ff-stat-v ff-stat-dur" id="ff-dur-val">0:00</span>
            </div>
          </div>
          <div class="ff-meet-link" id="ff-meet-link" style="display:none; font-size:9px; color:#9ca3af; margin-bottom:8px; word-break:break-all;"></div>
          <div class="ff-info" id="ff-info" style="display:none;">
            <strong id="ff-client"></strong>
          </div>
          <div id="ff-no-match" class="ff-empty">Scanning for matching meeting...</div>
          <button class="ff-btn" id="ff-btn" style="display:none;">Mark Present</button>
          <button class="ff-end-btn" id="ff-end-btn">End Meet</button>
        </div>
      </div>
    `;

    document.body.appendChild(widget);

    const defPos = defaultWidgetPosition();
    applyWidgetPosition(defPos.left, defPos.top);
    loadWidgetPositionThen(() => {
      attachWidgetDrag();
    });

    document.getElementById('ff-btn').addEventListener('click', () => {
      const btn = document.getElementById('ff-btn');
      if (btn.disabled || btn.classList.contains('done')) return;
      if (!isMarkWindowOpen()) {
        refreshMarkGate();
        return;
      }
      btn.disabled = true;
      btn.dataset.marking = '1';
      btn.textContent = 'Marking...';

      chrome.runtime.sendMessage(
        {
          type: 'MEET_MANUAL_MARK',
          bookingId: currentBooking?.bookingId,
          meetLink: window.location.href,
        },
        (response) => {
          delete btn.dataset.marking;
          if (response?.success) {
            joinReported = true;
            removeFallbackPopup();
            updateWidgetState('present', 'Present - Attendance recorded');
          } else {
            btn.disabled = false;
            btn.textContent = 'Retry - Mark Present';
            if (response?.markedAbsent || response?.error) {
              updateWidgetState('idle', response.error || 'Use the real Meet room link.');
            }
          }
        }
      );
    });

    // End Meet button — manually triggers leave event + beacon
    document.getElementById('ff-end-btn').addEventListener('click', () => {
      const endBtn = document.getElementById('ff-end-btn');
      if (endBtn.disabled) return;

      const duration = getElapsedStr();
      const durationMs = callStartTime ? Date.now() - callStartTime : 0;
      console.log('[FF-MEET] End Meet button clicked. Duration:', duration, `(${Math.round(durationMs / 60000)} min)`, 'Meet:', currentMeetLink || window.location.href);

      endBtn.disabled = true;
      endBtn.textContent = 'Ending...';

      notifyMeetingEnd('meet_widget');

      isInCall = false;
      suppressUntilRejoin = true;
      callStartTime = null;
      joinReported = false;
      clearTimeout(noMatchRetryTimeout);
      noMatchRetryTimeout = null;
      clearSession();
      removeFallbackPopup();
      updateWidgetState('idle', 'Call ended - ' + duration);

      endBtn.textContent = 'Meet Ended';
    });

    // External End Meet button (always visible next to toggle when in-call)
    document.getElementById('ff-ext-end').addEventListener('click', () => {
      // Trigger the same logic as the card End Meet button
      document.getElementById('ff-end-btn').click();
    });

    // External Mark Present button (visible next to toggle in a matched call).
    // Delegates to the card button so gating/marking logic stays in one place.
    document.getElementById('ff-ext-mark').addEventListener('click', () => {
      document.getElementById('ff-btn').click();
    });

    // Hide the whole overlay (widget + popup) for screen sharing. Tracking
    // continues invisibly; reload or opening the extension panel restores it.
    bindHideControl(document.getElementById('ff-hide'));
    bindHideControl(document.getElementById('ff-ext-hide'));
  }

  function endMeetAction() {
    const duration = getElapsedStr();
    const durationMs = callStartTime ? Date.now() - callStartTime : 0;
    console.log('[FF-MEET] End Meet. Duration:', duration, `(${Math.round(durationMs / 60000)} min)`, 'Meet:', currentMeetLink || window.location.href);

    notifyMeetingEnd('meet_widget');

    isInCall = false;
    clearSession();
    removeFallbackPopup();
    updateWidgetState('idle', 'Call ended - ' + duration);
  }

  function updateWidgetState(state, text) {
    const dot = document.getElementById('ff-dot');
    const status = document.getElementById('ff-status');
    const toggle = document.getElementById('ff-toggle');
    const btn = document.getElementById('ff-btn');
    const endBtn = document.getElementById('ff-end-btn');
    const extEnd = document.getElementById('ff-ext-end');
    const extMark = document.getElementById('ff-ext-mark');
    const extDur = document.getElementById('ff-ext-dur');
    const dur = document.getElementById('ff-dur');
    const meetLinkEl = document.getElementById('ff-meet-link');
    const noMatch = document.getElementById('ff-no-match');

    if (dot) dot.className = 'ff-dot ' + state;
    if (status) status.textContent = text;

    // Toggle button styling
    if (toggle) {
      if (state === 'present') toggle.classList.add('marked');
      else toggle.classList.remove('marked');
    }

    // Mark Present button
    if (state === 'present' && btn) {
      btn.textContent = 'Marked Present';
      btn.classList.add('done');
      btn.disabled = true;
    }

    // Show duration + meet link + End Meet when in-call or present
    if (state === 'in-call' || state === 'present') {
      if (dur) dur.style.display = 'grid';
      if (noMatch) noMatch.style.display = 'none';
      if (meetLinkEl) {
        meetLinkEl.style.display = 'block';
        meetLinkEl.textContent = window.location.href;
      }
      // Card End Meet button
      if (endBtn) {
        endBtn.style.display = 'block';
        endBtn.disabled = false;
        endBtn.textContent = 'End Meet';
      }
      // External End Meet button + duration (always visible next to toggle)
      if (extEnd) {
        extEnd.style.display = 'block';
        extEnd.disabled = false;
        extEnd.textContent = 'End Meet';
      }
      if (extDur) {
        extDur.style.display = 'block';
        extDur.textContent = getElapsedStr();
      }
      const extHide = document.getElementById('ff-ext-hide');
      if (extHide) extHide.style.display = 'block';
      // External Mark Present pill — only for a matched booking; flips to a
      // green "✓ Present" once attendance is recorded.
      if (extMark) {
        if (state === 'present' || joinReported) {
          extMark.style.display = 'block';
          extMark.textContent = '✓ Present';
          extMark.classList.add('done');
          extMark.disabled = true;
        } else if (currentBooking) {
          extMark.style.display = 'block';
        } else {
          extMark.style.display = 'none';
        }
      }
    } else if (state === 'idle') {
      if (endBtn) endBtn.style.display = 'none';
      if (extEnd) { extEnd.style.display = 'none'; }
      const extHideIdle = document.getElementById('ff-ext-hide');
      if (extHideIdle) extHideIdle.style.display = 'none';
      if (extMark) {
        extMark.style.display = 'none';
        extMark.classList.remove('done');
        extMark.disabled = false;
        extMark.textContent = 'Mark Present';
      }
      if (extDur) { extDur.style.display = 'none'; }
      if (meetLinkEl) meetLinkEl.style.display = 'none';
    }

    // Always remove fallback popup when marked present
    if (state === 'present') {
      removeFallbackPopup();
    }

    // Show meeting info
    if (currentBooking) {
      const info = document.getElementById('ff-info');
      const client = document.getElementById('ff-client');
      const btnEl = document.getElementById('ff-btn');
      if (info) info.style.display = 'block';
      if (client) client.textContent = 'Meeting: ' + currentBooking.clientName;
      if (noMatch) noMatch.style.display = 'none';
      if (btnEl && btnEl.style.display === 'none') btnEl.style.display = 'block';
      refreshMarkGate();
    }
  }

  // ==================== Stay-on-top watchdog ====================

  // Google Meet is an SPA that constantly rebuilds its DOM and toggles fullscreen.
  // Keep the widget parented to whatever is currently on screen (the fullscreen
  // element when one is active, else <body>), as the LAST child so nothing paints
  // over it, and re-assert the max z-index in case Meet's CSS clobbers it.
  function keepWidgetOnTop() {
    if (!widget) return;
    // Never yank the node mid-drag — it would drop the pointer capture.
    if (widgetDrag && widgetDrag.dragging) return;

    const host = document.fullscreenElement || document.body;
    if (!host) return;

    // Re-attach only when the widget was removed or the render root changed
    // (e.g. fullscreen). The max z-index already keeps it above Meet's own layers,
    // so we avoid re-appending on every DOM mutation, which would restart the
    // toggle's pulse animation and cause flicker.
    if (widget.parentElement !== host) {
      host.appendChild(widget);
    }
    if (widget.style.zIndex !== '2147483647') {
      widget.style.zIndex = '2147483647';
    }
    // Re-assert the hidden state — nothing may resurface the overlay while
    // the BDA is screen sharing.
    if (overlayHidden && widget.style.display !== 'none') {
      widget.style.setProperty('display', 'none', 'important');
    }
  }

  // ==================== Mark Present timing gate ====================

  // True when manual Mark Present is allowed: from (scheduledStart - 1 min) onward.
  // If we don't yet know the scheduled start (e.g. restored session with no match),
  // don't block — auto-detection and the server still guard against bad marks.
  function isMarkWindowOpen() {
    const startIso = currentBooking?.scheduledStart;
    if (!startIso) return true;
    const startMs = new Date(startIso).getTime();
    if (Number.isNaN(startMs)) return true;
    return Date.now() >= startMs - MARK_WINDOW_LEAD_MS;
  }

  // Enable/disable the card's Mark Present button based on the timing window.
  // Leaves a recorded 'present'/'done' button untouched.
  function refreshMarkGate() {
    const btn = document.getElementById('ff-btn');
    if (!btn || joinReported || btn.classList.contains('done')) return;
    if (btn.dataset.marking === '1') return; // request in flight

    if (isMarkWindowOpen()) {
      if (btn.disabled) {
        btn.disabled = false;
        btn.textContent = 'Mark Present';
      }
    } else {
      btn.disabled = true;
      const startIso = currentBooking?.scheduledStart;
      const t = startIso ? formatClockTime(new Date(startIso).getTime()) : '';
      btn.textContent = t ? `Mark opens near ${t}` : 'Mark Present';
    }

    // Mirror the gate onto the external pill so both buttons agree.
    const ext = document.getElementById('ff-ext-mark');
    if (ext && !ext.classList.contains('done')) {
      ext.disabled = btn.disabled;
      ext.textContent = btn.textContent;
    }
  }

  function updateDuration() {
    if (!isInCall && !callStartTime) return;

    const elapsed = getElapsedStr();

    // Card In time + duration
    const dur = document.getElementById('ff-dur');
    const durVal = document.getElementById('ff-dur-val');
    const inVal = document.getElementById('ff-in-val');
    if (dur) dur.style.display = 'grid';
    if (durVal) durVal.textContent = elapsed;
    if (inVal) inVal.textContent = formatClockTime(callStartTime);

    // External duration (always visible next to toggle)
    const extDur = document.getElementById('ff-ext-dur');
    if (extDur) {
      extDur.style.display = 'block';
      extDur.textContent = elapsed;
    }
  }

  // ==================== Communication ====================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'MEET_BOOKING_INFO') {
      currentBooking = { bookingId: message.bookingId, clientName: message.clientName };
      const clientLabel = message.clientName ? ` - ${message.clientName}` : '';
      if (joinReported) {
        updateWidgetState('present', `Present${clientLabel}`);
      } else if (isInCall) {
        updateWidgetState('in-call', `In call${clientLabel}`);
      } else {
        updateWidgetState('detecting', `Matched: ${message.clientName}`);
      }
      sendResponse({ success: true });
    }

    if (message.type === 'SHOW_OVERLAY') {
      setOverlayHidden(false);
      sendResponse({ success: true });
    }

    // Background recovery asks for the REAL call state: are we in the call,
    // and when was the leave button first seen (true join anchor).
    if (message.type === 'GET_CALL_STATE') {
      sendResponse({
        inCall: isInCall,
        callStartTime: callStartTime || null,
        joinReported,
      });
    }

    if (message.type === 'MEET_ATTENDANCE_CONFIRMED') {
      joinReported = true;
      if (message.bookingId && message.clientName) {
        currentBooking = { bookingId: message.bookingId, clientName: message.clientName };
      }
      removeFallbackPopup();
      const clientLabel = currentBooking?.clientName ? ` - ${currentBooking.clientName}` : '';
      updateWidgetState('present', `Present${clientLabel}`);
      sendResponse({ success: true });
    }

    return true;
  });

  // ==================== Main Loop (MutationObserver + fallback poll) ====================

  let pendingCheck = false;
  let leaveSeenSince = null; // first ms the leave-call button was seen (current streak)
  let leaveGoneSince = null; // first ms the leave-call button went missing (current streak)

  function tick() {
    const present = detectInCall();
    const now = Date.now();

    if (present) {
      leaveGoneSince = null;
      if (leaveSeenSince == null) leaveSeenSince = now;

      // Confirm the join only after the button has persisted for the dwell window.
      // callStartTime anchors to when the button was FIRST seen, so duration counts
      // from the real moment of joining — not from this delayed confirmation.
      if (!isInCall && !suppressUntilRejoin && now - leaveSeenSince >= JOIN_DWELL_MS) {
        console.log('[FF-MEET] Join confirmed (leave-call stable for', JOIN_DWELL_MS / 1000, 's)');
        sessionEndRequestId = null;
        isInCall = true;
        // Keep a restored join time (survives page reload); else anchor to first-seen.
        if (callStartTime == null) callStartTime = leaveSeenSince;
        currentMeetLink = window.location.href;
        saveSession(currentMeetLink, callStartTime);

        updateWidgetState(joinReported ? 'present' : 'in-call', joinReported ? 'Present' : 'In call');
        attachLeaveButtonInterceptor();
        if (!joinReported) onCallDetected();
      } else if (!isInCall && !suppressUntilRejoin) {
        // Dwell in progress — show a verifying state, no report yet.
        updateWidgetState('detecting', 'Verifying join…');
      }
    } else {
      // Leave-call button absent. Require SUSTAINED absence (debounce) before acting —
      // Meet rebuilds its control bar constantly, so one missing tick is a flicker,
      // not a leave. This gates clearing suppressUntilRejoin too: otherwise a single
      // flicker after a manual End Meet would instantly re-arm and re-report.
      leaveSeenSince = null;
      if (leaveGoneSince == null) leaveGoneSince = now;
      if (now - leaveGoneSince >= LEAVE_DEBOUNCE_MS) {
        suppressUntilRejoin = false; // truly left the call — re-arm auto detection
        if (isInCall) onCallEnded();
        leaveGoneSince = null;
      }
    }

    if (isInCall || callStartTime) updateDuration();
    if (isInCall) attachLeaveButtonInterceptor();

    // Keep the widget visible/on-top through Meet's re-renders, and open the
    // Mark Present window exactly at start-1min without needing a fresh match.
    keepWidgetOnTop();
    refreshMarkGate();
  }

  // ==================== Init ====================

  async function init() {
    if (isGoogleMeetLandingUrl(window.location.href)) {
      console.log('[FF-MEET] Skipping widget on Meet landing page');
      return;
    }

    const code = extractMeetCode();
    if (!code || code.length < 3) return; // Not a real meet page

    // Set up observers + the 1s loop only once. Guard synchronously (before the
    // first await) so overlapping callers — load, SPA nav, and the guardian below —
    // can't double-wire the detection loop.
    if (initStarted) return;
    initStarted = true;

    console.log('[FF-MEET] Initializing on meet:', code);
    currentMeetLink = window.location.href;

    // Paint the widget FIRST — before any await — so the floating button is on
    // screen immediately and never depends on chrome.storage/auth/booking replies
    // (a slow or stalled storage callback used to delay the icon indefinitely).
    createWidget();
    keepWidgetOnTop();
    console.log('[FF-MEET] Widget created');

    // Restore session from storage (survives page reload / extension restart)
    const session = await restoreSession();
    if (session && session.meetLink && session.meetLink.includes(code)) {
      callStartTime = session.joinedAt;
      currentMeetLink = session.meetLink;
      if (session.bookingId) {
        currentBooking = { bookingId: session.bookingId, clientName: '' };
      }
      console.log('[FF-MEET] Restored session from storage. Duration so far:', getElapsedStr());
    }

    // Get BDA auth info + cache token for sendBeacon
    chrome.runtime.sendMessage({ type: 'GET_AUTH' }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response?.bdaInfo) {
        bdaInfo = response.bdaInfo;
        authChecked = true;
        const nameEl = document.getElementById('ff-name');
        if (nameEl) {
          const n = bdaInfo.name && String(bdaInfo.name).trim() ? String(bdaInfo.name).trim() : '';
          nameEl.textContent = n || bdaInfo.email || '';
        }
      }
      // Cache token for sendBeacon (sendBeacon can't set Authorization header)
      if (response?.token) {
        storedToken = response.token;
      }
    });

    // Ask background for matched booking
    chrome.runtime.sendMessage(
      { type: 'MEET_TAB_READY', url: window.location.href, meetCode: code },
      (response) => {
        if (chrome.runtime.lastError) return;
        if (response?.booking) {
          currentBooking = response.booking;
          updateWidgetState('detecting', 'Matched: ' + currentBooking.clientName + ' - waiting for call...');
        }
      }
    );

    // Enhanced beforeunload: fire beacon FIRST, then show dialog
    window.addEventListener('beforeunload', (e) => {
      if (isInCall) {
        sendBeaconLeave(); // Guaranteed to fire even during tab close
        e.preventDefault();
        e.returnValue = 'Meeting in progress. Your attendance will be recorded as LEFT if you close.';
      }
    });

    // PRIMARY: MutationObserver for near-instant join/leave detection
    const domObserver = new MutationObserver(() => {
      if (!pendingCheck) {
        pendingCheck = true;
        requestAnimationFrame(() => {
          pendingCheck = false;
          tick();
        });
      }
    });
    domObserver.observe(document.body, { childList: true, subtree: true });

    // Entering/exiting fullscreen changes the render root — re-home immediately so
    // the widget doesn't get hidden behind the fullscreened element.
    document.addEventListener('fullscreenchange', keepWidgetOnTop);
    document.addEventListener('webkitfullscreenchange', keepWidgetOnTop);

    // 1s loop drives both the live timer AND the join-dwell / leave-debounce state
    // machine, so confirmation windows resolve at second precision even when Google
    // Meet stops mutating the DOM (e.g. while sitting on a missing control bar).
    checkInterval = setInterval(tick, 1000);

    // Initial check
    tick();
  }

  // Guarantee the circular widget is present whenever we're inside a real meeting
  // room. This runs independently of the side panel and of whether a call is
  // active — it covers late/progressive loads, SPA navigation into a room, and any
  // moment Meet rips the node out of the DOM.
  function ensureWidgetPresent() {
    if (isGoogleMeetLandingUrl(location.href)) return;
    const code = extractMeetCode();
    if (!code || code.length < 3) return; // only inside an actual meeting room
    if (!initStarted) {
      init(); // first time on this page: wire observers + call detection + widget
      return;
    }
    if (!widget) createWidget(); // Meet removed it entirely — rebuild from scratch
    keepWidgetOnTop();           // re-attach a detached node + re-assert max z-index
  }

  // Google Meet loads progressively — first attempt shortly after load.
  if (document.readyState === 'complete') {
    setTimeout(init, 1500);
  } else {
    window.addEventListener('load', () => setTimeout(init, 1500));
  }

  // Persistent guardian: the safety net that keeps the button always there. 2s is
  // frequent enough to feel instant and costs only a couple of DOM checks.
  setInterval(ensureWidgetPresent, 2000);
  ensureWidgetPresent();

  // React instantly to SPA URL changes so joining a room doesn't wait up to 2s.
  let lastUrl = location.href;
  const navObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(ensureWidgetPresent, 800);
    }
  });
  navObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
})();
