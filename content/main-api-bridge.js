// content/main-api-bridge.js
// Runs in MAIN world at document_start on https://flow.google.com/* and https://labs.google/fx/*
// Strictly NON-DOM:
// 1. Defeats Google Flow's `x2a` anti-extension reCAPTCHA trap (`action: "extension_hijack_detected"`) via:
//    - Path A (Pristine Capture at document_start): 3-level Object.defineProperty trap + 2ms poll before `x2a` runs.
//    - Path B (Object.assign Neuter): intercepts `Object.assign({}, f, { action: "extension_hijack_detected" })`
//      inside `x2a`'s wrapper and restores the required `action: "IMAGE_GENERATION"` before calling the real `execute`.
// 2. Executes Google Flow's `batchexecute` RPC pipeline (`maseQ` upload -> `ogiZ0b` generate -> `SPrCad` 2K/4K upscale)
//    with `CAPTCHA_IMAGE = "IMAGE_GENERATION"`.

(function () {
  const BRIDGE_VERSION = '0.3.21';
  const BRIDGE_SOURCE_MAIN = 'ANTIGRAVITY_FLOW_MAIN_BRIDGE';
  const BRIDGE_SOURCE_ISOLATED = 'ANTIGRAVITY_FLOW_ISOLATED_RELAY';
  const DEFAULT_FLOW_SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
  const CAPTCHA_ACTION_IMAGE = 'IMAGE_GENERATION';

  const IGNORED_TELEMETRY_RPCIDS = new Set(['WuwhI', 'nzlxg']);

  const bridgeState = window.__ANTIGRAVITY_FLOW_BRIDGE_STATE__ || {
    lastSiteKey: null,
    lastAction: CAPTCHA_ACTION_IMAGE,
    lastProjectId: null,
    wizAtToken: null,
    wizFSid: null,
    wizBuildLabel: null,
    wizUserEmail: null,
    observedRpcIds: [],
    observedModels: [],
    observedAspectRatios: [],
    discoveredImageModels: [],
    catalogFetched: false,
    pristineExecute: null,
    x2aTrapDetected: false,
    captureSource: null
  };
  window.__ANTIGRAVITY_FLOW_BRIDGE_STATE__ = bridgeState;
  window.__ANTIGRAVITY_FLOW_BRIDGE_VERSION__ = BRIDGE_VERSION;

  const nativeFetch = window.__ANTIGRAVITY_NATIVE_FETCH__ || window.fetch.bind(window);
  window.__ANTIGRAVITY_NATIVE_FETCH__ = nativeFetch;
  const realObjectAssign = window.__ANTIGRAVITY_REAL_OBJECT_ASSIGN__ || Object.assign;
  window.__ANTIGRAVITY_REAL_OBJECT_ASSIGN__ = realObjectAssign;

  // ============================================================================
  // 1. ANTI-HIJACK BYPASS FOR GRECAPTCHA.ENTERPRISE.EXECUTE (DEFEATS x2a TRAP)
  // ============================================================================
  // Flow's frontend overwrites `grecaptcha.enterprise.execute` with:
  //   c.execute = (e, f) => d(e, Object.assign({}, f, { action: "extension_hijack_detected" }))
  // Any token minted with action="extension_hijack_detected" is rejected by `ogiZ0b`
  // with `PUBLIC_ERROR_UNUSUAL_ACTIVITY`.

  function savePristineExecute(fn, enterprise, source) {
    if (bridgeState.pristineExecute || typeof fn !== 'function') return false;
    try {
      const fnSrc = Function.prototype.toString.call(fn);
      if (fnSrc.includes('extension_hijack_detected')) {
        bridgeState.x2aTrapDetected = true;
        return false;
      }
    } catch {
      // Native or bound function
    }
    bridgeState.pristineExecute = fn.bind(enterprise);
    bridgeState.captureSource = source;
    Promise.resolve().then(cleanAllPropertyTraps);
    return true;
  }

  function cleanSinglePropertyTrap(obj, prop) {
    try {
      const desc = Object.getOwnPropertyDescriptor(obj, prop);
      if (!desc || (!desc.get && !desc.set)) return;
      Object.defineProperty(obj, prop, {
        value: desc.get ? desc.get() : undefined,
        writable: true,
        configurable: true,
        enumerable: true
      });
    } catch {
      // Ignore if non-configurable
    }
  }

  let trapsCleaned = false;
  function cleanAllPropertyTraps() {
    if (trapsCleaned) return;
    trapsCleaned = true;
    try {
      const gc = window.grecaptcha;
      if (gc) {
        const ent = gc.enterprise;
        if (ent) cleanSinglePropertyTrap(ent, 'execute');
        cleanSinglePropertyTrap(gc, 'enterprise');
      }
      cleanSinglePropertyTrap(window, 'grecaptcha');
    } catch {
      // Ignore
    }
  }

  function watchEnterpriseExecute(enterprise) {
    let val = enterprise.execute;
    if (typeof val === 'function' && savePristineExecute(val, enterprise, 'L3-immediate')) {
      return;
    }
    try {
      Object.defineProperty(enterprise, 'execute', {
        get() {
          return val;
        },
        set(fn) {
          val = fn;
          savePristineExecute(fn, enterprise, 'L3-setter');
        },
        configurable: true,
        enumerable: true
      });
    } catch {
      // Fall through to poll
    }
  }

  function watchGrecaptchaEnterprise(grecaptcha) {
    let val = grecaptcha.enterprise;
    if (val && typeof val === 'object') {
      watchEnterpriseExecute(val);
    }
    try {
      Object.defineProperty(grecaptcha, 'enterprise', {
        get() {
          return val;
        },
        set(obj) {
          val = obj;
          if (obj && typeof obj === 'object') {
            watchEnterpriseExecute(obj);
          }
        },
        configurable: true,
        enumerable: true
      });
    } catch {
      // Ignore
    }
  }

  if (!window.__ANTIGRAVITY_HIJACK_TRAP_INSTALLED__) {
    window.__ANTIGRAVITY_HIJACK_TRAP_INSTALLED__ = true;

    let gcVal = window.grecaptcha;
    if (gcVal && typeof gcVal === 'object') {
      watchGrecaptchaEnterprise(gcVal);
    } else {
      try {
        Object.defineProperty(window, 'grecaptcha', {
          get() {
            return gcVal;
          },
          set(obj) {
            gcVal = obj;
            if (obj && typeof obj === 'object') {
              watchGrecaptchaEnterprise(obj);
            }
          },
          configurable: true,
          enumerable: true
        });
      } catch {
        // Ignore
      }
    }

    const fastPollId = setInterval(() => {
      if (bridgeState.pristineExecute) {
        clearInterval(fastPollId);
        return;
      }
      try {
        const exec = window.grecaptcha?.enterprise?.execute;
        if (typeof exec === 'function') {
          savePristineExecute(exec, window.grecaptcha.enterprise, 'poll-2ms');
          if (bridgeState.pristineExecute) clearInterval(fastPollId);
        }
      } catch {
        // Ignore
      }
    }, 2);
    setTimeout(() => clearInterval(fastPollId), 30000);
  }

  /**
   * Discover reCAPTCHA Enterprise siteKey from ___grecaptcha_cfg, performance resources, or DOM script tags
   */
  function discoverRecaptchaSiteKey() {
    try {
      const clients = window.___grecaptcha_cfg?.clients;
      if (clients && typeof clients === 'object') {
        for (const k of Object.keys(clients)) {
          const c = clients[k];
          if (c && typeof c.sitekey === 'string' && c.sitekey.length >= 25) {
            bridgeState.lastSiteKey = c.sitekey;
            return c.sitekey;
          }
        }
      }
    } catch {
      // Fall through
    }

    if (bridgeState.lastSiteKey && bridgeState.lastSiteKey.length >= 25) {
      return bridgeState.lastSiteKey;
    }

    try {
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
    } catch {
      // Ignore
    }

    bridgeState.lastSiteKey = DEFAULT_FLOW_SITE_KEY;
    return DEFAULT_FLOW_SITE_KEY;
  }

  function waitRecaptchaReady(timeoutMs = 3500) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      try {
        window.grecaptcha?.enterprise?.ready?.(finish);
      } catch {
        // Ignore
      }
      setTimeout(finish, timeoutMs);
    });
  }

  /**
   * Execute grecaptcha.enterprise.execute while neutralizing Flow's `x2a` Object.assign poison wrapper!
   * Even if `x2a` wrapped `window.grecaptcha.enterprise.execute` with:
   *   (e, f) => d(e, Object.assign({}, f, { action: "extension_hijack_detected" }))
   * replacing `Object.assign` during the synchronous call strips `"extension_hijack_detected"`
   * and restores `targetAction` (`"IMAGE_GENERATION"`) before handing it to the real `d`!
   */
  async function executeWithAssignNeuter(siteKey, targetAction) {
    Object.assign = function (target, ...sources) {
      const result = realObjectAssign.call(this, target, ...sources);
      if (result && typeof result === 'object' && result.action === 'extension_hijack_detected') {
        bridgeState.x2aTrapDetected = true;
        result.action = targetAction;
      }
      return result;
    };

    try {
      await waitRecaptchaReady(2500);
      const token = await Promise.race([
        window.grecaptcha.enterprise.execute(siteKey, { action: targetAction }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('grecaptcha.enterprise.execute 超时 (10s)')), 10000)
        )
      ]);
      return token ? String(token) : null;
    } finally {
      Object.assign = realObjectAssign;
    }
  }

  async function executeWithPristine(siteKey, targetAction) {
    if (typeof bridgeState.pristineExecute !== 'function') return null;
    const token = await Promise.race([
      bridgeState.pristineExecute(siteKey, { action: targetAction }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('pristine grecaptcha.execute 超时 (10s)')), 10000)
      )
    ]);
    return token ? String(token) : null;
  }

  let captchaMintQueue = Promise.resolve();

  /**
   * Mint a clean, single-use reCAPTCHA Enterprise token with `action = "IMAGE_GENERATION"`
   * Serialized via `captchaMintQueue` so concurrent calls never race on `Object.assign` or grecaptcha.
   */
  async function getFreshRecaptchaToken(actionName = CAPTCHA_ACTION_IMAGE) {
    const prev = captchaMintQueue.catch(() => {});
    let releaseQueue;
    captchaMintQueue = new Promise((resolve) => {
      releaseQueue = resolve;
    });
    await prev;

    try {
      const siteKey = discoverRecaptchaSiteKey();
      const gre = window.grecaptcha?.enterprise || window.grecaptcha;
      if (!gre && !bridgeState.pristineExecute) {
        throw new Error('Google Flow 页面中的 grecaptcha.enterprise 尚未加载完成，请刷新 Flow 页面后重试');
      }

      // Check if current public execute is x2a-trapped
      try {
        const currentExec = window.grecaptcha?.enterprise?.execute;
        if (typeof currentExec === 'function') {
          const src = Function.prototype.toString.call(currentExec);
          if (src.includes('extension_hijack_detected')) {
            bridgeState.x2aTrapDetected = true;
          } else if (!bridgeState.pristineExecute) {
            savePristineExecute(currentExec, window.grecaptcha.enterprise, 'late-clean');
          }
        }
      } catch {
        // Ignore
      }

      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          // 1. Try pristine execute if captured before x2a ran
          if (typeof bridgeState.pristineExecute === 'function') {
            const token = await executeWithPristine(siteKey, actionName);
            if (token) return token;
          }
          // 2. Always works even when x2a is active: Object.assign neuter!
          const neuteredToken = await executeWithAssignNeuter(siteKey, actionName);
          if (neuteredToken) return neuteredToken;
        } catch (err) {
          lastErr = err;
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      throw lastErr || new Error('获取 reCAPTCHA Enterprise Token 失败');
    } finally {
      releaseQueue();
    }
  }

  // ============================================================================
  // 2. WIZ_GLOBAL_DATA & PROTOCOL SNIFFER HELPERS
  // ============================================================================

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

  function detectProjectIdFromLocation() {
    const match =
      location.pathname.match(/\/project\/([0-9a-fA-F-]{8,}|[^/?#]+)/) ||
      location.href.match(/[?&]projectId=([^&#]+)/);
    if (match && match[1]) {
      bridgeState.lastProjectId = match[1];
      return match[1];
    }
    bridgeState.lastProjectId = null;
    return null;
  }

  function normalizeUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    try {
      return new URL(rawUrl, location.origin).href;
    } catch {
      return rawUrl;
    }
  }

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
      // Ignore
    }
  }

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

  function parseHTrJvModelCatalog(parsedResult) {
    try {
      if (!parsedResult || typeof parsedResult !== 'object') return;

      const displayMap = new Map();
      const foundModels = [];
      const belugaKeys = new Set();
      const gemPix2Siblings = new Set();

      const FORBIDDEN_LITE_OR_OTHER = new Set([
        'HARBOR_SEAL',
        'GEM_PIX',
        'GEM_PIX_2',
        'NARWHAL',
        'IMAGEN_3',
        'IMAGEN_3_1',
        'IMAGEN_3_5'
      ]);

      function isLikelyImageWireKey(str) {
        if (typeof str !== 'string' || str.length < 3 || str.length > 40) return false;
        if (str.startsWith('veo_') || str.startsWith('abra_')) return false;
        if (str.endsWith('_display') || str.includes(' ') || str.includes('/')) return false;
        return /^[A-Z][A-Z0-9_]*$/.test(str);
      }

      // Pass 1: Recursive walk over the entire HTrJv parsedResult tree
      function walkTree(node, parentChain = []) {
        if (!Array.isArray(node)) return;

        // Collect display label mappings: [key, [label, ...]]
        if (
          typeof node[0] === 'string' &&
          Array.isArray(node[1]) &&
          typeof node[1][0] === 'string' &&
          node[1][0].length > 0 &&
          !Array.isArray(node[1][0])
        ) {
          displayMap.set(node[0], node[1][0]);
        }

        // Check if this node is a group mapping: ["beluga_display", [ [variantKey, ...], ... ]]
        if (node[0] === 'beluga_display' && Array.isArray(node[1])) {
          const collectStrings = (sub) => {
            if (typeof sub === 'string' && isLikelyImageWireKey(sub)) {
              belugaKeys.add(sub);
            } else if (Array.isArray(sub)) {
              for (const item of sub) collectStrings(item);
            }
          };
          collectStrings(node[1]);
        }

        // Check if this array is a table of model entries where one entry has "GEM_PIX_2"
        const hasGemPix2Child = node.some(
          (child) =>
            child === 'GEM_PIX_2' ||
            (Array.isArray(child) && (child[0] === 'GEM_PIX_2' || child[1] === 'GEM_PIX_2'))
        );
        if (hasGemPix2Child) {
          for (const sibling of node) {
            const candidate =
              typeof sibling === 'string'
                ? sibling
                : Array.isArray(sibling) && typeof sibling[0] === 'string'
                ? sibling[0]
                : null;
            if (candidate && isLikelyImageWireKey(candidate) && !FORBIDDEN_LITE_OR_OTHER.has(candidate)) {
              gemPix2Siblings.add(candidate);
            }
          }
        }

        for (const child of node) {
          if (Array.isArray(child)) {
            walkTree(child, parentChain.concat([node]));
          }
        }
      }

      walkTree(parsedResult);

      if (belugaKeys.size > 0) {
        bridgeState.belugaDiscoveredKeys = Array.from(belugaKeys);
      }
      if (gemPix2Siblings.size > 0) {
        bridgeState.gemPix2SiblingKeys = Array.from(gemPix2Siblings);
      }

      const root = Array.isArray(parsedResult?.[0]) ? parsedResult[0] : parsedResult;
      if (Array.isArray(root)) {
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
              const groupKey = group[0];
              const groupName = displayMap.get(groupKey) || groupKey;
              for (const variant of group[1]) {
                if (Array.isArray(variant) && typeof variant[0] === 'string') {
                  const variantKey = variant[0];
                  if (variantKey.startsWith('veo_') || variantKey.startsWith('abra_')) continue;
                  const variantLabel = displayMap.get(variantKey) || groupName;
                  foundModels.push({
                    modelKey: variantKey,
                    groupKey,
                    groupName,
                    displayName: `${variantLabel} (${variantKey})`
                  });
                }
              }
            }
          }
        }
      }

      bridgeState.discoveredImageModels = foundModels;
      bridgeState.catalogFetched = true;
    } catch {
      // Ignore
    }
  }

  /**
   * Scan Flow's loaded frontend JS bundles for the exact Protobuf enum key mapped to 36
   * (where GEM_PIX_2 = 25 and Nano Banana 2.1 = 36, or adjacent to "beluga_display").
   */
  async function scanFrontendBundleForNanoBanana21() {
    if (bridgeState.bundleScannedForBeluga) {
      return bridgeState.enum36ModelKeys || [];
    }
    bridgeState.bundleScannedForBeluga = true;
    const discovered = new Set();
    const FORBIDDEN = new Set([
      'HARBOR_SEAL',
      'GEM_PIX',
      'GEM_PIX_2',
      'NARWHAL',
      'IMAGE_GENERATION',
      'VIDEO_GENERATION',
      'TRUE',
      'FALSE',
      'NULL'
    ]);

    function inspectJsText(jsText) {
      if (!jsText || typeof jsText !== 'string') return;

      // 1. Search around "GEM_PIX_2" for enum value 36 (since GEM_PIX_2 is 25 and Nano Banana 2.1 is 36)
      let idx = jsText.indexOf('GEM_PIX_2');
      while (idx !== -1) {
        const snippet = jsText.slice(Math.max(0, idx - 1800), Math.min(jsText.length, idx + 1800));
        // Match KEY:36 or KEY: 36 or 36:"KEY" or [36,"KEY"]
        const regexes = [
          /\b([A-Z][A-Z0-9_]{2,30})\s*:\s*36\b/g,
          /\b36\s*:\s*["']([A-Z][A-Z0-9_]{2,30})["']/g,
          /["']([A-Z][A-Z0-9_]{2,30})["']\s*,\s*36\b/g,
          /\b36\s*,\s*["']([A-Z][A-Z0-9_]{2,30})["']/g
        ];
        for (const rx of regexes) {
          let m;
          while ((m = rx.exec(snippet)) !== null) {
            const key = m[1];
            if (key && !FORBIDDEN.has(key) && !key.startsWith('VEO_') && !key.startsWith('ABRA_')) {
              discovered.add(key);
            }
          }
        }
        idx = jsText.indexOf('GEM_PIX_2', idx + 9);
      }

      // 2. Search around "beluga_display" for uppercase wire keys
      let bIdx = jsText.indexOf('beluga_display');
      while (bIdx !== -1) {
        const snippet = jsText.slice(Math.max(0, bIdx - 800), Math.min(jsText.length, bIdx + 800));
        const rx = /["']([A-Z][A-Z0-9_]{3,28})["']/g;
        let m;
        while ((m = rx.exec(snippet)) !== null) {
          const key = m[1];
          if (key && !FORBIDDEN.has(key) && !key.startsWith('VEO_') && !key.startsWith('ABRA_')) {
            discovered.add(key);
          }
        }
        bIdx = jsText.indexOf('beluga_display', bIdx + 14);
      }
    }

    try {
      const scripts = Array.from(document.querySelectorAll('script'));
      for (const s of scripts) {
        if (s.textContent && (s.textContent.includes('GEM_PIX_2') || s.textContent.includes('beluga_display'))) {
          inspectJsText(s.textContent);
        }
      }

      if (discovered.size === 0) {
        const externalUrls = scripts
          .map((s) => s.src)
          .filter((src) => src && (src.includes('flow.google.com') || src.includes('gstatic.com')));
        for (const srcUrl of externalUrls.slice(0, 12)) {
          try {
            const resp = await originalFetch(srcUrl, { credentials: 'omit', cache: 'force-cache' });
            if (resp.ok) {
              const txt = await resp.text();
              if (txt.includes('GEM_PIX_2') || txt.includes('beluga_display')) {
                inspectJsText(txt);
                if (discovered.size > 0) break;
              }
            }
          } catch {
            // Ignore CORS or network error on individual script tag
          }
        }
      }
    } catch {
      // Ignore
    }

    bridgeState.enum36ModelKeys = Array.from(discovered);
    return bridgeState.enum36ModelKeys;
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

  // Install fetch/XHR interceptors once per window
  if (!window.__ANTIGRAVITY_FLOW_INTERCEPTORS_INSTALLED__) {
    window.__ANTIGRAVITY_FLOW_INTERCEPTORS_INSTALLED__ = true;

    setInterval(() => {
      scanWizGlobalData();
      discoverRecaptchaSiteKey();
    }, 1500);

    window.fetch = async function (...args) {
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
  // 3. ACTIVE NON-DOM BATCHEXECUTE RPC ENGINE (maseQ, ogiZ0b, SPrCad, as29s, HTrJv)
  // ============================================================================

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
    const reqId = Math.floor(Math.random() * 900000) + 100000;
    const hl = document.documentElement.lang || navigator.language || 'zh-CN';

    const queryParams = new URLSearchParams();
    queryParams.set('rpcids', rpcId);
    queryParams.set('source-path', sourcePath);
    queryParams.set('bl', bl);
    if (fSid) queryParams.set('f.sid', fSid);
    queryParams.set('hl', hl);
    queryParams.set('_reqid', String(reqId));
    queryParams.set('rt', 'c');

    const endpointUrl = `${location.origin}/_/AiSandboxAngularFrontend/data/batchexecute?${queryParams.toString()}`;

    const outerEnvelope = [[[rpcId, JSON.stringify(innerArgsArray), null, 'generic']]];
    const formBody = new URLSearchParams();
    formBody.set('f.req', JSON.stringify(outerEnvelope));
    formBody.set('at', bridgeState.wizAtToken);

    const response = await window.fetch(endpointUrl, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
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
   * Always uses `CAPTCHA_ACTION_IMAGE = "IMAGE_GENERATION"`!
   */
  async function buildClientContext(projectId) {
    const recaptchaToken = await getFreshRecaptchaToken(CAPTCHA_ACTION_IMAGE);
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

    const clientContext = await buildClientContext(projectId);
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

    // Replicate Google Flow frontend post-upload registration sequence:
    // 1. Sync project state via ngNC2 (also verifies projectId wasn't deleted)
    try {
      await executeBatchRpc('ngNC2', [`tools/PINHOLE/projects/${projectId}`], projectId);
    } catch (ngErr) {
      if (ngErr.rpcErrorCode === 5) {
        const projErr = new Error(
          `当前 Google Flow 项目 (${projectId}) 不存在或已被删除 (RPC [ngNC2] 返回 [5])。请在 Flow 页面新建或进入一个有效项目后再试！`
        );
        projErr.rpcErrorCode = 5;
        projErr.isProjectDeleted = true;
        throw projErr;
      }
    }

    // 2. Poll as29s([uploadedMediaId]) to ensure the uploaded reference image is indexed & not tombstoned ([5])
    let mediaReady = false;
    let lastAs29sErr = null;
    for (let poll = 0; poll < 4; poll++) {
      try {
        const as29sRes = await executeBatchRpc('as29s', [uploadedMediaId], projectId);
        if (as29sRes && Array.isArray(as29sRes) && as29sRes[0] === uploadedMediaId) {
          mediaReady = true;
          break;
        }
      } catch (asErr) {
        lastAs29sErr = asErr;
        if (asErr.rpcErrorCode !== 5) {
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 750));
    }

    if (!mediaReady && lastAs29sErr && lastAs29sErr.rpcErrorCode === 5) {
      const tombErr = new Error(
        `参考图在当前 Flow 项目中命中已删除记录 (MediaID=${uploadedMediaId.slice(0, 8)}... 返回 [5] NOT_FOUND)`
      );
      tombErr.rpcErrorCode = 5;
      tombErr.isTombstonedMedia = true;
      throw tombErr;
    }

    // Brief settle delay so ogiZ0b backend workers see the indexed reference asset
    await new Promise((r) => setTimeout(r, 400));

    const dimensions = parsedResult?.[0]?.[6]?.[2] || null;
    return {
      ok: true,
      uploadedMediaId,
      projectId,
      dimensions
    };
  }

  /**
   * Strictly resolve exact wire model ID for ogiZ0b without EVER downgrading to Lite (HARBOR_SEAL / GEM_PIX):
   * - GEM_PIX_2   -> 🍌 Nano Banana Pro (enum=25)
   * - BELUGA / enum=36 -> 🍌 Nano Banana 2.1 (beluga_display, enum=36)
   * - HARBOR_SEAL -> 🍌 Nano Banana 2 Lite
   * - GEM_PIX     -> 🍌 Nano Banana
   */
  async function resolveCandidateWireModels(requestedModel, projectId) {
    delete bridgeState.verifiedNanoBanana2Key;

    if (requestedModel === 'GEM_PIX_2' || requestedModel === 'NANO_BANANA_PRO') {
      return ['GEM_PIX_2'];
    }

    if (
      !requestedModel ||
      requestedModel === 'BELUGA' ||
      requestedModel === 'beluga_display' ||
      requestedModel === 'NANO_BANANA_2_1' ||
      requestedModel === 'NANO_BANANA_2_AUTO' ||
      requestedModel === 'NARWHAL'
    ) {
      if (
        bridgeState.verifiedNanoBanana21Key &&
        bridgeState.verifiedNanoBanana21Key !== 'HARBOR_SEAL' &&
        bridgeState.verifiedNanoBanana21Key !== 'GEM_PIX'
      ) {
        return [bridgeState.verifiedNanoBanana21Key];
      }

      // 1. Ensure HTrJv full model catalog has been parsed with deep tree scan
      if (!bridgeState.belugaDiscoveredKeys && projectId) {
        try {
          const catalogResult = await executeBatchRpc('HTrJv', [], projectId);
          parseHTrJvModelCatalog(catalogResult);
        } catch {
          // Ignore HTrJv probe failure
        }
      }

      // 2. Scan frontend JS bundle for Protobuf enum=36 / beluga_display wire key
      const enum36Keys = await scanFrontendBundleForNanoBanana21();

      // Strictly block any Lite or Pro or retired model from entering Nano Banana 2.1 candidates
      const STRICT_BLOCKLIST = new Set([
        'HARBOR_SEAL',
        'GEM_PIX',
        'GEM_PIX_2',
        'NARWHAL',
        'IMAGEN_3',
        'IMAGEN_3_1',
        'IMAGEN_3_5'
      ]);

      const candidates = [];
      const addStrictCandidate = (key) => {
        if (
          typeof key === 'string' &&
          key.length >= 3 &&
          !STRICT_BLOCKLIST.has(key) &&
          !candidates.includes(key)
        ) {
          candidates.push(key);
        }
      };

      // Priority 1: Exact enum=36 or beluga_display keys from frontend bundle
      if (Array.isArray(enum36Keys)) {
        for (const k of enum36Keys) addStrictCandidate(k);
      }

      // Priority 2: Keys extracted from ["beluga_display", ...] subtree in HTrJv
      if (Array.isArray(bridgeState.belugaDiscoveredKeys)) {
        for (const k of bridgeState.belugaDiscoveredKeys) addStrictCandidate(k);
      }

      // Priority 3: Standard BELUGA key
      addStrictCandidate('BELUGA');

      // Priority 4: Sibling keys in the exact same HTrJv table as GEM_PIX_2
      if (Array.isArray(bridgeState.gemPix2SiblingKeys)) {
        for (const k of bridgeState.gemPix2SiblingKeys) addStrictCandidate(k);
      }

      // Priority 5: Known naming variants for Nano Banana 2.1
      addStrictCandidate('BELUGA_2');
      addStrictCandidate('GEM_PIX_2_1');

      return candidates.length > 0 ? candidates : ['BELUGA'];
    }

    if (requestedModel === 'NANO_BANANA_LITE' || requestedModel === 'HARBOR_SEAL') {
      return ['HARBOR_SEAL'];
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
    const candidateModels = await resolveCandidateWireModels(payload.modelName, projectId);
    const seed =
      typeof payload.seed === 'number' && payload.seed > 0
        ? payload.seed
        : Math.floor(Math.random() * 1000000000) + 1;

    let parsedResult = null;
    let activeWireModelKey = candidateModels[0];
    let lastRpcErr = null;

    for (let idx = 0; idx < candidateModels.length; idx++) {
      const candidateKey = candidateModels[idx];
      activeWireModelKey = candidateKey;

      const clientContext = await buildClientContext(projectId);
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
            candidateKey,
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

      try {
        parsedResult = await executeBatchRpc('ogiZ0b', ogiZ0bArgs, projectId);
        if (
          payload.modelName === 'BELUGA' ||
          payload.modelName === 'NANO_BANANA_2_1' ||
          payload.modelName === 'NANO_BANANA_2_AUTO'
        ) {
          bridgeState.verifiedNanoBanana21Key = candidateKey;
        }
        lastRpcErr = null;
        break;
      } catch (err) {
        lastRpcErr = err;
        // If error is [5] (NOT_FOUND on model identifier) and there are fallback candidates, try next candidate
        if (err.rpcErrorCode === 5 && idx < candidateModels.length - 1) {
          continue;
        }
        throw err;
      }
    }

    if (lastRpcErr && !parsedResult) {
      throw lastRpcErr;
    }

    const firstGenItem = parsedResult?.[0]?.[0];
    const generatedMediaId = firstGenItem?.[0];
    const workflowId = firstGenItem?.[2] || parsedResult?.[1]?.[0]?.[0] || null;
    const signedUrl1K =
      firstGenItem?.[6]?.[0]?.[13] ||
      firstGenItem?.[6]?.[5]?.[1] ||
      null;
    const dimensions = firstGenItem?.[6]?.[2] || [1024, 1024];
    const returnedModelEnum = firstGenItem?.[6]?.[0]?.[8] ?? null;

    if (!generatedMediaId || typeof generatedMediaId !== 'string') {
      throw new Error(
        `图生图 (ogiZ0b, model=${activeWireModelKey}) 未返回有效的生成图像 ID: ${JSON.stringify(parsedResult).slice(
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
      modelUsed: returnedModelEnum ? `${activeWireModelKey} (enum=${returnedModelEnum})` : activeWireModelKey
    };
  }

  /**
   * Step 3 (2K / 4K): Upscale Generated Image (`rpcids=SPrCad`)
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

    const resolutionEnum = Number(payload.resolutionEnum) || 1; // 1 = 2K, 2 = 4K
    const clientContext = await buildClientContext(projectId);

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
        `超分放大 (SPrCad) 未返回图像 Base64 或下载链接: ${JSON.stringify(parsedResult).slice(0, 200)}`
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

  window.__ANTIGRAVITY_FLOW_BRIDGE_COMMAND_HANDLER__ = async function (command, payload = {}) {
    scanWizGlobalData();
    discoverRecaptchaSiteKey();

    if (command === 'GET_FLOW_CONTEXT_STATUS') {
      const detectedProjectId = detectProjectIdFromLocation();
      const hasWizAuth = Boolean(bridgeState.wizAtToken || bridgeState.wizFSid);

      // Check x2a status on current window.grecaptcha
      try {
        const execFn = window.grecaptcha?.enterprise?.execute;
        if (typeof execFn === 'function') {
          const fnStr = Function.prototype.toString.call(execFn);
          if (fnStr.includes('extension_hijack_detected')) {
            bridgeState.x2aTrapDetected = true;
          } else if (!bridgeState.pristineExecute) {
            savePristineExecute(execFn, window.grecaptcha.enterprise, 'status-check');
          }
        }
      } catch {
        // Ignore
      }

      const bypassMode = bridgeState.pristineExecute
        ? `Pristine 原生直连 (${bridgeState.captureSource})`
        : 'Object.assign 净化绕过 (已免疫 x2a 陷阱)';

      return {
        ok: true,
        bridgeVersion: BRIDGE_VERSION,
        pageUrl: location.href,
        projectId: detectedProjectId,
        sessionId: bridgeState.wizFSid,
        wizBuildLabel: bridgeState.wizBuildLabel,
        recaptchaReady: Boolean(window.grecaptcha?.enterprise || bridgeState.pristineExecute),
        recaptchaSiteKey: bridgeState.lastSiteKey,
        recaptchaAction: CAPTCHA_ACTION_IMAGE,
        recaptchaBypassMode: bypassMode,
        x2aTrapDetected: bridgeState.x2aTrapDetected,
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
              rpcErrorCode: err.rpcErrorCode || null,
              isProjectDeleted: Boolean(err.isProjectDeleted),
              isTombstonedMedia: Boolean(err.isTombstonedMedia)
            }
          },
          '*'
        );
      }
    });
  }
})();
