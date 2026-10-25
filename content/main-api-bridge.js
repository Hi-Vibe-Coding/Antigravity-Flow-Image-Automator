// content/main-api-bridge.js
// Runs in MAIN world at document_start on https://flow.google.com/* and https://labs.google/fx/*
// Strictly NON-DOM:
// 1. Supports Google Flow's Boq/Angular `batchexecute` RPC protocol (/_/AiSandboxAngularFrontend/data/batchexecute)
//    - maseQ: Upload reference image -> returns uploadedMediaId
//    - ogiZ0b: Image-to-Image generation (strictly binds uploadedMediaId in [1][0][2]) -> returns generatedMediaId & 1K signed URL
//    - SPrCad: 2K/4K high-resolution upscale -> returns upscaledMediaId & raw Base64 2K JPEG
//    - as29s: Fetch fresh signed CDN URL for any mediaId
//    - HTrJv: Fetch full account model & parameter catalog
// 2. Decodes URL-encoded `f.req` nested JSON request payloads and `)]}'` + `wrb.fr` nested JSON responses.
// 3. Extracts Google WIZ_global_data session tokens (`at` = SNlM0e, `f.sid` = FdrFJe, `bl` = cfb2h) and reCAPTCHA Enterprise siteKey.

(function () {
  const BRIDGE_VERSION = '0.2.0';
  const BRIDGE_SOURCE_MAIN = 'ANTIGRAVITY_FLOW_MAIN_BRIDGE';
  const BRIDGE_SOURCE_ISOLATED = 'ANTIGRAVITY_FLOW_ISOLATED_RELAY';

  // Background telemetry / history sync RPC IDs to ignore in UI packet table (still used to harvest `at`/`bl`/`f.sid`)
  const IGNORED_TELEMETRY_RPCIDS = new Set(['WuwhI', 'nzlxg']);

  const bridgeState = window.__ANTIGRAVITY_FLOW_BRIDGE_STATE__ || {
    lastSiteKey: null,
    lastAction: null,
    lastProjectId: null,
    wizAtToken: null,
    wizFSid: null,
    wizBuildLabel: null,
    wizUserEmail: null,
    observedRpcIds: [],
    observedModels: [],
    observedAspectRatios: [],
    discoveredImageModels: [],
    catalogFetched: false
  };
  window.__ANTIGRAVITY_FLOW_BRIDGE_STATE__ = bridgeState;
  window.__ANTIGRAVITY_FLOW_BRIDGE_VERSION__ = BRIDGE_VERSION;

  // Use native fetch reference so our own active RPC calls don't recurse infinitely if not needed,
  // though we still log active RPC calls clearly.
  const nativeFetch = window.__ANTIGRAVITY_NATIVE_FETCH__ || window.fetch.bind(window);
  window.__ANTIGRAVITY_NATIVE_FETCH__ = nativeFetch;

  /**
   * Generate uppercase UUID v4 (matching Google Flow's maseQ / ogiZ0b UUID format)
   */
  function generateUpperUuid() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID().toUpperCase();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'
      .replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      })
      .toUpperCase();
  }

  /**
   * Extract projectId from current page URL (e.g. https://flow.google.com/project/97501d80-345a-4374-aa2c-22991179112a)
   */
  function detectProjectIdFromLocation() {
    const match =
      location.pathname.match(/\/project\/([0-9a-fA-F-]{8,}|[^/?#]+)/) ||
      location.href.match(/[?&]projectId=([^&#]+)/);
    if (match && match[1]) {
      bridgeState.lastProjectId = match[1];
      return match[1];
    }
    return bridgeState.lastProjectId;
  }

  /**
   * Normalize potentially relative URLs into full URLs
   */
  function normalizeUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    try {
      return new URL(rawUrl, location.origin).href;
    } catch {
      return rawUrl;
    }
  }

  /**
   * Scan Google's WIZ_global_data and inline <script> tags on flow.google.com for `at` (SNlM0e), `f.sid` (FdrFJe), and `bl` (cfb2h)
   */
  function scanWizGlobalData() {
    try {
      const wiz = window.WIZ_global_data;
      if (wiz && typeof wiz === 'object') {
        if (typeof wiz.SNlM0e === 'string' && wiz.SNlM0e.length > 5) {
          bridgeState.wizAtToken = wiz.SNlM0e;
        }
        if (wiz.FdrFJe !== undefined && wiz.FdrFJe !== null) {
          bridgeState.wizFSid = String(wiz.FdrFJe);
        }
        if (typeof wiz.cfb2h === 'string' && wiz.cfb2h) {
          bridgeState.wizBuildLabel = wiz.cfb2h;
        }
        if (typeof wiz.oPEP7c === 'string' && wiz.oPEP7c) {
          bridgeState.wizUserEmail = wiz.oPEP7c;
        }
      }

      // Fallback: scan inline script text if SNlM0e / cfb2h not yet populated
      if ((!bridgeState.wizAtToken || !bridgeState.wizBuildLabel) && document.scripts) {
        for (let i = 0; i < document.scripts.length; i++) {
          const txt = document.scripts[i].textContent || '';
          if (!txt || (!txt.includes('SNlM0e') && !txt.includes('cfb2h'))) continue;
          if (!bridgeState.wizAtToken) {
            const mAt = txt.match(/"SNlM0e"\s*:\s*"([^"]+)"/);
            if (mAt && mAt[1]) bridgeState.wizAtToken = mAt[1];
          }
          if (!bridgeState.wizFSid) {
            const mSid = txt.match(/"FdrFJe"\s*:\s*"?(-?\d+)"?/);
            if (mSid && mSid[1]) bridgeState.wizFSid = mSid[1];
          }
          if (!bridgeState.wizBuildLabel) {
            const mBl = txt.match(/"cfb2h"\s*:\s*"(boq_[^"]+)"/);
            if (mBl && mBl[1]) bridgeState.wizBuildLabel = mBl[1];
          }
          if (!bridgeState.wizUserEmail) {
            const mEmail = txt.match(/"oPEP7c"\s*:\s*"([^"]+@[^"]+)"/);
            if (mEmail && mEmail[1]) bridgeState.wizUserEmail = mEmail[1];
          }
        }
      }
    } catch {
      // Ignore access errors
    }
  }

  /**
   * Discover reCAPTCHA Enterprise siteKey from performance resource entries, DOM script/iframe tags, or ___grecaptcha_cfg
   */
  function discoverRecaptchaSiteKey() {
    if (bridgeState.lastSiteKey && bridgeState.lastSiteKey.length >= 25) {
      return bridgeState.lastSiteKey;
    }

    try {
      // 1. Check performance resource URLs (e.g. recaptcha/enterprise.js?render=6L... or anchor?ar=1&k=6L...)
      if (typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function') {
        const resources = performance.getEntriesByType('resource') || [];
        for (const r of resources) {
          const name = r.name || '';
          if (name.includes('recaptcha')) {
            const m = name.match(/[?&](?:k|render)=(6L[0-9A-Za-z_-]{30,50})/);
            if (m && m[1]) {
              bridgeState.lastSiteKey = m[1];
              return m[1];
            }
          }
        }
      }

      // 2. Check script and iframe elements in document (read-only attribute check, zero DOM modification)
      if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
        const els = document.querySelectorAll('script[src*="recaptcha"], iframe[src*="recaptcha"]');
        for (const el of els) {
          const src = el.getAttribute('src') || '';
          const m = src.match(/[?&](?:k|render)=(6L[0-9A-Za-z_-]{30,50})/);
          if (m && m[1]) {
            bridgeState.lastSiteKey = m[1];
            return m[1];
          }
        }
      }

      // 3. Check window.___grecaptcha_cfg.clients
      const clients = window.___grecaptcha_cfg?.clients;
      if (clients && typeof clients === 'object') {
        const visited = new Set();
        function findKeyInObj(obj, depth = 0) {
          if (!obj || typeof obj !== 'object' || depth > 5 || visited.has(obj)) return null;
          visited.add(obj);
          for (const val of Object.values(obj)) {
            if (typeof val === 'string' && /^6L[0-9A-Za-z_-]{38}$/.test(val)) {
              return val;
            }
            if (val && typeof val === 'object') {
              const found = findKeyInObj(val, depth + 1);
              if (found) return found;
            }
          }
          return null;
        }
        const cfgKey = findKeyInObj(clients);
        if (cfgKey) {
          bridgeState.lastSiteKey = cfgKey;
          return cfgKey;
        }
      }
    } catch {
      // Ignore
    }

    return bridgeState.lastSiteKey;
  }

  /**
   * Acquire a fresh reCAPTCHA Enterprise token in MAIN world
   */
  async function getFreshRecaptchaToken(actionFallback = 'FLOW_GENERATION') {
    const siteKey = discoverRecaptchaSiteKey();
    const gre = window.grecaptcha?.enterprise || window.grecaptcha;
    if (!gre || typeof gre.execute !== 'function') {
      throw new Error('Google Flow 页面中的 grecaptcha.enterprise 尚未加载完成，请刷新 Flow 页面后重试');
    }
    if (!siteKey) {
      throw new Error('尚未检测到 reCAPTCHA Enterprise SiteKey，请先刷新 Google Flow 页面');
    }

    const action = bridgeState.lastAction || actionFallback;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('获取 reCAPTCHA Enterprise Token 超时 (15秒)'));
      }, 15000);

      try {
        const runExecute = () => {
          Promise.resolve(gre.execute(siteKey, { action }))
            .then((token) => {
              clearTimeout(timer);
              if (!token || typeof token !== 'string') {
                reject(new Error('grecaptcha.enterprise.execute 返回了空 Token'));
                return;
              }
              resolve(token);
            })
            .catch((err) => {
              clearTimeout(timer);
              reject(err);
            });
        };

        if (typeof gre.ready === 'function') {
          gre.ready(runExecute);
        } else {
          runExecute();
        }
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /**
   * Extract rpcids, f.sid, and bl query parameters from a batchexecute URL
   */
  function getRpcIdFromUrl(urlStr) {
    try {
      const u = new URL(urlStr, location.origin);
      const rpcids = u.searchParams.get('rpcids');
      const fSid = u.searchParams.get('f.sid');
      const bl = u.searchParams.get('bl');
      if (fSid) bridgeState.wizFSid = fSid;
      if (bl) bridgeState.wizBuildLabel = bl;
      return rpcids || null;
    } catch {
      const m = urlStr.match(/[?&]rpcids=([^&#]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    }
  }

  /**
   * Harvest `at` token from any URL-encoded body string (even telemetry RPCs like WuwhI)
   */
  function harvestAtTokenFromRawBody(rawBody) {
    if (!rawBody) return;
    try {
      if (typeof rawBody === 'string' && rawBody.includes('at=')) {
        const m = rawBody.match(/(?:^|&)at=([^&]+)/);
        if (m && m[1]) {
          bridgeState.wizAtToken = decodeURIComponent(m[1]);
        }
      } else if (rawBody instanceof URLSearchParams) {
        const at = rawBody.get('at');
        if (at) bridgeState.wizAtToken = at;
      }
    } catch {
      // Ignore
    }
  }

  /**
   * Determine if a request URL belongs to Google Flow's core API/RPC traffic (for UI capture logging)
   */
  function isTargetApiUrl(rawUrl, method = 'GET') {
    const urlStr = normalizeUrl(rawUrl);
    if (!urlStr) return false;
    const lower = urlStr.toLowerCase();

    if (
      lower.endsWith('.js') ||
      lower.endsWith('.css') ||
      lower.endsWith('.woff2') ||
      lower.endsWith('.png') ||
      lower.endsWith('.jpg') ||
      lower.endsWith('.webp') ||
      lower.endsWith('.svg') ||
      lower.endsWith('.ico') ||
      lower.includes('fonts.googleapis.com') ||
      lower.includes('fonts.gstatic.com') ||
      lower.includes('google-analytics.com') ||
      lower.includes('googletagmanager.com') ||
      lower.includes('play.google.com/log') ||
      lower.includes('waa-pa.clients6.google.com') ||
      lower.includes('ogads-pa.clients6.google.com')
    ) {
      return false;
    }

    if (lower.includes('batchexecute')) {
      const rpcId = getRpcIdFromUrl(urlStr);
      if (rpcId && IGNORED_TELEMETRY_RPCIDS.has(rpcId)) {
        return false;
      }
      return true;
    }

    if (lower.includes('aisandbox-pa.googleapis.com') || lower.includes('-pa.googleapis.com')) {
      return true;
    }

    if (
      lower.includes('/fx/api/') ||
      lower.includes('/api/trpc') ||
      lower.includes('flowmedia') ||
      lower.includes('upload')
    ) {
      return true;
    }

    if (
      (lower.includes('flow.google.com') || lower.includes('labs.google')) &&
      method.toUpperCase() === 'POST' &&
      !lower.includes('/recaptcha/')
    ) {
      return true;
    }

    return false;
  }

  async function bodyToStringAsync(body) {
    if (!body) return null;
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof ArrayBuffer) {
      return new TextDecoder('utf-8').decode(body);
    }
    if (ArrayBuffer.isView(body)) {
      return new TextDecoder('utf-8').decode(body);
    }
    if (body instanceof FormData) {
      const parts = [];
      for (const [k, v] of body.entries()) {
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(typeof v === 'string' ? v : '[Blob]')}`);
      }
      return parts.join('&');
    }
    if (body instanceof Blob) {
      return await body.text();
    }
    return String(body);
  }

  function bodyToStringSync(body) {
    if (!body) return null;
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof ArrayBuffer) {
      return new TextDecoder('utf-8').decode(body);
    }
    if (ArrayBuffer.isView(body)) {
      return new TextDecoder('utf-8').decode(body);
    }
    return null;
  }

  /**
   * Parse Google `batchexecute` URL-encoded request body (`f.req=...&at=...`)
   */
  function parseRequestBody(rawBodyStr) {
    if (!rawBodyStr || typeof rawBodyStr !== 'string') return null;

    const trimmed = rawBodyStr.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        // Fall through
      }
    }

    try {
      const params = new URLSearchParams(rawBodyStr);
      const fReqStr = params.get('f.req');
      const atToken = params.get('at');

      if (atToken) {
        bridgeState.wizAtToken = atToken;
      }

      if (fReqStr) {
        const outerEnvelope = JSON.parse(fReqStr);
        const decodedCalls = [];
        const callsArray = Array.isArray(outerEnvelope?.[0]) ? outerEnvelope[0] : outerEnvelope;

        if (Array.isArray(callsArray)) {
          for (const callItem of callsArray) {
            if (Array.isArray(callItem) && callItem.length >= 2) {
              const rpcId = callItem[0];
              const innerStr = callItem[1];
              let parsedInner = innerStr;
              if (typeof innerStr === 'string') {
                try {
                  parsedInner = JSON.parse(innerStr);
                } catch {
                  parsedInner = innerStr;
                }
              }
              decodedCalls.push({
                rpcId,
                parsedArgs: parsedInner,
                callMeta: callItem.slice(2)
              });
            }
          }
        }

        return {
          _format: 'batchexecute_f_req',
          hasAtToken: Boolean(atToken),
          atTokenPreview: atToken ? `${atToken.slice(0, 8)}...` : null,
          calls: decodedCalls.length > 0 ? decodedCalls : outerEnvelope
        };
      }

      const formObj = {};
      for (const [k, v] of params.entries()) {
        formObj[k] = v;
      }
      if (Object.keys(formObj).length > 0) return formObj;
    } catch {
      // Fall through
    }

    return { _rawTextPreview: rawBodyStr.slice(0, 500) };
  }

  /**
   * Parse Google `batchexecute` response (`)]}'\n\n<len>\n[["wrb.fr","<rpcId>","<innerJsonStr>",...]]`)
   */
  function parseResponseBody(respText) {
    if (!respText || typeof respText !== 'string') return null;
    const trimmed = respText.trim();

    if (trimmed.startsWith(")]}'")) {
      const withoutPrefix = trimmed.replace(/^\)\]\}'\s*/, '');
      const lines = withoutPrefix.split(/\r?\n/);
      const wrbChunks = [];

      for (const line of lines) {
        const l = line.trim();
        if (!l || /^\d+$/.test(l)) continue;
        if (l.startsWith('[')) {
          try {
            const parsedLine = JSON.parse(l);
            if (Array.isArray(parsedLine)) {
              for (const item of parsedLine) {
                if (Array.isArray(item) && item[0] === 'wrb.fr') {
                  const rpcId = item[1];
                  const innerRespStr = item[2];
                  let parsedInnerResp = innerRespStr;
                  if (typeof innerRespStr === 'string') {
                    try {
                      parsedInnerResp = JSON.parse(innerRespStr);
                    } catch {
                      parsedInnerResp = innerRespStr;
                    }
                  }
                  wrbChunks.push({
                    rpcId,
                    parsedResult: parsedInnerResp,
                    errorSlot: item[5] || null
                  });
                }
              }
            }
          } catch {
            // Ignore malformed line
          }
        }
      }

      if (wrbChunks.length > 0) {
        // If this is HTrJv, parse model catalog from the full untruncated response!
        for (const chunk of wrbChunks) {
          if (chunk.rpcId === 'HTrJv' && chunk.parsedResult) {
            parseHTrJvModelCatalog(chunk.parsedResult);
          }
        }

        return {
          _format: 'batchexecute_wrb_fr',
          totalResponseBytes: respText.length,
          chunks: wrbChunks
        };
      }
    }

    try {
      return JSON.parse(trimmed);
    } catch {
      return { _rawTextPreview: trimmed.slice(0, 500) };
    }
  }

  /**
   * Parse untruncated HTrJv model catalog response to extract exact image model IDs and display names
   */
  function parseHTrJvModelCatalog(parsedResult) {
    try {
      const root = Array.isArray(parsedResult?.[0]) ? parsedResult[0] : parsedResult;
      if (!Array.isArray(root)) return;

      const displayMap = new Map();
      const foundModels = [];

      // 1. Scan for [key, [displayName]] pairs (typically in root[3])
      for (const section of root) {
        if (!Array.isArray(section)) continue;
        for (const entry of section) {
          if (
            Array.isArray(entry) &&
            typeof entry[0] === 'string' &&
            Array.isArray(entry[1]) &&
            typeof entry[1][0] === 'string'
          ) {
            displayMap.set(entry[0], entry[1][0]);
          }
        }
      }

      // 2. Scan for [familyName, [[variantKey, ...], ...]] groups (typically in root[4] and root[5])
      for (const section of root) {
        if (!Array.isArray(section)) continue;
        for (const group of section) {
          if (
            Array.isArray(group) &&
            typeof group[0] === 'string' &&
            Array.isArray(group[1]) &&
            group[1].length > 0 &&
            Array.isArray(group[1][0]) &&
            typeof group[1][0][0] === 'string'
          ) {
            const groupName = displayMap.get(group[0]) || group[0];
            for (const variant of group[1]) {
              if (Array.isArray(variant) && typeof variant[0] === 'string') {
                const variantKey = variant[0];
                const variantLabel = displayMap.get(variantKey) || groupName;
                const combinedStr = `${groupName} ${variantLabel} ${variantKey}`.toLowerCase();
                if (
                  combinedStr.includes('banana') ||
                  combinedStr.includes('gem_pix') ||
                  combinedStr.includes('narwhal') ||
                  combinedStr.includes('imagen') ||
                  combinedStr.includes('image')
                ) {
                  foundModels.push({
                    modelKey: variantKey,
                    groupName,
                    displayName: `${variantLabel} (${variantKey})`
                  });
                }
              }
            }
          }
        }
      }

      // 3. Also include any direct displayMap entries for Nano Banana / GEM_PIX / NARWHAL / IMAGEN
      for (const [key, label] of displayMap.entries()) {
        const lower = `${key} ${label}`.toLowerCase();
        if (
          lower.includes('banana') ||
          lower.includes('gem_pix') ||
          lower.includes('narwhal') ||
          lower.includes('imagen')
        ) {
          if (!foundModels.some((m) => m.modelKey === key)) {
            foundModels.push({
              modelKey: key,
              groupName: label,
              displayName: `${label} (${key})`
            });
          }
        }
      }

      if (foundModels.length > 0) {
        bridgeState.discoveredImageModels = foundModels;
        bridgeState.catalogFetched = true;
      }
    } catch (err) {
      console.debug('[FlowAutomator Bridge] HTrJv catalog parse notice:', err);
    }
  }

  function classifyEndpoint(urlStr, parsedReq, parsedResp) {
    const rpcId = getRpcIdFromUrl(urlStr);
    if (rpcId) {
      if (!bridgeState.observedRpcIds.includes(rpcId)) {
        bridgeState.observedRpcIds.push(rpcId);
      }
      if (rpcId === 'maseQ') return 'UPLOAD_IMAGE';
      if (rpcId === 'ogiZ0b') return 'GENERATE_IMAGES';
      if (rpcId === 'SPrCad') return 'UPSCALE_IMAGE';

      const reqStr = JSON.stringify(parsedReq || '');
      if (reqStr.includes('image/jpeg') || reqStr.includes('image/png') || reqStr.includes('image/webp')) {
        return 'UPLOAD_IMAGE';
      }
      return `FLOW_RPC_${rpcId}`;
    }

    const lower = urlStr.toLowerCase();
    if (lower.includes('upload')) return 'UPLOAD_IMAGE';
    if (lower.includes('generate')) return 'GENERATE_IMAGES';
    if (lower.includes('upscale')) return 'UPSCALE_IMAGE';
    return 'FLOW_API_OTHER';
  }

  function sanitizeJsonStructure(value, keyName = '') {
    if (value === null || value === undefined) return value;

    if (typeof value === 'string') {
      const lowerKey = String(keyName).toLowerCase();
      if (
        lowerKey.includes('authorization') ||
        lowerKey.includes('cookie') ||
        value.startsWith('ya29.')
      ) {
        return `[REDACTED_TOKEN_LEN_${value.length}_PREFIX_${value.slice(0, 10)}...]`;
      }
      if ((value.startsWith('https://') || value.startsWith('http://')) && value.length <= 600) {
        return value;
      }
      if (value.length > 220) {
        return `[TRUNCATED_STR_LEN_${value.length}_PREFIX_${value.slice(0, 36)}...]`;
      }
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item, idx) => sanitizeJsonStructure(item, `${keyName}[${idx}]`));
    }

    if (typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = sanitizeJsonStructure(v, k);
      }
      return out;
    }

    return value;
  }

  /**
   * Extract key metadata from parsed batchexecute payloads (specifically recognizing ogiZ0b array indices!)
   */
  function extractProtocolMeta(urlStr, parsedReq, parsedResp) {
    scanWizGlobalData();
    discoverRecaptchaSiteKey();
    const rpcId = getRpcIdFromUrl(urlStr);
    const meta = {
      rpcId,
      projectId: detectProjectIdFromLocation(),
      wizFSid: bridgeState.wizFSid,
      wizBuildLabel: bridgeState.wizBuildLabel,
      hasWizAtToken: Boolean(bridgeState.wizAtToken),
      recaptchaSiteKey: bridgeState.lastSiteKey,
      recaptchaAction: bridgeState.lastAction,
      imageModelName: null,
      imageAspectRatio: null,
      hasImageInputs: false,
      returnedUrls: [],
      returnedMediaIds: []
    };

    // Specifically parse ogiZ0b request structure: calls[0].parsedArgs[1][0]
    if (rpcId === 'ogiZ0b' && Array.isArray(parsedReq?.calls)) {
      const args = parsedReq.calls[0]?.parsedArgs;
      const item0 = args?.[1]?.[0];
      if (Array.isArray(item0)) {
        const refInputs = item0[2];
        const aspectEnum = item0[4];
        const modelStr = item0[5];
        if (Array.isArray(refInputs) && refInputs.length > 0 && Array.isArray(refInputs[0]) && refInputs[0][0]) {
          meta.hasImageInputs = true;
        }
        if (aspectEnum !== undefined && aspectEnum !== null) {
          meta.imageAspectRatio = `enum_${aspectEnum}`;
          if (!bridgeState.observedAspectRatios.includes(meta.imageAspectRatio)) {
            bridgeState.observedAspectRatios.push(meta.imageAspectRatio);
          }
        }
        if (typeof modelStr === 'string' && modelStr) {
          meta.imageModelName = modelStr;
          if (!bridgeState.observedModels.includes(modelStr)) {
            bridgeState.observedModels.push(modelStr);
          }
        }
      }
    }

    function scanReqTree(node) {
      if (!node) return;
      if (typeof node === 'string') {
        if (
          !meta.imageModelName &&
          (node.includes('GEM_PIX') ||
            node.includes('IMAGEN') ||
            node.includes('NANO') ||
            node.includes('BANANA') ||
            node.includes('NARWHAL') ||
            node.includes('narwhal'))
        ) {
          meta.imageModelName = node;
          if (!bridgeState.observedModels.includes(node)) {
            bridgeState.observedModels.push(node);
          }
        }
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) scanReqTree(item);
        return;
      }
      if (typeof node === 'object') {
        for (const v of Object.values(node)) scanReqTree(v);
      }
    }
    scanReqTree(parsedReq);

    function scanRespTree(node) {
      if (!node) return;
      if (typeof node === 'string') {
        if (node.startsWith('https://') && meta.returnedUrls.length < 5) {
          meta.returnedUrls.push(node.slice(0, 160));
        } else if (
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(node) &&
          meta.returnedMediaIds.length < 8
        ) {
          meta.returnedMediaIds.push(node);
        }
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) scanRespTree(item);
        return;
      }
      if (typeof node === 'object') {
        for (const v of Object.values(node)) scanRespTree(v);
      }
    }
    scanRespTree(parsedResp);

    return meta;
  }

  /**
   * Hook grecaptcha.enterprise.execute and grecaptcha.enterprise.ready to capture siteKey and action
   */
  function hookRecaptchaEnterprise() {
    discoverRecaptchaSiteKey();
    try {
      const targets = [window.grecaptcha?.enterprise, window.grecaptcha].filter(Boolean);
      for (const gre of targets) {
        if (typeof gre.execute === 'function' && !gre.execute.__antigravityHooked) {
          const origExecute = gre.execute.bind(gre);
          const wrappedExecute = function (siteKey, options) {
            if (siteKey && typeof siteKey === 'string') {
              bridgeState.lastSiteKey = siteKey;
            }
            if (options && typeof options.action === 'string') {
              bridgeState.lastAction = options.action;
            }
            window.postMessage(
              {
                source: BRIDGE_SOURCE_MAIN,
                type: 'RECAPTCHA_META_CAPTURED',
                payload: {
                  siteKey: bridgeState.lastSiteKey,
                  action: bridgeState.lastAction
                }
              },
              '*'
            );
            return origExecute(siteKey, options);
          };
          wrappedExecute.__antigravityHooked = true;
          gre.execute = wrappedExecute;
        }

        if (typeof gre.ready === 'function' && !gre.ready.__antigravityHooked) {
          const origReady = gre.ready.bind(gre);
          const wrappedReady = function (cb) {
            return origReady(() => {
              hookRecaptchaEnterprise();
              if (typeof cb === 'function') cb();
            });
          };
          wrappedReady.__antigravityHooked = true;
          gre.ready = wrappedReady;
        }
      }
    } catch {
      // Ignore
    }
  }

  // Install fetch/XHR interceptors once per window
  if (!window.__ANTIGRAVITY_FLOW_INTERCEPTORS_INSTALLED__) {
    window.__ANTIGRAVITY_FLOW_INTERCEPTORS_INSTALLED__ = true;

    setInterval(() => {
      hookRecaptchaEnterprise();
      scanWizGlobalData();
    }, 1500);

    window.fetch = async function (...args) {
      hookRecaptchaEnterprise();
      scanWizGlobalData();
      detectProjectIdFromLocation();

      let rawUrlStr = '';
      let method = 'GET';
      let headersObj = {};
      let clonedReqForBody = null;
      let initBodyRaw = null;

      try {
        const [input, init] = args;
        if (typeof input === 'string') {
          rawUrlStr = input;
        } else if (input instanceof URL) {
          rawUrlStr = input.href;
        } else if (input && typeof input.url === 'string') {
          rawUrlStr = input.url;
          method = input.method || method;
          if (typeof input.clone === 'function') {
            clonedReqForBody = input.clone();
          }
          if (input.headers && input.headers instanceof Headers) {
            input.headers.forEach((v, k) => {
              headersObj[k] = v;
            });
          }
        }

        if (init) {
          if (init.method) method = init.method;
          if (init.headers) {
            if (init.headers instanceof Headers) {
              init.headers.forEach((v, k) => {
                headersObj[k] = v;
              });
            } else if (Array.isArray(init.headers)) {
              for (const [k, v] of init.headers) headersObj[k] = v;
            } else if (typeof init.headers === 'object') {
              headersObj = { ...headersObj, ...init.headers };
            }
          }
          if (init.body !== undefined && init.body !== null) {
            initBodyRaw = init.body;
          }
        }
      } catch {
        // Non-blocking
      }

      const fullUrl = normalizeUrl(rawUrlStr);
      // Always harvest f.sid, bl, and at token even from ignored telemetry RPCs (WuwhI / nzlxg)
      if (fullUrl.includes('batchexecute')) {
        getRpcIdFromUrl(fullUrl);
        harvestAtTokenFromRawBody(initBodyRaw);
      }

      const shouldCapture = isTargetApiUrl(fullUrl, method);
      const startTime = Date.now();

      const response = await nativeFetch(...args);

      if (shouldCapture) {
        (async () => {
          try {
            const clone = response.clone();
            const durationMs = Date.now() - startTime;

            let rawReqBodyStr = await bodyToStringAsync(initBodyRaw);
            if (!rawReqBodyStr && clonedReqForBody) {
              try {
                rawReqBodyStr = await clonedReqForBody.text();
              } catch {
                // Ignore
              }
            }

            const parsedReq = parseRequestBody(rawReqBodyStr);

            let parsedResp = null;
            const contentType = clone.headers.get('content-type') || '';
            if (!contentType.includes('image/') && !contentType.includes('video/')) {
              const respText = await clone.text();
              if (respText) {
                parsedResp = parseResponseBody(respText);
              }
            }

            const category = classifyEndpoint(fullUrl, parsedReq, parsedResp);
            const extractedMeta = extractProtocolMeta(fullUrl, parsedReq, parsedResp);

            window.postMessage(
              {
                source: BRIDGE_SOURCE_MAIN,
                type: 'API_PACKET_CAPTURED',
                payload: {
                  timestamp: new Date().toISOString(),
                  transport: 'FETCH',
                  category,
                  rpcId: extractedMeta.rpcId,
                  method: method.toUpperCase(),
                  url: fullUrl,
                  status: response.status,
                  durationMs,
                  pageUrl: location.href,
                  requestHeaders: sanitizeJsonStructure(headersObj),
                  requestBody: sanitizeJsonStructure(parsedReq),
                  responseBody: sanitizeJsonStructure(parsedResp),
                  extractedMeta
                }
              },
              '*'
            );
          } catch (err) {
            console.debug('[FlowAutomator Bridge] Fetch capture parse skipped:', err);
          }
        })();
      }

      return response;
    };

    const origXhrOpen = XMLHttpRequest.prototype.open;
    const origXhrSend = XMLHttpRequest.prototype.send;
    const origXhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__agMethod = method || 'GET';
      this.__agUrl = normalizeUrl(typeof url === 'string' ? url : String(url));
      this.__agHeaders = {};
      return origXhrOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
      if (this.__agHeaders) {
        this.__agHeaders[header] = value;
      }
      return origXhrSetHeader.call(this, header, value);
    };

    XMLHttpRequest.prototype.send = function (body) {
      if (this.__agUrl && this.__agUrl.includes('batchexecute')) {
        getRpcIdFromUrl(this.__agUrl);
        harvestAtTokenFromRawBody(body);
      }

      if (isTargetApiUrl(this.__agUrl, this.__agMethod)) {
        const startTime = Date.now();
        const syncBodyStr = bodyToStringSync(body);
        const blobBody = body instanceof Blob ? body : null;

        this.addEventListener('loadend', async () => {
          try {
            let rawReqBodyStr = syncBodyStr;
            if (!rawReqBodyStr && blobBody) {
              rawReqBodyStr = await blobBody.text();
            }

            const parsedReq = parseRequestBody(rawReqBodyStr);

            let respText = '';
            try {
              if (!this.responseType || this.responseType === 'text') {
                respText = this.responseText || '';
              } else if (this.responseType === 'arraybuffer' && this.response instanceof ArrayBuffer) {
                respText = new TextDecoder('utf-8').decode(this.response);
              }
            } catch {
              // Ignore
            }

            const parsedResp = respText ? parseResponseBody(respText) : null;
            const category = classifyEndpoint(this.__agUrl, parsedReq, parsedResp);
            const extractedMeta = extractProtocolMeta(this.__agUrl, parsedReq, parsedResp);

            window.postMessage(
              {
                source: BRIDGE_SOURCE_MAIN,
                type: 'API_PACKET_CAPTURED',
                payload: {
                  timestamp: new Date().toISOString(),
                  transport: 'XHR',
                  category,
                  rpcId: extractedMeta.rpcId,
                  method: (this.__agMethod || 'POST').toUpperCase(),
                  url: this.__agUrl,
                  status: this.status,
                  durationMs: Date.now() - startTime,
                  pageUrl: location.href,
                  requestHeaders: sanitizeJsonStructure(this.__agHeaders || {}),
                  requestBody: sanitizeJsonStructure(parsedReq),
                  responseBody: sanitizeJsonStructure(parsedResp),
                  extractedMeta
                }
              },
              '*'
            );
          } catch {
            // Ignore
          }
        });
      }
      return origXhrSend.call(this, body);
    };
  }

  // ============================================================================
  // ACTIVE NON-DOM BATCHEXECUTE RPC ENGINE (maseQ, ogiZ0b, SPrCad, as29s, HTrJv)
  // ============================================================================

  /**
   * Execute a Google Boq `batchexecute` RPC directly from the Flow page's MAIN world
   */
  async function executeBatchRpc(rpcId, innerArgsArray, projectIdOverride = null) {
    scanWizGlobalData();
    const projectId = projectIdOverride || detectProjectIdFromLocation();

    if (!bridgeState.wizAtToken) {
      throw new Error(
        '尚未获取到 Google Flow 会话签名 Token (at / SNlM0e)，请确认已在 Flow 页面登录并刷新一次页面'
      );
    }

    const sourcePath = projectId ? `/project/${projectId}` : location.pathname || '/';
    const bl = bridgeState.wizBuildLabel || 'boq_labs-ai-sandbox-frontend_20261022.12_p0';
    const fSid = bridgeState.wizFSid || '';
    const reqId = Math.floor(Math.random() * 800000) + 100000;

    const queryParams = new URLSearchParams();
    queryParams.set('rpcids', rpcId);
    queryParams.set('source-path', sourcePath);
    queryParams.set('bl', bl);
    if (fSid) queryParams.set('f.sid', fSid);
    queryParams.set('hl', navigator.language || 'zh-CN');
    queryParams.set('_reqid', String(reqId));
    queryParams.set('rt', 'c');

    const endpointUrl = `${location.origin}/_/AiSandboxAngularFrontend/data/batchexecute?${queryParams.toString()}`;

    const outerEnvelope = [[[rpcId, JSON.stringify(innerArgsArray), null, 'generic']]];
    const formBody = new URLSearchParams();
    formBody.set('f.req', JSON.stringify(outerEnvelope));
    formBody.set('at', bridgeState.wizAtToken);

    // Use window.fetch so our packet logger also records the automated RPC call in the Workbench table!
    const response = await window.fetch(endpointUrl, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
        'x-same-domain': '1'
      },
      body: formBody.toString()
    });

    if (!response.ok) {
      throw new Error(`Google Flow RPC [${rpcId}] HTTP 状态异常: ${response.status} ${response.statusText}`);
    }

    const respText = await response.text();
    const parsed = parseResponseBody(respText);
    if (!parsed || parsed._format !== 'batchexecute_wrb_fr' || !Array.isArray(parsed.chunks)) {
      throw new Error(`Google Flow RPC [${rpcId}] 响应格式无法解析为 wrb.fr`);
    }

    const chunk = parsed.chunks.find((c) => c.rpcId === rpcId) || parsed.chunks[0];
    if (!chunk) {
      throw new Error(`Google Flow RPC [${rpcId}] 响应未包含有效数据块`);
    }

    if (chunk.errorSlot && !chunk.parsedResult) {
      const errCode = Array.isArray(chunk.errorSlot) ? chunk.errorSlot[0] : chunk.errorSlot;
      const errErr = new Error(
        `Google Flow RPC [${rpcId}] 返回服务端错误码: ${JSON.stringify(chunk.errorSlot)}`
      );
      errErr.rpcErrorCode = errCode;
      errErr.errorSlot = chunk.errorSlot;
      throw errErr;
    }

    return chunk.parsedResult;
  }

  /**
   * Build the 11-element ClientContext array required by maseQ, ogiZ0b, and SPrCad:
   * [null, 22, null, null, null, projectId, null, null, null, null, [recaptchaToken, 1]]
   */
  async function buildClientContext(projectId, actionHint) {
    const recaptchaToken = await getFreshRecaptchaToken(actionHint);
    return [
      null,
      22,
      null,
      null,
      null,
      projectId,
      null,
      null,
      null,
      null,
      [recaptchaToken, 1]
    ];
  }

  /**
   * Step 1: Upload Reference Image (`rpcids=maseQ`)
   */
  async function handleUploadImage(payload) {
    const projectId = payload.projectId || detectProjectIdFromLocation();
    if (!projectId) {
      throw new Error(
        '未检测到 Google Flow 项目 ID (projectId)。请先在 https://flow.google.com/ 中点击进入一个具体项目 (/project/...)'
      );
    }

    let rawBase64 = payload.base64Data || '';
    if (rawBase64.includes(',')) {
      rawBase64 = rawBase64.split(',')[1];
    }
    if (!rawBase64 || rawBase64.length < 64) {
      throw new Error('参考图 Base64 数据为空或损坏，无法上传');
    }

    const mimeType = payload.mimeType || 'image/png';
    const fileName = payload.fileName || 'product.png';

    const clientContext = await buildClientContext(projectId, 'UPLOAD_IMAGE');
    const uuid1 = generateUpperUuid();
    const uuid2 = generateUpperUuid();

    const maseQArgs = [
      clientContext,
      rawBase64,
      mimeType,
      1,
      null,
      null,
      null,
      null,
      fileName,
      null,
      uuid1,
      uuid2
    ];

    const parsedResult = await executeBatchRpc('maseQ', maseQArgs, projectId);
    const uploadedMediaId = parsedResult?.[0]?.[0];

    if (
      !uploadedMediaId ||
      typeof uploadedMediaId !== 'string' ||
      !/^[0-9a-f-]{32,36}$/i.test(uploadedMediaId)
    ) {
      throw new Error(`上传参考图 (maseQ) 未返回有效的 Media ID: ${JSON.stringify(parsedResult).slice(0, 200)}`);
    }

    const dimensions = parsedResult?.[0]?.[6]?.[2] || null;
    return {
      ok: true,
      uploadedMediaId,
      projectId,
      dimensions
    };
  }

  /**
   * Resolve candidate model keys when the user selects Nano Banana 2.1 / 2 or another model
   */
  function getCandidateModelKeys(requestedModel) {
    if (!requestedModel || requestedModel === 'GEM_PIX_2') {
      return ['GEM_PIX_2'];
    }

    if (requestedModel === 'NANO_BANANA_2_AUTO') {
      const candidates = [];
      // 1. Check any model key observed in ogiZ0b traffic that isn't GEM_PIX_2
      for (const obs of bridgeState.observedModels) {
        if (obs && obs !== 'GEM_PIX_2' && !candidates.includes(obs)) {
          candidates.push(obs);
        }
      }
      // 2. Check HTrJv discovered models matching "Nano Banana 2" or "narwhal"
      for (const dm of bridgeState.discoveredImageModels) {
        const labelLower = `${dm.groupName} ${dm.displayName} ${dm.modelKey}`.toLowerCase();
        if (
          (labelLower.includes('banana 2') || labelLower.includes('narwhal')) &&
          dm.modelKey !== 'narwhal_display' &&
          !candidates.includes(dm.modelKey)
        ) {
          candidates.push(dm.modelKey);
        }
      }
      // 3. Standard Google Flow internal keys for Nano Banana 2.1 / 2
      for (const fallback of ['NARWHAL', 'GEM_PIX', 'narwhal_display']) {
        if (!candidates.includes(fallback)) {
          candidates.push(fallback);
        }
      }
      return candidates;
    }

    return [requestedModel];
  }

  /**
   * Step 2: Image-to-Image Generation (`rpcids=ogiZ0b`)
   * STRICT CONSTRAINT: Always binds `[[uploadedMediaId, null, null, null, 1]]` at `[1][0][2]`.
   */
  async function handleGenerateImage(payload) {
    const projectId = payload.projectId || detectProjectIdFromLocation();
    if (!projectId) {
      throw new Error('未检测到 Google Flow 项目 ID (projectId)');
    }

    const uploadedMediaId = payload.uploadedMediaId;
    if (!uploadedMediaId || typeof uploadedMediaId !== 'string') {
      throw new Error('安全拦截：缺少参考图 Media ID (uploadedMediaId)，严禁退化为纯文生图！');
    }

    const promptText = String(payload.prompt || '').trim();
    if (!promptText) {
      throw new Error('提示词 (Prompt) 不能为空');
    }

    const aspectRatioEnum = Number(payload.aspectRatioEnum) || 1;
    const candidateModels = getCandidateModelKeys(payload.modelName);

    let lastError = null;
    for (const modelKey of candidateModels) {
      try {
        const clientContext = await buildClientContext(projectId, 'GENERATE_IMAGES');
        const seed =
          typeof payload.seed === 'number' && payload.seed > 0
            ? payload.seed
            : Math.floor(Math.random() * 2147483646) + 1;
        const reqUuid1 = generateUpperUuid();
        const reqUuid2 = generateUpperUuid();
        const batchUuid = generateUpperUuid();

        const ogiZ0bArgs = [
          null,
          [
            [
              null,
              null,
              [
                [
                  uploadedMediaId,
                  null,
                  null,
                  null,
                  1
                ]
              ],
              seed,
              aspectRatioEnum,
              modelKey,
              null,
              clientContext,
              [
                [
                  [
                    promptText
                  ]
                ]
              ],
              null,
              null,
              null,
              reqUuid1,
              reqUuid2
            ]
          ],
          1,
          clientContext,
          [
            batchUuid
          ]
        ];

        const parsedResult = await executeBatchRpc('ogiZ0b', ogiZ0bArgs, projectId);
        const firstGenItem = parsedResult?.[0]?.[0];
        const generatedMediaId = firstGenItem?.[0];
        const workflowId = firstGenItem?.[2] || parsedResult?.[1]?.[0]?.[0] || null;
        const signedUrl1K =
          firstGenItem?.[6]?.[0]?.[13] ||
          firstGenItem?.[6]?.[5]?.[1] ||
          null;
        const dimensions = firstGenItem?.[6]?.[2] || [1024, 1024];

        if (!generatedMediaId || typeof generatedMediaId !== 'string') {
          throw new Error(
            `图生图 (ogiZ0b, model=${modelKey}) 未返回有效的生成图像 ID: ${JSON.stringify(parsedResult).slice(
              0,
              200
            )}`
          );
        }

        return {
          ok: true,
          generatedMediaId,
          workflowId,
          signedUrl1K,
          dimensions,
          seedUsed: seed,
          modelUsed: modelKey
        };
      } catch (err) {
        lastError = err;
        // If we have more candidate model keys and this failed due to invalid model key (error code 3 = INVALID_ARGUMENT), try next candidate
        if (candidateModels.length > 1) {
          console.warn(
            `[FlowAutomator Bridge] Model key ${modelKey} returned error (${err.message}), trying next candidate...`
          );
          continue;
        }
        throw err;
      }
    }

    throw lastError || new Error('图生图请求失败');
  }

  /**
   * Step 3 (2K): Upscale Generated Image (`rpcids=SPrCad`)
   */
  async function handleUpscaleImage(payload) {
    const projectId = payload.projectId || detectProjectIdFromLocation();
    if (!projectId) {
      throw new Error('未检测到 Google Flow 项目 ID (projectId)');
    }

    const generatedMediaId = payload.generatedMediaId;
    if (!generatedMediaId || typeof generatedMediaId !== 'string') {
      throw new Error('超分放大 (SPrCad) 缺少生成的图像 ID (generatedMediaId)');
    }

    const resolutionEnum = Number(payload.resolutionEnum) || 1; // 1 = 2K
    const clientContext = await buildClientContext(projectId, 'UPSCALE_IMAGE');

    const sPrCadArgs = [generatedMediaId, resolutionEnum, clientContext];
    const parsedResult = await executeBatchRpc('SPrCad', sPrCadArgs, projectId);

    const upscaledMediaId = parsedResult?.[0]?.[0] || null;
    const base64Jpeg = typeof parsedResult?.[1] === 'string' ? parsedResult[1] : null;
    const signedUrlUpscaled =
      parsedResult?.[0]?.[5]?.[13] ||
      parsedResult?.[0]?.[6]?.[1]?.[3] ||
      null;

    if (!base64Jpeg && !signedUrlUpscaled) {
      throw new Error(
        `2K 超分放大 (SPrCad) 未返回图像 Base64 或下载链接: ${JSON.stringify(parsedResult).slice(0, 200)}`
      );
    }

    return {
      ok: true,
      upscaledMediaId,
      base64Data: base64Jpeg,
      signedUrl: signedUrlUpscaled,
      mimeType: 'image/jpeg'
    };
  }

  /**
   * Fetch fresh signed URL via `rpcids=as29s` if needed, or fetch image bytes and return as Base64
   */
  async function handleFetchMediaAsBase64(payload) {
    let targetUrl = payload.signedUrl;
    const mediaId = payload.mediaId;
    const projectId = payload.projectId || detectProjectIdFromLocation();

    if (!targetUrl && mediaId) {
      const as29sRes = await executeBatchRpc('as29s', [mediaId], projectId);
      targetUrl =
        as29sRes?.[5]?.[13] ||
        as29sRes?.[6]?.[1]?.[3] ||
        as29sRes?.[6]?.[4]?.[1] ||
        null;
    }

    if (!targetUrl) {
      throw new Error('无法获取图像下载链接 (signedUrl 为空)');
    }

    const resp = await nativeFetch(targetUrl);
    if (!resp.ok) {
      throw new Error(`下载生成图像失败: HTTP ${resp.status}`);
    }

    const blob = await resp.blob();
    const mimeType = blob.type || 'image/jpeg';
    const base64Data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const resStr = String(reader.result || '');
        const commaIdx = resStr.indexOf(',');
        resolve(commaIdx >= 0 ? resStr.slice(commaIdx + 1) : resStr);
      };
      reader.onerror = () => reject(new Error('读取图像 Blob 失败'));
      reader.readAsDataURL(blob);
    });

    return {
      ok: true,
      base64Data,
      mimeType,
      byteLength: blob.size,
      signedUrl: targetUrl
    };
  }

  /**
   * Actively fetch `HTrJv` catalog from Google Flow
   */
  async function handleFetchFlowCatalog() {
    scanWizGlobalData();
    const projectId = detectProjectIdFromLocation();
    const parsedResult = await executeBatchRpc('HTrJv', [], projectId);
    parseHTrJvModelCatalog(parsedResult);
    return {
      ok: true,
      discoveredImageModels: bridgeState.discoveredImageModels,
      observedModels: bridgeState.observedModels
    };
  }

  /**
   * Hot-upgradable command dispatcher for messages from isolated-relay.js
   */
  window.__ANTIGRAVITY_FLOW_BRIDGE_COMMAND_HANDLER__ = async function (command, payload = {}) {
    scanWizGlobalData();
    discoverRecaptchaSiteKey();

    if (command === 'GET_FLOW_CONTEXT_STATUS') {
      const detectedProjectId = detectProjectIdFromLocation();
      const hasWizAuth = Boolean(bridgeState.wizAtToken || bridgeState.wizFSid);

      // Non-blocking background catalog fetch if we have auth token and haven't fetched HTrJv yet
      if (bridgeState.wizAtToken && !bridgeState.catalogFetched) {
        bridgeState.catalogFetched = true;
        handleFetchFlowCatalog().catch(() => {});
      }

      return {
        ok: true,
        bridgeVersion: BRIDGE_VERSION,
        pageUrl: location.href,
        projectId: detectedProjectId,
        sessionId: bridgeState.wizFSid,
        wizBuildLabel: bridgeState.wizBuildLabel,
        recaptchaReady: Boolean(window.grecaptcha?.enterprise || window.grecaptcha),
        recaptchaSiteKey: bridgeState.lastSiteKey,
        recaptchaAction: bridgeState.lastAction,
        observedRpcIds: bridgeState.observedRpcIds,
        observedModels: bridgeState.observedModels,
        observedAspectRatios: bridgeState.observedAspectRatios,
        discoveredImageModels: bridgeState.discoveredImageModels,
        sessionInfo: {
          hasToken: hasWizAuth,
          tokenPrefix: bridgeState.wizAtToken
            ? `at=${bridgeState.wizAtToken.slice(0, 10)}...`
            : `f.sid=${bridgeState.wizFSid || '待获取'}`,
          tokenLength: bridgeState.wizAtToken ? bridgeState.wizAtToken.length : 0,
          userEmail: bridgeState.wizUserEmail,
          source: 'WIZ_global_data / batchexecute'
        }
      };
    }

    if (command === 'FETCH_FLOW_CATALOG') {
      return await handleFetchFlowCatalog();
    }

    if (command === 'EXECUTE_UPLOAD_IMAGE') {
      return await handleUploadImage(payload);
    }

    if (command === 'EXECUTE_GENERATE_IMAGE') {
      return await handleGenerateImage(payload);
    }

    if (command === 'EXECUTE_UPSCALE_IMAGE') {
      return await handleUpscaleImage(payload);
    }

    if (command === 'FETCH_MEDIA_AS_BASE64') {
      return await handleFetchMediaAsBase64(payload);
    }

    return { ok: false, error: `Unsupported bridge command: ${command}` };
  };

  // Register window message listener once, delegating to the hot-upgradable command handler
  if (!window.__ANTIGRAVITY_FLOW_COMMAND_LISTENER_INSTALLED__) {
    window.__ANTIGRAVITY_FLOW_COMMAND_LISTENER_INSTALLED__ = true;

    window.addEventListener('message', async (event) => {
      if (event.source !== window || !event.data) return;
      if (event.data.source !== BRIDGE_SOURCE_ISOLATED) return;
      if (event.data.type !== 'EXECUTE_COMMAND') return;

      const { requestId, command, payload } = event.data;

      try {
        const handler = window.__ANTIGRAVITY_FLOW_BRIDGE_COMMAND_HANDLER__;
        const result = await handler(command, payload || {});
        window.postMessage(
          {
            source: BRIDGE_SOURCE_MAIN,
            type: 'COMMAND_RESPONSE',
            requestId,
            payload: result
          },
          '*'
        );
      } catch (err) {
        window.postMessage(
          {
            source: BRIDGE_SOURCE_MAIN,
            type: 'COMMAND_RESPONSE',
            requestId,
            payload: {
              ok: false,
              error: err.message || String(err),
              rpcErrorCode: err.rpcErrorCode || null
            }
          },
          '*'
        );
      }
    });
  }
})();
