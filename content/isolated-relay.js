// content/isolated-relay.js
// Runs in ISOLATED world on https://flow.google.com/* and https://labs.google/fx/*
// Relays messages between MAIN world (main-api-bridge.js) and Extension Service Worker.
// Performs ZERO DOM manipulation.

(function () {
  const RELAY_VERSION = '0.3.11';
  if (window.__ANTIGRAVITY_FLOW_ISOLATED_RELAY_VERSION__ === RELAY_VERSION) return;
  window.__ANTIGRAVITY_FLOW_ISOLATED_RELAY_VERSION__ = RELAY_VERSION;

  const BRIDGE_SOURCE_MAIN = 'ANTIGRAVITY_FLOW_MAIN_BRIDGE';
  const BRIDGE_SOURCE_ISOLATED = 'ANTIGRAVITY_FLOW_ISOLATED_RELAY';

  const pendingRequests = window.__ANTIGRAVITY_PENDING_REQS__ || new Map();
  window.__ANTIGRAVITY_PENDING_REQS__ = pendingRequests;

  if (!window.__ANTIGRAVITY_ISOLATED_LISTENERS_BOUND__) {
    window.__ANTIGRAVITY_ISOLATED_LISTENERS_BOUND__ = true;

    // Listen for packets and command responses posted from MAIN world
    window.addEventListener('message', (event) => {
      if (event.source !== window || !event.data) return;
      if (event.data.source !== BRIDGE_SOURCE_MAIN) return;

      const { type, requestId, payload } = event.data;

      if (type === 'COMMAND_RESPONSE' && requestId && pendingRequests.has(requestId)) {
        const resolve = pendingRequests.get(requestId);
        pendingRequests.delete(requestId);
        resolve(payload);
        return;
      }

      if (type === 'API_PACKET_CAPTURED') {
        chrome.runtime.sendMessage({
          type: 'FLOW_API_PACKET_CAPTURED',
          payload
        }).catch(() => {});
        return;
      }

      if (type === 'RECAPTCHA_META_CAPTURED') {
        chrome.runtime.sendMessage({
          type: 'FLOW_RECAPTCHA_META_CAPTURED',
          payload
        }).catch(() => {});
      }
    });

    // Listen for commands from Service Worker / Workbench
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || !message.type) return;

      if (message.type === 'PING_ISOLATED_RELAY') {
        sendResponse({
          ok: true,
          relayVersion: window.__ANTIGRAVITY_FLOW_ISOLATED_RELAY_VERSION__
        });
        return;
      }

      if (message.type === 'FORWARD_TO_MAIN_BRIDGE') {
        (async () => {
          const timeoutMs = message.timeoutMs || 180000; // 180s for image generation & 2K upscaling
          const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const responsePromise = new Promise((resolve) => {
            pendingRequests.set(requestId, resolve);
            setTimeout(() => {
              if (pendingRequests.has(requestId)) {
                pendingRequests.delete(requestId);
                resolve({
                  ok: false,
                  error: `MAIN world bridge command (${message.command}) timed out after ${Math.round(
                    timeoutMs / 1000
                  )}s`
                });
              }
            }, timeoutMs);
          });

          window.postMessage(
            {
              source: BRIDGE_SOURCE_ISOLATED,
              type: 'EXECUTE_COMMAND',
              requestId,
              command: message.command,
              payload: message.payload || {}
            },
            '*'
          );

          const result = await responsePromise;
          sendResponse(result);
        })();

        return true;
      }
    });
  }
})();
