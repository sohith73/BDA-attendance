// ==================== FlashFire BDA Attendance - Content Script ====================
(function () {
  if (window.__bdaAttendancePanelInjected) return;
  window.__bdaAttendancePanelInjected = true;

  let panelContainer = null;
  let isVisible = false;

  function createPanel() {
    if (panelContainer) return;

    panelContainer = document.createElement('div');
    panelContainer.id = 'bda-attendance-panel-container';
    panelContainer.style.cssText = `
      position: fixed;
      top: 0;
      right: 0;
      width: 380px;
      height: 100vh;
      z-index: 2147483647;
      display: none;
      box-shadow: -4px 0 24px rgba(0, 0, 0, 0.12);
      transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      transform: translateX(100%);
    `;

    const iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('panel.html');
    iframe.style.cssText = `
      width: 100%;
      height: 100%;
      border: none;
      background: white;
    `;

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '\u00D7';
    closeBtn.style.cssText = `
      position: absolute;
      top: 8px;
      left: -36px;
      width: 32px;
      height: 32px;
      border-radius: 8px 0 0 8px;
      background: #ff5722;
      color: white;
      border: none;
      font-size: 18px;
      font-weight: bold;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: -2px 2px 8px rgba(0, 0, 0, 0.15);
      z-index: 2147483647;
      transition: background 0.2s;
    `;
    closeBtn.addEventListener('mouseenter', () => {
      closeBtn.style.background = '#e64a19';
    });
    closeBtn.addEventListener('mouseleave', () => {
      closeBtn.style.background = '#ff5722';
    });
    closeBtn.addEventListener('click', () => {
      togglePanel(false);
    });

    panelContainer.appendChild(closeBtn);
    panelContainer.appendChild(iframe);
    document.body.appendChild(panelContainer);
  }

  function togglePanel(show) {
    createPanel();
    if (show === undefined) show = !isVisible;

    if (show) {
      panelContainer.style.display = 'block';
      requestAnimationFrame(() => {
        panelContainer.style.transform = 'translateX(0)';
      });
    } else {
      panelContainer.style.transform = 'translateX(100%)';
      setTimeout(() => {
        panelContainer.style.display = 'none';
      }, 300);
    }
    isVisible = show;
  }

  // Listen for messages from background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'togglePanel') {
      togglePanel();
      sendResponse({ success: true });
    }
    return true;
  });
})();
