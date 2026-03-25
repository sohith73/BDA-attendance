// ==================== FlashFire BDA Attendance - Google Meet Content Script ====================
// Injected ONLY into meet.google.com/* pages
// PRIMARY auto-detection: detects when BDA joins a call and immediately reports to background
// Uses MutationObserver for near-instant join/leave detection + sendBeacon for reliable leave reporting

(function () {
  if (window.__ffMeetContentInjected) return;
  window.__ffMeetContentInjected = true;

  // ==================== Constants ====================

  const BEACON_LEAVE_URL = 'https://flashfire-backend-9wv0.onrender.com/api/bda-attendance/beacon-leave';
  const FALLBACK_POPUP_DELAY_MS = 30000; // Show fallback popup after 30s if auto-attendance fails
  const FALLBACK_POLL_INTERVAL_MS = 10000; // 10s safety-net poll (backup for MutationObserver)

  // ==================== State ====================

  let currentBooking = null; // { bookingId, clientName }
  let isInCall = false;
  let joinReported = false;
  let callStartTime = null;
  let checkInterval = null;
  let widget = null;
  let bdaInfo = null;
  let authChecked = false;
  let storedToken = null; // Cached for sendBeacon (can't set auth headers)
  let fallbackPopupTimeout = null;
  let beaconSent = false; // Prevent duplicate beacons per session

  const FF_WIDGET_POS_KEY = 'ffMeetWidgetPos';
  const DRAG_THRESHOLD_PX = 8;
  let widgetDrag = null;

  // ==================== Call State Detection ====================

  function detectInCall() {
    // Strategy 1: "Leave call" button exists (most reliable)
    const leaveBtn =
      document.querySelector('[aria-label="Leave call"]') ||
      document.querySelector('[aria-label="leave call"]') ||
      document.querySelector('[data-tooltip="Leave call"]') ||
      document.querySelector('button[jsname="CQylAd"]');
    if (leaveBtn) return true;

    // Strategy 2: Microphone/camera controls visible (in-call UI)
    const micBtn =
      document.querySelector('[aria-label="Turn off microphone"]') ||
      document.querySelector('[aria-label="Turn on microphone"]') ||
      document.querySelector('[data-tooltip="Turn off microphone"]') ||
      document.querySelector('[data-tooltip="Turn on microphone"]');
    if (micBtn) return true;

    // Strategy 3: Video elements present (participants' videos)
    const videos = document.querySelectorAll('video');
    if (videos.length > 0) return true;

    // Strategy 4: Self-view or participant count visible
    const participantCount = document.querySelector('[aria-label*="participant"]');
    if (participantCount) return true;

    return false;
  }

  // ==================== sendBeacon Leave (fire-and-forget) ====================

  function sendBeaconLeave() {
    if (beaconSent || !currentBooking?.bookingId || !storedToken) return;
    beaconSent = true;

    try {
      const blob = new Blob(
        [
          JSON.stringify({
            bookingId: currentBooking.bookingId,
            leftAt: new Date().toISOString(),
            token: storedToken,
            source: 'beacon',
          }),
        ],
        { type: 'application/json' }
      );
      navigator.sendBeacon(BEACON_LEAVE_URL, blob);
      console.log('[FF-MEET] Beacon leave sent for', currentBooking.bookingId);
    } catch (err) {
      console.warn('[FF-MEET] sendBeacon failed:', err.message);
      beaconSent = false; // Allow retry
    }
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
    const mins = Math.floor(elapsed / 60000);
    const secs = Math.floor((elapsed % 60000) / 1000);
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }

  // ==================== Fallback In-Page Popup ====================

  function showFallbackPopup() {
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
          min-width: 320px;
          max-width: 420px;
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
          font-size: 14px;
          font-weight: 700;
          color: #dc2626;
          margin-bottom: 6px;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .ff-popup-msg {
          font-size: 12px;
          color: #4b5563;
          margin-bottom: 12px;
          line-height: 1.4;
        }
        .ff-popup-actions {
          display: flex;
          gap: 8px;
        }
        .ff-popup-mark {
          flex: 1;
          padding: 8px 16px;
          background: #10b981;
          color: white;
          border: none;
          border-radius: 8px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.2s;
        }
        .ff-popup-mark:hover { background: #059669; }
        .ff-popup-mark:disabled { background: #d1d5db; color: #6b7280; cursor: not-allowed; }
        .ff-popup-min {
          padding: 8px 12px;
          background: #f3f4f6;
          color: #6b7280;
          border: none;
          border-radius: 8px;
          font-size: 12px;
          cursor: pointer;
          transition: background 0.2s;
        }
        .ff-popup-min:hover { background: #e5e7eb; }
      </style>
      <div class="ff-popup-card" id="ff-popup-card">
        <div class="ff-popup-full">
          <div class="ff-popup-title">
            <span>Attendance Not Detected</span>
          </div>
          <div class="ff-popup-msg">
            ${
              hasBooking
                ? `Auto-attendance could not be confirmed for <strong>${clientName}</strong>. Please mark your presence manually.`
                : `No scheduled meeting found for this call. If you have a meeting now, please mark present or contact admin.`
            }
          </div>
          <div class="ff-popup-actions">
            <button class="ff-popup-mark" id="ff-popup-mark-btn"${hasBooking ? '' : ' disabled'}>
              ${hasBooking ? 'Mark Present' : 'No Meeting Found'}
            </button>
            <button class="ff-popup-min" id="ff-popup-min-btn">Minimize</button>
          </div>
        </div>
        <div class="ff-popup-pill">
          <div class="ff-popup-pill-dot"></div>
          <span>Attendance pending — tap to mark</span>
        </div>
      </div>
    `;

    document.body.appendChild(popup);

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
              markBtn.textContent = 'Retry - Mark Present';
            }
          }
        );
      });
    }

    // Minimize button
    const minBtn = document.getElementById('ff-popup-min-btn');
    if (minBtn) {
      minBtn.addEventListener('click', () => {
        const card = document.getElementById('ff-popup-card');
        if (card) card.classList.add('minimized');
      });
    }

    // Click pill to expand
    popup.addEventListener('click', (e) => {
      const card = document.getElementById('ff-popup-card');
      if (card?.classList.contains('minimized') && !e.target.closest('.ff-popup-mark')) {
        card.classList.remove('minimized');
      }
    });
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

    // Immediately tell background to report join
    chrome.runtime.sendMessage(
      {
        type: 'MEET_AUTO_JOIN',
        url: window.location.href,
        meetCode: extractMeetCode(),
        joinedAt: new Date().toISOString(),
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
          updateWidgetState('present', 'Auto-detected - Present');
          console.log('[FF-MEET] Join reported successfully!', response.booking?.clientName);
        } else if (response?.noMatch) {
          console.log('[FF-MEET] No matching meeting found, will retry...');
          setTimeout(onCallDetected, 10000);
        } else {
          console.warn('[FF-MEET] Join report failed:', response?.error);
        }
      }
    );
  }

  function onCallEnded() {
    if (!isInCall) return;
    isInCall = false;

    const duration = scrapeMeetDuration() || getElapsedStr();
    console.log('[FF-MEET] Call ended. Duration:', duration);

    // Fire beacon as redundant safety (in case chrome.runtime.sendMessage fails)
    sendBeaconLeave();

    // Also notify background via normal message passing
    chrome.runtime.sendMessage({
      type: 'MEET_CALL_ENDED',
      url: window.location.href,
      duration,
      durationMs: callStartTime ? Date.now() - callStartTime : 0,
    });

    removeFallbackPopup();
    updateWidgetState('idle', 'Call ended - ' + duration);
  }

  // ==================== Utility ====================

  function extractMeetCode() {
    const match = window.location.href.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/);
    if (match) return match[1];
    const match2 = window.location.href.match(/meet\.google\.com\/([a-zA-Z0-9_-]+)/);
    return match2 ? match2[1].toLowerCase() : null;
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
        if (e.target.closest('#ff-btn')) return;
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
          z-index: 2147483646;
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

        .ff-empty { font-size: 12px; color: #9ca3af; text-align: center; padding: 8px 0; }
      </style>

      <button class="ff-toggle" id="ff-toggle" title="FlashFire Attendance">
        <div class="ff-pulse" id="ff-pulse"></div>
        <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
      </button>

      <div class="ff-card" id="ff-card">
        <div class="ff-hdr">
          <h3>FlashFire Attendance</h3>
          <p id="ff-name">Loading...</p>
        </div>
        <div class="ff-body">
          <div class="ff-row">
            <div class="ff-dot detecting" id="ff-dot"></div>
            <span id="ff-status">Detecting call...</span>
          </div>
          <div class="ff-dur" id="ff-dur" style="display:none;">
            Duration: <span id="ff-dur-val">0:00</span>
          </div>
          <div class="ff-info" id="ff-info" style="display:none;">
            <strong id="ff-client"></strong>
          </div>
          <div id="ff-no-match" class="ff-empty">Scanning for matching meeting...</div>
          <button class="ff-btn" id="ff-btn" style="display:none;">Mark Present</button>
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
      btn.disabled = true;
      btn.textContent = 'Marking...';

      chrome.runtime.sendMessage(
        {
          type: 'MEET_MANUAL_MARK',
          bookingId: currentBooking?.bookingId,
          meetLink: window.location.href,
        },
        (response) => {
          if (response?.success) {
            joinReported = true;
            removeFallbackPopup();
            updateWidgetState('present', 'Present - Attendance recorded');
          } else {
            btn.disabled = false;
            btn.textContent = 'Retry - Mark Present';
          }
        }
      );
    });
  }

  function updateWidgetState(state, text) {
    const dot = document.getElementById('ff-dot');
    const status = document.getElementById('ff-status');
    const toggle = document.getElementById('ff-toggle');
    const btn = document.getElementById('ff-btn');

    if (dot) dot.className = 'ff-dot ' + state;
    if (status) status.textContent = text;

    if (state === 'present' && toggle) {
      toggle.classList.add('marked');
    }
    if (state === 'present' && btn) {
      btn.textContent = 'Marked Present';
      btn.classList.add('done');
      btn.disabled = true;
    }

    // Show meeting info
    if (currentBooking) {
      const info = document.getElementById('ff-info');
      const client = document.getElementById('ff-client');
      const noMatch = document.getElementById('ff-no-match');
      const btnEl = document.getElementById('ff-btn');
      if (info) info.style.display = 'block';
      if (client) client.textContent = 'Meeting: ' + currentBooking.clientName;
      if (noMatch) noMatch.style.display = 'none';
      if (btnEl && btnEl.style.display === 'none') btnEl.style.display = 'block';
    }
  }

  function updateDuration() {
    const dur = document.getElementById('ff-dur');
    const durVal = document.getElementById('ff-dur-val');
    if (!dur || !durVal) return;

    if (!isInCall && !callStartTime) return;

    dur.style.display = 'block';
    const scraped = scrapeMeetDuration();
    durVal.textContent = scraped || getElapsedStr();
  }

  // ==================== Communication ====================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'MEET_BOOKING_INFO') {
      currentBooking = { bookingId: message.bookingId, clientName: message.clientName };
      updateWidgetState(joinReported ? 'present' : 'in-call', joinReported ? 'Present' : 'Matched - waiting for call...');
      sendResponse({ success: true });
    }

    if (message.type === 'MEET_ATTENDANCE_CONFIRMED') {
      joinReported = true;
      removeFallbackPopup();
      updateWidgetState('present', 'Present - Attendance recorded');
      sendResponse({ success: true });
    }

    return true;
  });

  // ==================== Main Loop (MutationObserver + fallback poll) ====================

  let prevInCall = false;
  let pendingCheck = false;

  function tick() {
    const nowInCall = detectInCall();

    // Transition: not in call -> in call
    if (nowInCall && !prevInCall) {
      console.log('[FF-MEET] Call joined!');
      isInCall = true;
      callStartTime = Date.now();
      updateWidgetState('in-call', 'In call - reporting...');

      // Attach leave button interceptor
      attachLeaveButtonInterceptor();

      // Immediately report join
      if (!joinReported) {
        onCallDetected();
      }
    }

    // Transition: in call -> not in call
    if (!nowInCall && prevInCall) {
      onCallEnded();
    }

    prevInCall = nowInCall;

    // Keep duration updated
    if (isInCall || callStartTime) {
      updateDuration();
    }

    // Re-attach leave button interceptor periodically (Meet may recreate buttons)
    if (isInCall) {
      attachLeaveButtonInterceptor();
    }
  }

  // ==================== Init ====================

  function init() {
    const code = extractMeetCode();
    if (!code || code.length < 3) return; // Not a real meet page

    console.log('[FF-MEET] Initializing on meet:', code);
    createWidget();

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

    // FALLBACK: 10s poll as safety net (in case MutationObserver misses something)
    checkInterval = setInterval(tick, FALLBACK_POLL_INTERVAL_MS);

    // Initial check
    tick();
  }

  // Google Meet loads progressively — wait for DOM to be ready
  if (document.readyState === 'complete') {
    setTimeout(init, 1500);
  } else {
    window.addEventListener('load', () => setTimeout(init, 1500));
  }

  // Also handle SPA navigation within Meet
  let lastUrl = location.href;
  const navObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      const code = extractMeetCode();
      if (code && code.length >= 3 && !widget) {
        setTimeout(init, 1500);
      }
    }
  });
  navObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
})();
