// background/service-worker.js
// Manifest V3 Service Worker — Ephemeral state is stored in chrome.storage.local

const WORKBENCH_PATH = 'workbench/workbench.html';
const MAX_CAPTURED_RECORDS = 60;
const EXPECTED_BRIDGE_VERSION = '0.2.2';
const FLOW_URL_PATTERNS = [
  'https://flow.google.com/*',
  'https://labs.google/fx/*'
];

/**
 * Open or focus the standalone Workbench tab when the user clicks the extension icon.
 */
chrome.action.onClicked.addListener(async () => {
  try {
    const workbenchUrl = chrome.runtime.getURL(WORKBENCH_PATH);
    const existingTabs = await chrome.tabs.query({ url: workbenchUrl });

    if (existingTabs.length > 0) {
      const targetTab = existingTabs[0];
      await chrome.tabs.update(targetTab.id, { active: true });
      if (targetTab.windowId) {
        await chrome.windows.update(targetTab.windowId, { focused: true });
      }
      return;
    }

    await chrome.tabs.create({ url: workbenchUrl });
  } catch (err) {
    console.error('[FlowAutomator SW] Failed to open workbench tab:', err);
  }
});

/**
 * Find the active or most recent Google Flow tab (https://flow.google.com/* or https://labs.google/fx/*)
 */
async function findGoogleFlowTab() {
  const tabs = await chrome.tabs.query({ url: FLOW_URL_PATTERNS });
  if (!tabs || tabs.length === 0) return null;

  // 1st priority: an active project page on flow.google.com/project/{uuid}
  const projectTab = tabs.find((t) => t.url && t.url.includes('flow.google.com/project/'));
  if (projectTab) return projectTab;

  // 2nd priority: any flow.google.com tab
  const flowDomainTab = tabs.find((t) => t.url && t.url.includes('flow.google.com'));
  if (flowDomainTab) return flowDomainTab;

  // 3rd priority: labs.google/fx/tools/flow
  const labsFlowTab = tabs.find((t) => t.url && t.url.includes('/tools/flow'));
  return labsFlowTab || tabs[0];
}

/**
 * Ensure the latest v0.2.0 content scripts are injected into the target Google Flow tab.
 */
async function ensureBridgeInjected(tabId, forceUpgrade = false) {
  if (!forceUpgrade) {
    try {
      const pingResp = await chrome.tabs.sendMessage(tabId, { type: 'PING_ISOLATED_RELAY' });
      if (pingResp && pingResp.ok && pingResp.relayVersion === EXPECTED_BRIDGE_VERSION) {
        return true;
      }
    } catch {
      // Content script not yet injected or outdated; inject dynamically below
    }
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/main-api-bridge.js'],
      world: 'MAIN'
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/isolated-relay.js'],
      world: 'ISOLATED'
    });
    return true;
  } catch (err) {
    console.warn('[FlowAutomator SW] Dynamic script injection failed:', err.message);
    return false;
  }
}

/**
 * Persist a newly captured & sanitized API packet from Google Flow into chrome.storage.local
 */
async function appendCapturedPacket(packet, senderTab) {
  const {
    capturedPackets = [],
    protocolSummary = {
      projectId: null,
      sessionId: null,
      recaptchaSiteKey: null,
      recaptchaAction: null,
      uploadEndpoint: null,
      generateEndpoint: null,
      upscaleEndpoint: null,
      observedModels: [],
      observedAspectRatios: [],
      sampleUploadRecord: null,
      sampleGenerateRecord: null
    }
  } = await chrome.storage.local.get(['capturedPackets', 'protocolSummary']);

  const enrichedPacket = {
    ...packet,
    tabUrl: senderTab?.url || packet.pageUrl || '',
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  };

  if (packet.extractedMeta) {
    const meta = packet.extractedMeta;
    if (meta.projectId) protocolSummary.projectId = meta.projectId;
    if (meta.wizFSid) protocolSummary.sessionId = meta.wizFSid;
    if (meta.recaptchaSiteKey) protocolSummary.recaptchaSiteKey = meta.recaptchaSiteKey;
    if (meta.recaptchaAction) protocolSummary.recaptchaAction = meta.recaptchaAction;

    if (meta.imageModelName && !protocolSummary.observedModels.includes(meta.imageModelName)) {
      protocolSummary.observedModels.push(meta.imageModelName);
    }
    if (meta.imageAspectRatio && !protocolSummary.observedAspectRatios.includes(meta.imageAspectRatio)) {
      protocolSummary.observedAspectRatios.push(meta.imageAspectRatio);
    }
  }

  if (packet.category === 'UPLOAD_IMAGE') {
    protocolSummary.uploadEndpoint = packet.url;
    protocolSummary.sampleUploadRecord = enrichedPacket;
  } else if (packet.category === 'GENERATE_IMAGES') {
    protocolSummary.generateEndpoint = packet.url;
    protocolSummary.sampleGenerateRecord = enrichedPacket;
  } else if (packet.category === 'UPSCALE_IMAGE') {
    protocolSummary.upscaleEndpoint = packet.url;
  }

  const nextPackets = [enrichedPacket, ...capturedPackets].slice(0, MAX_CAPTURED_RECORDS);
  await chrome.storage.local.set({
    capturedPackets: nextPackets,
    protocolSummary
  });

  await chrome.action.setBadgeText({ text: String(nextPackets.length) });
  await chrome.action.setBadgeBackgroundColor({ color: '#2563EB' });
}

/**
 * Central message listener for Workbench <-> Service Worker <-> Flow Tab communication
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (!message || !message.type) {
        sendResponse({ ok: false, error: 'Invalid message format' });
        return;
      }

      if (message.type === 'FLOW_API_PACKET_CAPTURED') {
        await appendCapturedPacket(message.payload, sender.tab);
        sendResponse({ ok: true });
        return;
      }

      if (message.type === 'FLOW_RECAPTCHA_META_CAPTURED') {
        const { protocolSummary = {} } = await chrome.storage.local.get('protocolSummary');
        if (message.payload?.siteKey) protocolSummary.recaptchaSiteKey = message.payload.siteKey;
        if (message.payload?.action) protocolSummary.recaptchaAction = message.payload.action;
        await chrome.storage.local.set({ protocolSummary });
        sendResponse({ ok: true });
        return;
      }

      if (message.type === 'CHECK_FLOW_CONNECTION') {
        const flowTab = await findGoogleFlowTab();
        if (!flowTab) {
          sendResponse({
            ok: true,
            connected: false,
            reason: 'NO_FLOW_TAB',
            message: '未检测到打开的 Google Flow 标签页 (https://flow.google.com/)'
          });
          return;
        }

        const injected = await ensureBridgeInjected(flowTab.id);
        if (!injected) {
          sendResponse({
            ok: true,
            connected: false,
            tabId: flowTab.id,
            tabUrl: flowTab.url,
            reason: 'BRIDGE_INJECT_FAILED',
            message: '检测到 Google Flow 标签页，但脚本桥接尚未就绪，请刷新该页面'
          });
          return;
        }

        let bridgeStatus = await chrome.tabs.sendMessage(flowTab.id, {
          type: 'FORWARD_TO_MAIN_BRIDGE',
          command: 'GET_FLOW_CONTEXT_STATUS',
          timeoutMs: 15000
        });

        // Hot-upgrade MAIN world script if an older bridgeVersion is still running
        if (!bridgeStatus || bridgeStatus.bridgeVersion !== EXPECTED_BRIDGE_VERSION) {
          await ensureBridgeInjected(flowTab.id, true);
          bridgeStatus = await chrome.tabs.sendMessage(flowTab.id, {
            type: 'FORWARD_TO_MAIN_BRIDGE',
            command: 'GET_FLOW_CONTEXT_STATUS',
            timeoutMs: 15000
          });
        }

        sendResponse({
          ok: true,
          connected: Boolean(bridgeStatus && bridgeStatus.ok),
          tabId: flowTab.id,
          tabUrl: flowTab.url,
          bridgeStatus: bridgeStatus || null
        });
        return;
      }

      if (message.type === 'CLEAR_CAPTURED_PACKETS') {
        await chrome.storage.local.set({
          capturedPackets: [],
          protocolSummary: {
            projectId: null,
            sessionId: null,
            recaptchaSiteKey: null,
            recaptchaAction: null,
            uploadEndpoint: null,
            generateEndpoint: null,
            upscaleEndpoint: null,
            observedModels: [],
            observedAspectRatios: [],
            sampleUploadRecord: null,
            sampleGenerateRecord: null
          }
        });
        await chrome.action.setBadgeText({ text: '' });
        sendResponse({ ok: true });
        return;
      }

      if (message.type === 'EXECUTE_IN_FLOW_TAB') {
        const flowTab = await findGoogleFlowTab();
        if (!flowTab) {
          sendResponse({
            ok: false,
            error: '请先在 Chrome 中打开 Google Flow 项目页面 (https://flow.google.com/project/...)'
          });
          return;
        }
        await ensureBridgeInjected(flowTab.id);
        const result = await chrome.tabs.sendMessage(flowTab.id, {
          type: 'FORWARD_TO_MAIN_BRIDGE',
          command: message.command,
          payload: message.payload || {},
          timeoutMs: message.timeoutMs || 180000
        });
        sendResponse(result);
        return;
      }

      sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
    } catch (err) {
      console.error('[FlowAutomator SW] Message handler error:', err);
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();

  return true;
});
