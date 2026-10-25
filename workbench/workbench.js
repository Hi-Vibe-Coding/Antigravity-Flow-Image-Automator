// workbench/workbench.js
// Main controller for Antigravity Flow Image Automator Workbench (v0.2.0)
// Implements:
// - Non-DOM batchexecute queue orchestration (maseQ -> ogiZ0b -> SPrCad / as29s)
// - IndexedDB crash recovery persistence (FlowAutomatorDB)
// - File System Access API direct folder output + chrome.downloads fallback
// - Sample test mode (1-3 images) & full batch queue with Pause / Resume / Cancel / Retry
// - Before / After comparison modal & JSON task report export

const DEFAULT_ECOMMERCE_PROMPT = `Enhance the overall image quality, sharpness, micro-details, lighting realism, and material texture of the product shown in the reference image for professional e-commerce display.
STRICT CONSTRAINTS:
1. Preserve the exact product identity, silhouette, geometry, proportions, and camera angle from the reference image.
2. Maintain the exact original colors, surface materials, and structural components.
3. Preserve all brand logos, typography, labels, packaging text, and fine markings faithfully without hallucinating, altering, or removing any characters.
4. Do NOT add, remove, or redesign any product parts or accessories.`;

const UPRES_REALISM_PROMPT = `Upres and fix this image to give me maximum quality.
Enhance the details to make the shot as realistic as possible.
No plastic skin or artificial smoothing. Keep all original product shapes, colors, textures, and markings 100% faithful to the reference image.`;

const VALID_IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];
const IDB_NAME = 'FlowAutomatorDB';
const IDB_VERSION = 2;
const IDB_STORE_TASKS = 'tasks';
const IDB_STORE_HANDLES = 'handles';

const appState = {
  inputDirHandle: null,
  outputDirHandle: null,
  tasks: [],
  capturedPackets: [],
  protocolSummary: {},
  lastBridgeStatus: null,
  queueStatus: 'IDLE', // 'IDLE' | 'RUNNING' | 'PAUSED'
  pauseRequested: false,
  cancelRequested: false,
  activeTaskId: null
};

// DOM references
const connectionBadge = document.getElementById('connectionBadge');
const btnSyncCatalog = document.getElementById('btnSyncCatalog');
const btnRefreshConnection = document.getElementById('btnRefreshConnection');
const btnOpenFlowTab = document.getElementById('btnOpenFlowTab');

const diagTabStatus = document.getElementById('diagTabStatus');
const diagTokenStatus = document.getElementById('diagTokenStatus');
const diagProjectId = document.getElementById('diagProjectId');
const diagRecaptcha = document.getElementById('diagRecaptcha');

const queueStateBadge = document.getElementById('queueStateBadge');
const statTotal = document.getElementById('statTotal');
const statPending = document.getElementById('statPending');
const statRunning = document.getElementById('statRunning');
const statCompleted = document.getElementById('statCompleted');
const statFailed = document.getElementById('statFailed');
const queueProgressFill = document.getElementById('queueProgressFill');
const queueLiveStepText = document.getElementById('queueLiveStepText');

const selectSampleCount = document.getElementById('selectSampleCount');
const btnRunSample = document.getElementById('btnRunSample');
const btnStartQueue = document.getElementById('btnStartQueue');
const btnPauseQueue = document.getElementById('btnPauseQueue');
const btnResumeQueue = document.getElementById('btnResumeQueue');
const btnCancelQueue = document.getElementById('btnCancelQueue');
const btnRetryFailed = document.getElementById('btnRetryFailed');
const btnExportTaskLog = document.getElementById('btnExportTaskLog');

const imageDropZone = document.getElementById('imageDropZone');
const btnPickInputDir = document.getElementById('btnPickInputDir');
const btnPickFiles = document.getElementById('btnPickFiles');
const btnPasteClipboard = document.getElementById('btnPasteClipboard');
const btnPickOutputDir = document.getElementById('btnPickOutputDir');
const btnClearCompleted = document.getElementById('btnClearCompleted');
const btnClearAllTasks = document.getElementById('btnClearAllTasks');
const fileInputFallback = document.getElementById('fileInputFallback');
const dirStatusText = document.getElementById('dirStatusText');
const imageTaskList = document.getElementById('imageTaskList');

const promptTextarea = document.getElementById('promptTextarea');
const btnPresetEcommerce = document.getElementById('btnPresetEcommerce');
const btnPresetUpres = document.getElementById('btnPresetUpres');
const selectModel = document.getElementById('selectModel');
const selectResolution = document.getElementById('selectResolution');
const selectAspect = document.getElementById('selectAspect');
const selectDelay = document.getElementById('selectDelay');
const selectMaxRetries = document.getElementById('selectMaxRetries');
const btnSaveConfig = document.getElementById('btnSaveConfig');
const configSavedHint = document.getElementById('configSavedHint');

const sumUploadUrl = document.getElementById('sumUploadUrl');
const sumGenerateUrl = document.getElementById('sumGenerateUrl');
const sumModels = document.getElementById('sumModels');
const sumAspectAndInputs = document.getElementById('sumAspectAndInputs');
const packetTableBody = document.getElementById('packetTableBody');
const btnClearPackets = document.getElementById('btnClearPackets');
const btnExportReport = document.getElementById('btnExportReport');

const previewDialog = document.getElementById('previewDialog');
const previewDialogTitle = document.getElementById('previewDialogTitle');
const previewDialogMeta = document.getElementById('previewDialogMeta');
const previewOrigImg = document.getElementById('previewOrigImg');
const previewEnhancedImg = document.getElementById('previewEnhancedImg');

const reportDialog = document.getElementById('reportDialog');
const reportDialogTitle = document.getElementById('reportDialogTitle');
const dialogJsonPre = document.getElementById('dialogJsonPre');
const btnCopyDialogJson = document.getElementById('btnCopyDialogJson');
const copyFeedback = document.getElementById('copyFeedback');

// Mandatory fallback for browsers without <dialog closedby="any"> support
for (const dlg of [reportDialog, previewDialog]) {
  if (dlg && !('closedBy' in HTMLDialogElement.prototype)) {
    dlg.addEventListener('click', (event) => {
      if (event.target !== dlg) return;
      const rect = dlg.getBoundingClientRect();
      const isDialogContent =
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width;
      if (isDialogContent) return;
      dlg.close();
    });
  }
}

// ============================================================================
// 1. INDEXEDDB CRASH RECOVERY PERSISTENCE
// ============================================================================

function openTaskDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE_TASKS)) {
        db.createObjectStore(IDB_STORE_TASKS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(IDB_STORE_HANDLES)) {
        db.createObjectStore(IDB_STORE_HANDLES, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveDirHandleToDb(key, handle) {
  try {
    const db = await openTaskDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_HANDLES, 'readwrite');
      tx.objectStore(IDB_STORE_HANDLES).put({ key, handle });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn('[Workbench IDB] Failed to save directory handle:', err);
  }
}

async function restoreDirHandlesFromDb() {
  try {
    const db = await openTaskDb();
    const records = await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_HANDLES, 'readonly');
      const req = tx.objectStore(IDB_STORE_HANDLES).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    db.close();
    for (const rec of records) {
      if (rec.key === 'outputDirHandle' && rec.handle) {
        appState.outputDirHandle = rec.handle;
      } else if (rec.key === 'inputDirHandle' && rec.handle) {
        appState.inputDirHandle = rec.handle;
      }
    }
  } catch (err) {
    console.warn('[Workbench IDB] Failed to restore directory handles:', err);
  }
}

async function ensureOutputDirPermission() {
  if (!appState.outputDirHandle) return false;
  try {
    if (typeof appState.outputDirHandle.queryPermission === 'function') {
      let perm = await appState.outputDirHandle.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') return true;
      if (typeof appState.outputDirHandle.requestPermission === 'function') {
        perm = await appState.outputDirHandle.requestPermission({ mode: 'readwrite' });
        return perm === 'granted';
      }
    }
    return true;
  } catch (err) {
    console.warn('[Workbench Save] Output directory permission check failed:', err);
    return false;
  }
}

async function saveTaskToDb(task, orderIndex = 0) {
  try {
    const db = await openTaskDb();
    const record = {
      id: task.id,
      orderIndex,
      name: task.name,
      size: task.size,
      mimeType: task.mimeType || 'image/png',
      status: task.status,
      sourceBlob: task.sourceBlob || null,
      enhancedBlob: task.enhancedBlob || null,
      outputFileName: task.outputFileName || null,
      uploadedMediaId: task.uploadedMediaId || null,
      generatedMediaId: task.generatedMediaId || null,
      upscaledMediaId: task.upscaledMediaId || null,
      modelUsed: task.modelUsed || null,
      resolutionUsed: task.resolutionUsed || null,
      aspectRatioUsed: task.aspectRatioUsed || null,
      promptUsed: task.promptUsed || null,
      enhancedDimensions: task.enhancedDimensions || null,
      durationMs: task.durationMs || null,
      errorMsg: task.errorMsg || null,
      updatedAt: new Date().toISOString()
    };
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_TASKS, 'readwrite');
      tx.objectStore(IDB_STORE_TASKS).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn('[Workbench IDB] Failed to persist task:', err);
  }
}

async function saveAllTasksOrderToDb() {
  for (let i = 0; i < appState.tasks.length; i++) {
    await saveTaskToDb(appState.tasks[i], i);
  }
}

async function deleteTaskFromDb(taskId) {
  try {
    const db = await openTaskDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_TASKS, 'readwrite');
      tx.objectStore(IDB_STORE_TASKS).delete(taskId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn('[Workbench IDB] Failed to delete task:', err);
  }
}

async function clearAllTasksFromDb() {
  try {
    const db = await openTaskDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_TASKS, 'readwrite');
      tx.objectStore(IDB_STORE_TASKS).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn('[Workbench IDB] Failed to clear tasks:', err);
  }
}

async function restoreTasksFromDb() {
  try {
    const db = await openTaskDb();
    const records = await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_TASKS, 'readonly');
      const req = tx.objectStore(IDB_STORE_TASKS).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    db.close();

    records.sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));

    let recoveredCount = 0;
    appState.tasks = records.map((rec) => {
      // If a task was interrupted while running before browser/tab closed, reset to PENDING
      let status = rec.status || 'PENDING';
      let errorMsg = rec.errorMsg || null;
      if (['UPLOADING', 'GENERATING', 'UPSCALING', 'SAVING'].includes(status)) {
        status = 'PENDING';
        errorMsg = '上次执行中断，已自动恢复为待处理';
        recoveredCount++;
      }

      const thumbUrl = rec.sourceBlob ? URL.createObjectURL(rec.sourceBlob) : '';
      const enhancedThumbUrl = rec.enhancedBlob ? URL.createObjectURL(rec.enhancedBlob) : '';

      return {
        ...rec,
        status,
        errorMsg,
        thumbUrl,
        enhancedThumbUrl
      };
    });

    if (recoveredCount > 0) {
      await saveAllTasksOrderToDb();
      queueLiveStepText.textContent = `已从断点恢复 ${appState.tasks.length} 个任务（其中 ${recoveredCount} 个中断任务已恢复为待处理，已完成任务不会重复执行）。`;
    }
  } catch (err) {
    console.warn('[Workbench IDB] Failed to restore tasks:', err);
  }
}

// ============================================================================
// 2. CONNECTION & MODEL CATALOG SYNC
// ============================================================================

async function checkFlowConnection() {
  connectionBadge.textContent = '正在检测连接...';
  connectionBadge.className = 'status-pill status-warn';

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'CHECK_FLOW_CONNECTION' });
    if (!resp || !resp.ok || !resp.connected) {
      connectionBadge.textContent = '未连接 Google Flow 标签页';
      connectionBadge.className = 'status-pill status-warn';
      diagTabStatus.textContent = resp?.message || '请点击右上角“打开 Google Flow 页面”';
      diagTokenStatus.textContent = '等待页面连接';
      return null;
    }

    const bs = resp.bridgeStatus || {};
    appState.lastBridgeStatus = bs;
    const session = bs.sessionInfo || {};

    diagTabStatus.textContent = `已连接 (Tab #${resp.tabId}: ${bs.pageUrl || resp.tabUrl || ''})`;

    if (session.hasToken) {
      connectionBadge.textContent = '已就绪 (Flow 会话与 RPC 引擎已连接)';
      connectionBadge.className = 'status-pill status-ok';
      diagTokenStatus.textContent = `已获取 (${session.tokenPrefix || 'at=...'}, 长度 ${
        session.tokenLength
      }, 来源: ${session.source || 'WIZ_global_data'})${session.userEmail ? ` - ${session.userEmail}` : ''}`;
    } else {
      connectionBadge.textContent = '已连接 Flow 页面 (请刷新一次 Flow 页面获取签名)';
      connectionBadge.className = 'status-pill status-warn';
      diagTokenStatus.textContent = '请在已打开的 Google Flow 页面按 F5 刷新一次以加载 WIZ_global_data 签名';
    }

    if (bs.projectId) {
      diagProjectId.textContent = bs.projectId;
    } else {
      diagProjectId.textContent = '当前位于 Flow 首页 — 请点击“新建项目”或进入任一项目 (/project/...)';
    }

    if (bs.recaptchaSiteKey) {
      const bypassBadge =
        bs.recaptchaBypassMode === 'PRISTINE_CAPTURED'
          ? ' [Pristine 原生直连]'
          : bs.recaptchaBypassMode === 'ASSIGN_NEUTER_ACTIVE'
            ? ' [Object.assign 净化绕过已激活]'
            : '';
      diagRecaptcha.textContent = `已就绪 (SiteKey: ${bs.recaptchaSiteKey.slice(0, 14)}...)${bypassBadge}`;
    } else if (bs.recaptchaReady) {
      diagRecaptcha.textContent = 'grecaptcha.enterprise 已加载并就绪';
    } else {
      diagRecaptcha.textContent = '等待 Flow 页面加载 grecaptcha';
    }

    populateDiscoveredModels(bs.discoveredImageModels, bs.observedModels);
    return bs;
  } catch (err) {
    connectionBadge.textContent = '检测异常';
    connectionBadge.className = 'status-pill status-err';
    diagTabStatus.textContent = err.message || String(err);
    return null;
  }
}

function populateDiscoveredModels() {
  // Keep #selectModel strictly limited to the 3 curated options:
  // NanoBanana 2.1(默认推荐), NanoBanana Pro, NanoBanana 2 Lite
}

// ============================================================================
// 3. PROTOCOL MONITOR TABLE
// ============================================================================

async function loadCapturedProtocolData() {
  const { capturedPackets = [], protocolSummary = {} } = await chrome.storage.local.get([
    'capturedPackets',
    'protocolSummary'
  ]);
  appState.capturedPackets = capturedPackets;
  appState.protocolSummary = protocolSummary;
  renderProtocolSummary();
  renderPacketTable();
}

function renderProtocolSummary() {
  const s = appState.protocolSummary || {};

  if (s.projectId && (!appState.lastBridgeStatus || !appState.lastBridgeStatus.projectId)) {
    diagProjectId.textContent = s.projectId;
  }
  if (s.recaptchaSiteKey) {
    diagRecaptcha.textContent = `已就绪 (SiteKey: ${s.recaptchaSiteKey.slice(0, 14)}...)`;
  }

  if (s.uploadEndpoint) sumUploadUrl.textContent = s.uploadEndpoint;
  if (s.generateEndpoint) sumGenerateUrl.textContent = s.generateEndpoint;

  const modelsSet = new Set([
    'GEM_PIX_2 (Nano Banana Pro)',
    'BELUGA (Nano Banana 2.1)',
    'HARBOR_SEAL (Nano Banana Lite)',
    ...(s.observedModels || [])
  ]);
  sumModels.textContent = Array.from(modelsSet).join(', ');

  if (s.upscaleEndpoint) {
    sumAspectAndInputs.textContent = s.upscaleEndpoint;
  }
}

function renderPacketTable() {
  const packets = appState.capturedPackets || [];
  packetTableBody.replaceChildren();

  if (packets.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.className = 'empty-cell';
    td.textContent = '暂无抓包记录。启动自动队列或在 Flow 页面操作后将实时显示 RPC 通信详情。';
    tr.appendChild(td);
    packetTableBody.appendChild(tr);
    return;
  }

  for (const pkt of packets) {
    const tr = document.createElement('tr');

    const tdTime = document.createElement('td');
    const timeStr = pkt.timestamp ? new Date(pkt.timestamp).toLocaleTimeString() : '-';
    tdTime.textContent = `${timeStr} (${pkt.durationMs || 0}ms)`;

    const tdCat = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `cat-badge cat-${pkt.category || 'FLOW_API_OTHER'}`;
    badge.textContent = pkt.category || 'OTHER';
    tdCat.appendChild(badge);

    const tdStatus = document.createElement('td');
    tdStatus.textContent = `${pkt.method || 'POST'} [${pkt.status || 0}]`;

    const tdUrl = document.createElement('td');
    tdUrl.style.maxWidth = '340px';
    tdUrl.style.wordBreak = 'break-all';
    tdUrl.textContent = pkt.url || '';

    const tdMeta = document.createElement('td');
    const metaParts = [];
    if (pkt.extractedMeta?.rpcId) metaParts.push(`rpcId: ${pkt.extractedMeta.rpcId}`);
    if (pkt.extractedMeta?.imageModelName) metaParts.push(`模型: ${pkt.extractedMeta.imageModelName}`);
    if (pkt.extractedMeta?.hasImageInputs) metaParts.push('已绑定参考图');
    if (pkt.extractedMeta?.returnedMediaIds?.length > 0) {
      metaParts.push(`MediaID: ${pkt.extractedMeta.returnedMediaIds[0].slice(0, 8)}...`);
    }
    tdMeta.textContent = metaParts.length > 0 ? metaParts.join(' | ') : '-';

    const tdAction = document.createElement('td');
    const btnView = document.createElement('button');
    btnView.type = 'button';
    btnView.className = 'btn btn-secondary btn-mini';
    btnView.textContent = '查看 JSON';
    btnView.addEventListener('click', () => {
      openJsonModal(`RPC 通信详情 — ${pkt.category}`, pkt);
    });
    tdAction.appendChild(btnView);

    tr.append(tdTime, tdCat, tdStatus, tdUrl, tdMeta, tdAction);
    packetTableBody.appendChild(tr);
  }
}

function openJsonModal(title, dataObj) {
  reportDialogTitle.textContent = title;
  dialogJsonPre.textContent = JSON.stringify(dataObj, null, 2);
  copyFeedback.textContent = '';
  reportDialog.showModal();
}

function buildSanitizedProtocolReport() {
  const s = appState.protocolSummary || {};
  const allPackets = appState.capturedPackets || [];
  const nonTelemetryPackets = allPackets.filter((p) => {
    const u = String(p.url || '');
    return !u.includes('rpcids=WuwhI') && !u.includes('rpcids=nzlxg');
  });

  return {
    reportGeneratedAt: new Date().toISOString(),
    flowTabBridgeStatus: appState.lastBridgeStatus || null,
    protocolSummary: {
      projectId: s.projectId || appState.lastBridgeStatus?.projectId || null,
      sessionId: s.sessionId || appState.lastBridgeStatus?.sessionId || null,
      recaptchaSiteKey: s.recaptchaSiteKey || appState.lastBridgeStatus?.recaptchaSiteKey || null,
      recaptchaAction: s.recaptchaAction || appState.lastBridgeStatus?.recaptchaAction || null,
      uploadEndpoint: s.uploadEndpoint,
      generateEndpoint: s.generateEndpoint,
      upscaleEndpoint: s.upscaleEndpoint,
      observedModels: s.observedModels,
      observedAspectRatios: s.observedAspectRatios
    },
    keyCapturedRequests: nonTelemetryPackets.slice(0, 20)
  };
}

// ============================================================================
// 4. IMAGE TASK MANAGEMENT & RENDERING
// ============================================================================

function isSupportedImageFile(filename) {
  const lower = filename.toLowerCase();
  return VALID_IMAGE_EXTS.some((ext) => lower.endsWith(ext));
}

function inferMimeType(filename, fileType) {
  if (fileType && fileType.startsWith('image/')) return fileType;
  const lower = filename.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/png';
}

function buildOutputFileName(origName, resolution = '2K', mimeType = 'image/jpeg') {
  const base = origName.replace(/\.[^.]+$/, '');
  const ext = mimeType === 'image/png' ? 'png' : 'jpg';
  return `${base}_enhanced_${resolution}.${ext}`;
}

let clipboardSeqCounter = 1;

function formatClipboardTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function createNamedClipboardFile(blobOrFile) {
  const mime = inferMimeType(blobOrFile.name || '', blobOrFile.type || 'image/png');
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
  const rawName = String(blobOrFile.name || '').trim();
  const isGenericClipboardName =
    !rawName ||
    /^image\.(png|jpe?g|webp)$/i.test(rawName) ||
    /^clipboard/i.test(rawName);
  const finalName = isGenericClipboardName
    ? `clipboard_${formatClipboardTimestamp()}_${clipboardSeqCounter++}.${ext}`
    : rawName;
  return new File([blobOrFile], finalName, { type: mime });
}

async function extractFilesFromDataTransfer(dataTransfer) {
  if (!dataTransfer) return [];
  const collected = [];

  // Support dragged directories via webkitGetAsEntry if available
  const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
  const entries = items
    .filter((item) => item.kind === 'file' && typeof item.webkitGetAsEntry === 'function')
    .map((item) => item.webkitGetAsEntry())
    .filter(Boolean);

  if (entries.length > 0) {
    async function readEntry(entry) {
      if (entry.isFile) {
        const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
        if (file && (isSupportedImageFile(file.name) || (file.type && file.type.startsWith('image/')))) {
          collected.push(file);
        }
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readBatch = async () => {
          const batch = await new Promise((resolve) =>
            reader.readEntries(resolve, () => resolve([]))
          );
          if (batch.length > 0) {
            for (const sub of batch) {
              await readEntry(sub);
            }
            await readBatch();
          }
        };
        await readBatch();
      }
    }

    for (const entry of entries) {
      await readEntry(entry);
    }
    if (collected.length > 0) {
      return collected.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    }
  }

  // Fallback to standard dataTransfer.files
  if (dataTransfer.files && dataTransfer.files.length > 0) {
    for (const f of Array.from(dataTransfer.files)) {
      if (isSupportedImageFile(f.name) || (f.type && f.type.startsWith('image/'))) {
        collected.push(f);
      }
    }
  }
  return collected.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

async function addFilesToTaskList(fileList) {
  let addedCount = 0;
  for (const rawFile of fileList) {
    const hasValidExt = isSupportedImageFile(rawFile.name || '');
    const isImageMime = Boolean(rawFile.type && rawFile.type.startsWith('image/'));
    if (!hasValidExt && !isImageMime) continue;

    const file = hasValidExt ? rawFile : createNamedClipboardFile(rawFile);
    const exists = appState.tasks.some((t) => t.name === file.name && t.size === file.size);
    if (exists) continue;

    const sourceBlob = new Blob([await file.arrayBuffer()], {
      type: inferMimeType(file.name, file.type)
    });
    const thumbUrl = URL.createObjectURL(sourceBlob);
    const newTask = {
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: file.name,
      size: file.size,
      mimeType: sourceBlob.type,
      sourceBlob,
      enhancedBlob: null,
      thumbUrl,
      enhancedThumbUrl: '',
      status: 'PENDING',
      outputFileName: buildOutputFileName(file.name, selectResolution.value, 'image/jpeg'),
      uploadedMediaId: null,
      generatedMediaId: null,
      upscaledMediaId: null,
      modelUsed: null,
      resolutionUsed: null,
      aspectRatioUsed: null,
      promptUsed: null,
      enhancedDimensions: null,
      durationMs: null,
      errorMsg: null
    };

    appState.tasks.push(newTask);
    await saveTaskToDb(newTask, appState.tasks.length - 1);
    addedCount++;
  }
  renderTaskList();
  updateDirStatusBanner();
  return addedCount;
}

function updateDirStatusBanner() {
  const inName = appState.inputDirHandle
    ? `文件夹 [${appState.inputDirHandle.name}] (${appState.tasks.length} 张)`
    : `已导入 ${appState.tasks.length} 张商品原图`;
  const outName = appState.outputDirHandle
    ? `本地文件夹 [${appState.outputDirHandle.name}] (File System API 直接落盘，不覆盖原图)`
    : '未绑定文件夹（将通过浏览器下载通道自动保存至系统下载目录 Flow_Enhanced/ 子目录）';
  dirStatusText.textContent = `原图来源：${inName} | 输出位置：${outName}`;
}

const STATUS_LABELS = {
  PENDING: '待处理',
  UPLOADING: '1/3 上传参考图...',
  GENERATING: '2/3 AI 图生图中...',
  UPSCALING: '3/3 2K 超分放大中...',
  SAVING: '正在校验并保存...',
  COMPLETED: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消'
};

function updateQueueStatsUI() {
  const total = appState.tasks.length;
  const pending = appState.tasks.filter((t) => t.status === 'PENDING').length;
  const running = appState.tasks.filter((t) =>
    ['UPLOADING', 'GENERATING', 'UPSCALING', 'SAVING'].includes(t.status)
  ).length;
  const completed = appState.tasks.filter((t) => t.status === 'COMPLETED').length;
  const failed = appState.tasks.filter((t) => t.status === 'FAILED' || t.status === 'CANCELLED').length;

  statTotal.textContent = String(total);
  statPending.textContent = String(pending);
  statRunning.textContent = String(running);
  statCompleted.textContent = String(completed);
  statFailed.textContent = String(failed);

  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  queueProgressFill.style.width = `${percent}%`;

  const isRunning = appState.queueStatus === 'RUNNING';
  const isPaused = appState.queueStatus === 'PAUSED';

  btnRunSample.disabled = isRunning || total === 0;
  btnStartQueue.disabled = isRunning || total === 0;
  btnPauseQueue.disabled = !isRunning;
  btnCancelQueue.disabled = !isRunning && !isPaused;
  btnResumeQueue.hidden = !isPaused;

  if (isRunning) {
    queueStateBadge.textContent = '队列执行中...';
    queueStateBadge.className = 'status-pill status-warn';
  } else if (isPaused) {
    queueStateBadge.textContent = '队列已暂停';
    queueStateBadge.className = 'status-pill status-warn';
  } else {
    queueStateBadge.textContent = '队列空闲就绪';
    queueStateBadge.className = 'status-pill status-ok';
  }
}

function renderTaskList() {
  updateQueueStatsUI();
  imageTaskList.replaceChildren();

  if (appState.tasks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-cell';

    const title = document.createElement('div');
    title.className = 'drop-empty-title';
    title.innerHTML =
      '拖拽图片 / 文件夹到此处，或直接按 <kbd>Ctrl</kbd>+<kbd>V</kbd> 粘贴剪贴板图片';

    const sub = document.createElement('div');
    sub.className = 'drop-empty-sub';
    sub.textContent =
      '也可点击上方“选择原图文件夹”导入（支持 JPG、JPEG、PNG、WebP）';

    empty.append(title, sub);
    imageTaskList.appendChild(empty);
    return;
  }

  appState.tasks.forEach((task, index) => {
    const row = document.createElement('div');
    const isRunningTask = ['UPLOADING', 'GENERATING', 'UPSCALING', 'SAVING'].includes(task.status);
    row.className = `task-item${isRunningTask ? ' task-running' : ''}${
      task.status === 'COMPLETED' ? ' task-completed' : ''
    }${task.status === 'FAILED' ? ' task-failed' : ''}`;

    const left = document.createElement('div');
    left.className = 'task-left';

    const thumbsWrap = document.createElement('div');
    thumbsWrap.className = 'task-thumbs-pair';

    const origImg = document.createElement('img');
    origImg.className = 'task-thumb';
    origImg.src = task.thumbUrl;
    origImg.alt = task.name;
    origImg.title = `原图: ${task.name}`;
    thumbsWrap.appendChild(origImg);

    if (task.enhancedThumbUrl) {
      const arrow = document.createElement('span');
      arrow.className = 'task-thumb-arrow';
      arrow.textContent = '→';
      const enhImg = document.createElement('img');
      enhImg.className = 'task-thumb';
      enhImg.src = task.enhancedThumbUrl;
      enhImg.alt = task.outputFileName || '增强结果';
      enhImg.title = '点击对比预览';
      enhImg.style.cursor = 'pointer';
      enhImg.addEventListener('click', () => openBeforeAfterModal(task));
      thumbsWrap.append(arrow, enhImg);
    }

    const meta = document.createElement('div');
    meta.className = 'task-meta';

    const nameEl = document.createElement('div');
    nameEl.className = 'task-name';
    nameEl.textContent = `${index + 1}. ${task.name}`;

    const subEl = document.createElement('div');
    subEl.className = 'task-sub';

    const stBadge = document.createElement('span');
    stBadge.className = `task-status-badge st-${task.status}`;
    stBadge.textContent = STATUS_LABELS[task.status] || task.status;
    subEl.appendChild(stBadge);

    const sizeKb = (task.size / 1024).toFixed(1);
    const outName =
      task.outputFileName || buildOutputFileName(task.name, selectResolution.value, 'image/jpeg');
    let detailStr = `${sizeKb} KB | 输出: ${outName}`;
    if (task.modelUsed) detailStr += ` | 模型: ${task.modelUsed}`;
    if (task.enhancedDimensions) {
      detailStr += ` (${task.enhancedDimensions[0]}×${task.enhancedDimensions[1]})`;
    }
    if (task.durationMs) detailStr += ` | 耗时: ${(task.durationMs / 1000).toFixed(1)}s`;
    if (task.errorMsg) detailStr += ` | 错误: ${task.errorMsg}`;

    const detailSpan = document.createElement('span');
    detailSpan.textContent = detailStr;
    if (task.errorMsg) detailSpan.className = 'text-err';
    subEl.appendChild(detailSpan);

    meta.append(nameEl, subEl);
    left.append(thumbsWrap, meta);

    const actions = document.createElement('div');
    actions.className = 'task-actions';

    if (task.status === 'COMPLETED' && task.enhancedThumbUrl) {
      const btnCompare = document.createElement('button');
      btnCompare.type = 'button';
      btnCompare.className = 'btn btn-primary btn-mini';
      btnCompare.textContent = '对比预览';
      btnCompare.addEventListener('click', () => openBeforeAfterModal(task));
      actions.appendChild(btnCompare);
    }

    const btnSingleRun = document.createElement('button');
    btnSingleRun.type = 'button';
    btnSingleRun.className = 'btn btn-secondary btn-mini';
    btnSingleRun.textContent = task.status === 'COMPLETED' ? '重新生成' : '单张执行';
    btnSingleRun.disabled = appState.queueStatus === 'RUNNING';
    btnSingleRun.addEventListener('click', async () => {
      task.status = 'PENDING';
      task.errorMsg = null;
      await saveTaskToDb(task, index);
      renderTaskList();
      await runSingleTaskStandalone(task);
    });
    actions.appendChild(btnSingleRun);

    const btnUp = document.createElement('button');
    btnUp.type = 'button';
    btnUp.className = 'btn btn-secondary btn-mini';
    btnUp.textContent = '↑';
    btnUp.disabled = index === 0 || appState.queueStatus === 'RUNNING';
    btnUp.addEventListener('click', async () => {
      const tmp = appState.tasks[index - 1];
      appState.tasks[index - 1] = appState.tasks[index];
      appState.tasks[index] = tmp;
      await saveAllTasksOrderToDb();
      renderTaskList();
    });

    const btnDown = document.createElement('button');
    btnDown.type = 'button';
    btnDown.className = 'btn btn-secondary btn-mini';
    btnDown.textContent = '↓';
    btnDown.disabled = index === appState.tasks.length - 1 || appState.queueStatus === 'RUNNING';
    btnDown.addEventListener('click', async () => {
      const tmp = appState.tasks[index + 1];
      appState.tasks[index + 1] = appState.tasks[index];
      appState.tasks[index] = tmp;
      await saveAllTasksOrderToDb();
      renderTaskList();
    });

    const btnDel = document.createElement('button');
    btnDel.type = 'button';
    btnDel.className = 'btn btn-secondary btn-mini';
    btnDel.textContent = '移除';
    btnDel.disabled = isRunningTask;
    btnDel.addEventListener('click', async () => {
      if (task.thumbUrl) URL.revokeObjectURL(task.thumbUrl);
      if (task.enhancedThumbUrl) URL.revokeObjectURL(task.enhancedThumbUrl);
      appState.tasks.splice(index, 1);
      await deleteTaskFromDb(task.id);
      await saveAllTasksOrderToDb();
      renderTaskList();
      updateDirStatusBanner();
    });

    actions.append(btnUp, btnDown, btnDel);
    row.append(left, actions);
    imageTaskList.appendChild(row);
  });
}

function openBeforeAfterModal(task) {
  previewDialogTitle.textContent = `原图 vs 增强结果对比 — ${task.name}`;
  const dims = task.enhancedDimensions
    ? `${task.enhancedDimensions[0]}×${task.enhancedDimensions[1]}px`
    : task.resolutionUsed || '2K';
  previewDialogMeta.textContent = `模型: ${task.modelUsed || '-'} | 分辨率: ${dims} | 输出文件: ${
    task.outputFileName || '-'
  } | 耗时: ${task.durationMs ? (task.durationMs / 1000).toFixed(1) + 's' : '-'}`;
  previewOrigImg.src = task.thumbUrl;
  previewEnhancedImg.src = task.enhancedThumbUrl;
  previewDialog.showModal();
}

// ============================================================================
// 5. CORE 3-STEP NON-DOM EXECUTION PIPELINE & FILE SAVING
// ============================================================================

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const str = String(reader.result || '');
      const comma = str.indexOf(',');
      resolve(comma >= 0 ? str.slice(comma + 1) : str);
    };
    reader.onerror = () => reject(new Error('读取本地原图 Base64 失败'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Prevents Google Flow `maseQ` content-hash tombstone collisions (`[5] NOT_FOUND`) when
 * a user deletes previously uploaded images in the Flow project webpage and re-runs the same files.
 * Draws the image at 100% original resolution and flips the least-significant bit (±1/255, visually imperceptible)
 * of 3 random corner/edge pixels so every upload produces a brand-new SHA-256 byte & pixel hash.
 */
async function blobToUniqueUploadBase64(blob, origMimeType = 'image/jpeg', origFileName = 'product.jpg', forcePng = false) {
  try {
    const bmp = await createImageBitmap(blob);
    const width = bmp.width;
    const height = bmp.height;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    bmp.close();

    // Flip LSB (^ 1) on 3 random pixels so both pixel-hash and file-byte-hash are 100% unique
    const coords = [
      [Math.floor(Math.random() * Math.min(8, width)), Math.floor(Math.random() * Math.min(8, height))],
      [Math.max(0, width - 1 - Math.floor(Math.random() * Math.min(8, width))), Math.floor(Math.random() * Math.min(8, height))],
      [Math.floor(Math.random() * width), Math.max(0, height - 1 - Math.floor(Math.random() * Math.min(8, height)))]
    ];

    for (const [px, py] of coords) {
      const imgData = ctx.getImageData(px, py, 1, 1);
      imgData.data[0] = imgData.data[0] ^ 1;
      imgData.data[1] = imgData.data[1] ^ (Math.random() > 0.5 ? 1 : 0);
      imgData.data[2] = imgData.data[2] ^ 1;
      ctx.putImageData(imgData, px, py);
    }

    const usePng = forcePng || origMimeType === 'image/png' || origMimeType === 'image/webp';
    const targetMime = usePng ? 'image/png' : 'image/jpeg';
    const dataUrl = usePng ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.98);
    const commaIdx = dataUrl.indexOf(',');
    const base64Data = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;

    const baseName = origFileName.replace(/\.[^.]+$/, '');
    const ext = usePng ? 'png' : 'jpg';
    const randSuffix = Math.random().toString(36).slice(2, 6);
    return {
      base64Data,
      mimeType: targetMime,
      uploadFileName: `${baseName}_${randSuffix}.${ext}`
    };
  } catch (err) {
    console.warn('[Workbench Upload] Canvas hash uniquification fallback to raw blob:', err);
    return {
      base64Data: await blobToBase64(blob),
      mimeType: origMimeType || 'image/png',
      uploadFileName: origFileName
    };
  }
}

function base64ToBlob(base64Str, mimeType = 'image/jpeg') {
  const clean = base64Str.includes(',') ? base64Str.split(',')[1] : base64Str;
  const binStr = atob(clean);
  const len = binStr.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binStr.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

async function verifyAndMeasureImageBlob(blob) {
  if (!blob || blob.size < 2048) {
    throw new Error(`生成的图像字节过小 (${blob ? blob.size : 0} bytes)，疑似下载损坏`);
  }
  const bmp = await createImageBitmap(blob);
  const width = bmp.width;
  const height = bmp.height;
  bmp.close();
  if (width < 64 || height < 64) {
    throw new Error(`生成的图像尺寸异常 (${width}×${height})`);
  }
  return [width, height];
}

async function saveEnhancedBlobToDisk(blob, outputFileName) {
  // 1. Prefer user-selected output directory via File System Access API
  if (appState.outputDirHandle) {
    try {
      const fileHandle = await appState.outputDirHandle.getFileHandle(outputFileName, {
        create: true
      });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { savedVia: 'FileSystemAccessAPI', path: `${appState.outputDirHandle.name}/${outputFileName}` };
    } catch (err) {
      console.warn('[Workbench Save] File System Access API write failed, falling back to chrome.downloads:', err);
    }
  }

  // 2. Fallback to chrome.downloads into Flow_Enhanced/ subfolder
  const tempUrl = URL.createObjectURL(blob);
  try {
    const downloadId = await chrome.downloads.download({
      url: tempUrl,
      filename: `Flow_Enhanced/${outputFileName}`,
      conflictAction: 'uniquify',
      saveAs: false
    });
    setTimeout(() => URL.revokeObjectURL(tempUrl), 15000);
    return { savedVia: 'chrome.downloads', downloadId, path: `Downloads/Flow_Enhanced/${outputFileName}` };
  } catch (err) {
    URL.revokeObjectURL(tempUrl);
    throw new Error(`保存生成图片到本地失败: ${err.message || err}`);
  }
}

async function sendFlowCommand(command, payload, timeoutMs = 180000) {
  const resp = await chrome.runtime.sendMessage({
    type: 'EXECUTE_IN_FLOW_TAB',
    command,
    payload,
    timeoutMs
  });
  if (!resp || !resp.ok) {
    const err = new Error(resp?.error || `执行 Google Flow 命令 [${command}] 失败`);
    err.rpcErrorCode = resp?.rpcErrorCode || null;
    throw err;
  }
  return resp;
}

/**
 * Execute a single Image-to-Image task end-to-end:
 * Step 1: Upload reference image (`maseQ`)
 * Step 2: Generate enhanced image with reference binding (`ogiZ0b`)
 * Step 3: Upscale to 2K (`SPrCad`) or fetch 1K (`as29s`/CDN)
 * Step 4: Verify image integrity & save to disk
 */
async function executeSingleTaskPipeline(task, taskIndex) {
  const startTime = Date.now();
  const promptText = promptTextarea.value.trim();
  const selectedModelVal = selectModel.value;
  const selectedResolutionVal = selectResolution.value; // '2K' | '1K'
  const selectedAspectEnum = Number(selectAspect.value) || 1;

  if (!promptText) {
    throw new Error('统一图像增强提示词不能为空');
  }

  // Step 1: Upload Reference Image (maseQ + ngNC2 + as29s readiness check)
  task.status = 'UPLOADING';
  task.errorMsg = null;
  queueLiveStepText.textContent = `[${taskIndex + 1}/${appState.tasks.length}] 正在上传并校验参考原图: ${task.name} (maseQ)...`;
  renderTaskList();
  await saveTaskToDb(task, taskIndex);

  const uniqueUpload = await blobToUniqueUploadBase64(
    task.sourceBlob,
    task.mimeType || 'image/jpeg',
    task.name,
    false
  );
  let uploadRes = await sendFlowCommand('EXECUTE_UPLOAD_IMAGE', {
    base64Data: uniqueUpload.base64Data,
    mimeType: uniqueUpload.mimeType,
    fileName: uniqueUpload.uploadFileName
  });

  let uploadedMediaId = uploadRes.uploadedMediaId;
  task.uploadedMediaId = uploadedMediaId;

  if (appState.cancelRequested) {
    throw new Error('任务已被用户取消');
  }

  // Step 2: Image-to-Image Generation (ogiZ0b) with automatic [5] NOT_FOUND recovery
  task.status = 'GENERATING';
  queueLiveStepText.textContent = `[${taskIndex + 1}/${appState.tasks.length}] 原图已就绪 (${uploadedMediaId.slice(
    0,
    8
  )}...)，正在调用 ${selectedModelVal} 执行图生图 (ogiZ0b)...`;
  renderTaskList();
  await saveTaskToDb(task, taskIndex);

  let genRes = null;
  try {
    genRes = await sendFlowCommand('EXECUTE_GENERATE_IMAGE', {
      uploadedMediaId,
      prompt: promptText,
      modelName: selectedModelVal,
      aspectRatioEnum: selectedAspectEnum
    });
  } catch (genErr) {
    const isNotFoundErr =
      genErr.rpcErrorCode === 5 || (genErr.message && genErr.message.includes('返回服务端错误码: [5]'));
    if (isNotFoundErr && !appState.cancelRequested) {
      queueLiveStepText.textContent = `[${taskIndex + 1}/${appState.tasks.length}] 检测到参考图缓存索引同步延迟 ([5])，正在重新生成无损指纹并重传原图...`;
      await sleepMs(1500);
      const retryUploadPayload = await blobToUniqueUploadBase64(
        task.sourceBlob,
        task.mimeType || 'image/png',
        task.name,
        true
      );
      uploadRes = await sendFlowCommand('EXECUTE_UPLOAD_IMAGE', {
        base64Data: retryUploadPayload.base64Data,
        mimeType: retryUploadPayload.mimeType,
        fileName: retryUploadPayload.uploadFileName
      });
      uploadedMediaId = uploadRes.uploadedMediaId;
      task.uploadedMediaId = uploadedMediaId;

      genRes = await sendFlowCommand('EXECUTE_GENERATE_IMAGE', {
        uploadedMediaId,
        prompt: promptText,
        modelName: selectedModelVal,
        aspectRatioEnum: selectedAspectEnum
      });
    } else {
      throw genErr;
    }
  }

  const generatedMediaId = genRes.generatedMediaId;
  task.generatedMediaId = generatedMediaId;
  task.modelUsed = genRes.modelUsed || selectedModelVal;
  task.aspectRatioUsed = selectedAspectEnum;
  task.promptUsed = promptText;

  if (appState.cancelRequested) {
    throw new Error('任务已被用户取消');
  }

  // Step 3: Resolution Output (2K / 4K Upscale via SPrCad OR 1K Direct Download)
  let finalBase64 = null;
  let finalMimeType = 'image/jpeg';

  if (selectedResolutionVal === '2K' || selectedResolutionVal === '4K') {
    const upscaleEnum = selectedResolutionVal === '4K' ? 2 : 1;
    task.status = 'UPSCALING';
    queueLiveStepText.textContent = `[${taskIndex + 1}/${appState.tasks.length}] 1K 生成完成 (${generatedMediaId.slice(
      0,
      8
    )}...)，正在执行 ${selectedResolutionVal} 超分放大导出 (SPrCad)...`;
    renderTaskList();
    await saveTaskToDb(task, taskIndex);

    const upscaleRes = await sendFlowCommand('EXECUTE_UPSCALE_IMAGE', {
      generatedMediaId,
      resolutionEnum: upscaleEnum
    });

    task.upscaledMediaId = upscaleRes.upscaledMediaId || null;
    if (upscaleRes.base64Data) {
      finalBase64 = upscaleRes.base64Data;
      finalMimeType = upscaleRes.mimeType || 'image/jpeg';
    } else if (upscaleRes.signedUrl) {
      const dlRes = await sendFlowCommand('FETCH_MEDIA_AS_BASE64', {
        mediaId: upscaleRes.upscaledMediaId || generatedMediaId,
        signedUrl: upscaleRes.signedUrl
      });
      finalBase64 = dlRes.base64Data;
      finalMimeType = dlRes.mimeType || 'image/jpeg';
    }
  } else {
    task.status = 'SAVING';
    queueLiveStepText.textContent = `[${taskIndex + 1}/${appState.tasks.length}] 正在拉取 1K 原生生成图像 (${generatedMediaId.slice(
      0,
      8
    )}...)...`;
    renderTaskList();

    const dlRes = await sendFlowCommand('FETCH_MEDIA_AS_BASE64', {
      mediaId: generatedMediaId,
      signedUrl: genRes.signedUrl1K
    });
    finalBase64 = dlRes.base64Data;
    finalMimeType = dlRes.mimeType || 'image/jpeg';
  }

  if (!finalBase64) {
    throw new Error('未获取到最终增强图像的字节数据');
  }

  // Step 4: Verify image integrity & save to local output directory
  task.status = 'SAVING';
  renderTaskList();

  const enhancedBlob = base64ToBlob(finalBase64, finalMimeType);
  const measuredDims = await verifyAndMeasureImageBlob(enhancedBlob);

  const outputFileName = buildOutputFileName(task.name, selectedResolutionVal, finalMimeType);
  await saveEnhancedBlobToDisk(enhancedBlob, outputFileName);

  if (task.enhancedThumbUrl) {
    URL.revokeObjectURL(task.enhancedThumbUrl);
  }
  task.enhancedBlob = enhancedBlob;
  task.enhancedThumbUrl = URL.createObjectURL(enhancedBlob);
  task.outputFileName = outputFileName;
  task.resolutionUsed = selectedResolutionVal;
  task.enhancedDimensions = measuredDims;
  task.durationMs = Date.now() - startTime;
  task.status = 'COMPLETED';
  task.errorMsg = null;

  await saveTaskToDb(task, taskIndex);
  renderTaskList();
}

// ============================================================================
// 6. AUTOMATED QUEUE CONTROLLER (SAMPLE MODE, BATCH MODE, RETRY & RATE-LIMIT)
// ============================================================================

function parseDelayRangeMs() {
  const val = selectDelay.value || '2000-4500';
  const [minStr, maxStr] = val.split('-');
  const min = Number(minStr) || 2000;
  const max = Number(maxStr) || 4500;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSingleTaskStandalone(task) {
  await ensureOutputDirPermission();
  const bs = await checkFlowConnection();
  if (!bs || !bs.projectId) {
    alert('请先在 Chrome 中打开 Google Flow 并进入一个具体项目 (/project/...) 页面后再开始执行！');
    return;
  }

  appState.queueStatus = 'RUNNING';
  appState.cancelRequested = false;
  appState.pauseRequested = false;
  const idx = appState.tasks.indexOf(task);

  try {
    await executeSingleTaskPipeline(task, idx >= 0 ? idx : 0);
    queueLiveStepText.textContent = `单张任务 [${task.name}] 执行成功！已保存为 ${task.outputFileName}。`;
  } catch (err) {
    task.status = 'FAILED';
    task.errorMsg = err.message || String(err);
    await saveTaskToDb(task, idx >= 0 ? idx : 0);
    queueLiveStepText.textContent = `单张任务 [${task.name}] 失败: ${task.errorMsg}`;
  } finally {
    appState.queueStatus = 'IDLE';
    renderTaskList();
  }
}

async function startQueueLoop({ sampleLimit = null } = {}) {
  if (appState.queueStatus === 'RUNNING') return;

  await ensureOutputDirPermission();
  const bs = await checkFlowConnection();
  if (!bs || !bs.projectId) {
    alert(
      '未检测到 Google Flow 项目 ID (projectId)。\n请先点击右上角“打开 Google Flow 页面”，在页面中点击“新建项目”或进入任一已有项目 (/project/...) 后再启动队列！'
    );
    return;
  }
  if (!bs.sessionInfo?.hasToken) {
    alert('Google Flow 页面尚未加载会话签名，请先刷新一次 Google Flow 标签页后再启动队列！');
    return;
  }

  const pendingTasks = appState.tasks.filter((t) => t.status === 'PENDING');
  if (pendingTasks.length === 0) {
    alert('当前没有处于“待处理 (PENDING)”状态的任务。如需重试失败项，请先点击“重试失败项”。');
    return;
  }

  appState.queueStatus = 'RUNNING';
  appState.pauseRequested = false;
  appState.cancelRequested = false;
  renderTaskList();

  const maxRetries = Number(selectMaxRetries.value) || 0;
  let processedInThisRun = 0;

  for (let i = 0; i < appState.tasks.length; i++) {
    const task = appState.tasks[i];
    if (task.status !== 'PENDING') continue;

    if (appState.cancelRequested) {
      task.status = 'CANCELLED';
      await saveTaskToDb(task, i);
      continue;
    }

    if (appState.pauseRequested) {
      appState.queueStatus = 'PAUSED';
      queueLiveStepText.textContent = `队列已暂停（已完成 ${processedInThisRun} 张，点击“继续队列”可从当前位置恢复）。`;
      renderTaskList();
      return;
    }

    let attempt = 0;
    let taskSucceeded = false;

    while (attempt <= maxRetries && !taskSucceeded) {
      try {
        if (attempt > 0) {
          const isUnusualActivity =
            task.errorMsg && task.errorMsg.includes('PUBLIC_ERROR_UNUSUAL_ACTIVITY');
          const backoffMs = isUnusualActivity
            ? 20000
            : Math.min(3000 * Math.pow(2, attempt - 1), 12000);
          queueLiveStepText.textContent = `[${task.name}] 第 ${attempt} 次自动重试前冷却等待 ${(
            backoffMs / 1000
          ).toFixed(1)} 秒...`;
          await sleepMs(backoffMs);
        }

        await executeSingleTaskPipeline(task, i);
        taskSucceeded = true;
        processedInThisRun++;
      } catch (err) {
        attempt++;
        const msg = err.message || String(err);
        task.errorMsg = msg;

        // If user cancelled or fatal auth/quota error, do not retry blindly
        if (
          appState.cancelRequested ||
          msg.includes('401') ||
          msg.includes('403') ||
          msg.includes('429') ||
          msg.includes('RESOURCE_EXHAUSTED')
        ) {
          task.status = appState.cancelRequested ? 'CANCELLED' : 'FAILED';
          task.errorMsg = msg;
          await saveTaskToDb(task, i);
          appState.queueStatus = 'PAUSED';
          queueLiveStepText.textContent = `检测到关键响应 (${msg})，队列已自动暂停以保护账号额度。`;
          renderTaskList();
          return;
        }

        if (attempt > maxRetries) {
          task.status = 'FAILED';
          task.errorMsg = msg;
          await saveTaskToDb(task, i);
          renderTaskList();
        }
      }
    }

    // Check if we reached sample test limit
    if (sampleLimit && processedInThisRun >= sampleLimit) {
      appState.queueStatus = 'IDLE';
      queueLiveStepText.textContent = `样本测试完成（已成功处理 ${processedInThisRun} 张图片）！请点击列表中的“对比预览”检查效果，满意后可点击“开始全部队列”继续处理剩余图片。`;
      renderTaskList();
      return;
    }

    // Inter-task rate-limit jitter delay if there are more pending tasks
    const hasMorePending = appState.tasks.slice(i + 1).some((t) => t.status === 'PENDING');
    if (hasMorePending && !appState.pauseRequested && !appState.cancelRequested) {
      const delayMs = parseDelayRangeMs();
      queueLiveStepText.textContent = `已完成 [${task.name}]，冷却等待 ${(delayMs / 1000).toFixed(
        1
      )} 秒后执行下一张...`;
      await sleepMs(delayMs);
    }
  }

  appState.queueStatus = 'IDLE';
  const totalCompleted = appState.tasks.filter((t) => t.status === 'COMPLETED').length;
  const totalFailed = appState.tasks.filter((t) => t.status === 'FAILED').length;
  queueLiveStepText.textContent = `队列执行完毕！共成功 ${totalCompleted} 张，失败 ${totalFailed} 张。`;
  renderTaskList();
}

// ============================================================================
// 7. EVENT LISTENERS & INITIALIZATION
// ============================================================================

async function initWorkbench() {
  const {
    userPrompt,
    selectedModel,
    defaultModelV027Migrated,
    selectedResolution,
    selectedAspect,
    selectedDelay,
    selectedMaxRetries
  } = await chrome.storage.local.get([
    'userPrompt',
    'selectedModel',
    'defaultModelV027Migrated',
    'selectedResolution',
    'selectedAspect',
    'selectedDelay',
    'selectedMaxRetries'
  ]);

  promptTextarea.value = userPrompt || DEFAULT_ECOMMERCE_PROMPT;

  const VALID_MODELS = new Set(['BELUGA', 'GEM_PIX_2', 'HARBOR_SEAL']);
  const VALID_RESOLUTIONS = new Set(['2K', '1K']);
  const VALID_ASPECTS = new Set(['1', '2', '3', '4', '5']);

  if (!defaultModelV027Migrated) {
    selectModel.value = 'BELUGA';
    selectResolution.value = VALID_RESOLUTIONS.has(selectedResolution) ? selectedResolution : '2K';
    selectAspect.value = '1'; // Default 1:1
    selectMaxRetries.value = '0'; // Default 不自动重试
    await chrome.storage.local.set({
      selectedModel: 'BELUGA',
      selectedResolution: selectResolution.value,
      selectedAspect: '1',
      selectedMaxRetries: '0',
      defaultModelV027Migrated: true
    });
  } else {
    selectModel.value = VALID_MODELS.has(selectedModel) ? selectedModel : 'BELUGA';
    selectResolution.value = VALID_RESOLUTIONS.has(selectedResolution) ? selectedResolution : '2K';
    selectAspect.value = VALID_ASPECTS.has(selectedAspect) ? selectedAspect : '1';
    selectMaxRetries.value =
      selectedMaxRetries === '0' || selectedMaxRetries === '1' || selectedMaxRetries === '2'
        ? selectedMaxRetries
        : '0';
  }

  if (selectedDelay) selectDelay.value = selectedDelay;

  selectModel.addEventListener('change', () => {
    chrome.storage.local.set({ selectedModel: selectModel.value });
  });
  selectResolution.addEventListener('change', () => {
    chrome.storage.local.set({ selectedResolution: selectResolution.value });
  });
  selectAspect.addEventListener('change', () => {
    chrome.storage.local.set({ selectedAspect: selectAspect.value });
  });
  selectDelay.addEventListener('change', () => {
    chrome.storage.local.set({ selectedDelay: selectDelay.value });
  });
  selectMaxRetries.addEventListener('change', () => {
    chrome.storage.local.set({ selectedMaxRetries: selectMaxRetries.value });
  });

  await restoreDirHandlesFromDb();
  await restoreTasksFromDb();
  renderTaskList();
  updateDirStatusBanner();

  await checkFlowConnection();
  await loadCapturedProtocolData();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.capturedPackets || changes.protocolSummary) {
      loadCapturedProtocolData();
    }
  });

  btnRefreshConnection.addEventListener('click', () => {
    checkFlowConnection();
    loadCapturedProtocolData();
  });

  btnSyncCatalog.addEventListener('click', async () => {
    btnSyncCatalog.disabled = true;
    btnSyncCatalog.textContent = '正在同步 HTrJv...';
    try {
      const res = await sendFlowCommand('FETCH_FLOW_CATALOG', {}, 20000);
      populateDiscoveredModels(res.discoveredImageModels, res.observedModels);
      await checkFlowConnection();
      btnSyncCatalog.textContent = `已同步 (${res.discoveredImageModels?.length || 0} 个模型)`;
    } catch (err) {
      alert(`同步模型目录失败: ${err.message}`);
      btnSyncCatalog.textContent = '同步模型目录';
    } finally {
      setTimeout(() => {
        btnSyncCatalog.disabled = false;
        btnSyncCatalog.textContent = '同步模型目录';
      }, 2000);
    }
  });

  btnOpenFlowTab.addEventListener('click', async () => {
    const tabs = await chrome.tabs.query({
      url: ['https://flow.google.com/*', 'https://labs.google/fx/*']
    });
    if (tabs.length > 0) {
      const target =
        tabs.find((t) => t.url && t.url.includes('flow.google.com/project/')) ||
        tabs.find((t) => t.url && t.url.includes('flow.google.com')) ||
        tabs[0];
      await chrome.tabs.update(target.id, { active: true });
      if (target.windowId) {
        await chrome.windows.update(target.windowId, { focused: true });
      }
    } else {
      await chrome.tabs.create({ url: 'https://flow.google.com/' });
    }
  });

  // Preset Prompt Buttons
  btnPresetEcommerce.addEventListener('click', () => {
    promptTextarea.value = DEFAULT_ECOMMERCE_PROMPT;
  });

  btnPresetUpres.addEventListener('click', () => {
    promptTextarea.value = UPRES_REALISM_PROMPT;
  });

  // Queue Control Buttons
  btnRunSample.addEventListener('click', () => {
    const count = Number(selectSampleCount.value) || 1;
    startQueueLoop({ sampleLimit: count });
  });

  btnStartQueue.addEventListener('click', () => {
    startQueueLoop({ sampleLimit: null });
  });

  btnPauseQueue.addEventListener('click', () => {
    if (appState.queueStatus === 'RUNNING') {
      appState.pauseRequested = true;
      queueLiveStepText.textContent = '已请求暂停：将在当前图片步骤完成后安全暂停...';
    }
  });

  btnResumeQueue.addEventListener('click', () => {
    startQueueLoop({ sampleLimit: null });
  });

  btnCancelQueue.addEventListener('click', async () => {
    appState.cancelRequested = true;
    appState.pauseRequested = false;
    appState.queueStatus = 'IDLE';
    for (let i = 0; i < appState.tasks.length; i++) {
      if (['UPLOADING', 'GENERATING', 'UPSCALING', 'SAVING'].includes(appState.tasks[i].status)) {
        appState.tasks[i].status = 'CANCELLED';
        await saveTaskToDb(appState.tasks[i], i);
      }
    }
    queueLiveStepText.textContent = '队列已取消。';
    renderTaskList();
  });

  btnRetryFailed.addEventListener('click', async () => {
    let count = 0;
    for (let i = 0; i < appState.tasks.length; i++) {
      if (appState.tasks[i].status === 'FAILED' || appState.tasks[i].status === 'CANCELLED') {
        appState.tasks[i].status = 'PENDING';
        appState.tasks[i].errorMsg = null;
        await saveTaskToDb(appState.tasks[i], i);
        count++;
      }
    }
    renderTaskList();
    if (count > 0) {
      startQueueLoop({ sampleLimit: null });
    } else {
      alert('当前没有失败或已取消的任务需要重试。');
    }
  });

  btnExportTaskLog.addEventListener('click', () => {
    const logReport = {
      exportedAt: new Date().toISOString(),
      projectId: appState.lastBridgeStatus?.projectId || appState.protocolSummary?.projectId || null,
      totalTasks: appState.tasks.length,
      completedTasks: appState.tasks.filter((t) => t.status === 'COMPLETED').length,
      failedTasks: appState.tasks.filter((t) => t.status === 'FAILED').length,
      tasks: appState.tasks.map((t, idx) => ({
        index: idx + 1,
        originalFileName: t.name,
        outputFileName: t.outputFileName,
        status: t.status,
        modelUsed: t.modelUsed || selectModel.value,
        resolutionUsed: t.resolutionUsed || selectResolution.value,
        aspectRatioEnum: t.aspectRatioUsed || Number(selectAspect.value),
        enhancedDimensions: t.enhancedDimensions || null,
        uploadedMediaId: t.uploadedMediaId,
        generatedMediaId: t.generatedMediaId,
        upscaledMediaId: t.upscaledMediaId,
        durationMs: t.durationMs,
        promptUsed: t.promptUsed || promptTextarea.value,
        errorMessage: t.errorMsg || null
      }))
    };
    openJsonModal('批量图生图任务执行记录报告 (JSON)', logReport);
  });

  // File & Directory Management Buttons
  btnPickInputDir.addEventListener('click', async () => {
    if (typeof window.showDirectoryPicker !== 'function') {
      fileInputFallback.click();
      return;
    }
    try {
      const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
      appState.inputDirHandle = dirHandle;
      await saveDirHandleToDb('inputDirHandle', dirHandle);
      const files = [];
      for await (const entry of dirHandle.values()) {
        if (entry.kind === 'file' && isSupportedImageFile(entry.name)) {
          const file = await entry.getFile();
          files.push(file);
        }
      }
      files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      await addFilesToTaskList(files);
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('Directory picker error:', err);
      }
    }
  });

  btnPickFiles.addEventListener('click', () => {
    fileInputFallback.click();
  });

  fileInputFallback.addEventListener('change', async (e) => {
    if (e.target.files?.length > 0) {
      const sortedFiles = Array.from(e.target.files).sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true })
      );
      await addFilesToTaskList(sortedFiles);
      fileInputFallback.value = '';
    }
  });

  // Drag & Drop support on the image receiving panel
  let dragEnterDepth = 0;
  const setDragHighlight = (active) => {
    if (imageDropZone) imageDropZone.classList.toggle('is-dragover', active);
    if (imageTaskList) imageTaskList.classList.toggle('is-dragover', active);
  };

  window.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  window.addEventListener('drop', (e) => {
    if (!imageDropZone || !imageDropZone.contains(e.target)) {
      e.preventDefault();
    }
  });

  if (imageDropZone) {
    imageDropZone.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragEnterDepth++;
      setDragHighlight(true);
    });

    imageDropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
      setDragHighlight(true);
    });

    imageDropZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragEnterDepth = Math.max(0, dragEnterDepth - 1);
      if (dragEnterDepth === 0) {
        setDragHighlight(false);
      }
    });

    imageDropZone.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragEnterDepth = 0;
      setDragHighlight(false);

      const droppedFiles = await extractFilesFromDataTransfer(e.dataTransfer);
      if (droppedFiles.length > 0) {
        const added = await addFilesToTaskList(droppedFiles);
        queueLiveStepText.textContent = `已通过拖拽导入 ${added} 张图片（共识别 ${droppedFiles.length} 张图片文件）。`;
      } else {
        queueLiveStepText.textContent = '拖拽内容中未检测到支持的图片文件（支持 JPG、JPEG、PNG、WebP）。';
      }
    });
  }

  // Clipboard Paste (Ctrl+V) support anywhere on the Workbench
  window.addEventListener('paste', async (e) => {
    const cb = e.clipboardData;
    if (!cb) return;

    const imageFiles = [];
    if (cb.items && cb.items.length > 0) {
      for (const item of Array.from(cb.items)) {
        if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (blob) {
            imageFiles.push(createNamedClipboardFile(blob));
          }
        }
      }
    }

    if (imageFiles.length === 0 && cb.files && cb.files.length > 0) {
      for (const f of Array.from(cb.files)) {
        if (isSupportedImageFile(f.name || '') || (f.type && f.type.startsWith('image/'))) {
          imageFiles.push(createNamedClipboardFile(f));
        }
      }
    }

    // If clipboard only contains text (e.g. user is pasting prompt into textarea), let normal paste proceed
    if (imageFiles.length === 0) return;

    e.preventDefault();
    const added = await addFilesToTaskList(imageFiles);
    if (added > 0) {
      queueLiveStepText.textContent = `已从剪贴板 (Ctrl+V) 导入 ${added} 张图片: ${imageFiles
        .map((f) => f.name)
        .join(', ')}`;
    }
  });

  // Toolbar "粘贴剪贴板 (Ctrl+V)" button via Async Clipboard API
  if (btnPasteClipboard) {
    btnPasteClipboard.addEventListener('click', async () => {
      if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
        alert('请直接按键盘 Ctrl+V 粘贴剪贴板中的图片。');
        return;
      }
      try {
        const clipboardItems = await navigator.clipboard.read();
        const filesToAdd = [];
        for (const item of clipboardItems) {
          const imageType = item.types.find((t) => t.startsWith('image/'));
          if (imageType) {
            const blob = await item.getType(imageType);
            if (blob) {
              filesToAdd.push(createNamedClipboardFile(blob));
            }
          }
        }
        if (filesToAdd.length > 0) {
          const added = await addFilesToTaskList(filesToAdd);
          queueLiveStepText.textContent = `已从剪贴板导入 ${added} 张图片: ${filesToAdd
            .map((f) => f.name)
            .join(', ')}`;
        } else {
          alert('当前剪贴板中没有检测到图片（请先复制图片或截图，再按 Ctrl+V 或点击此按钮）。');
        }
      } catch (err) {
        console.warn('Clipboard read error:', err);
        alert('请直接按键盘 Ctrl+V 粘贴剪贴板中的图片。');
      }
    });
  }

  btnPickOutputDir.addEventListener('click', async () => {
    if (typeof window.showDirectoryPicker !== 'function') {
      alert('当前浏览器不支持 showDirectoryPicker，将默认使用浏览器下载通道。');
      return;
    }
    try {
      const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      appState.outputDirHandle = dirHandle;
      await saveDirHandleToDb('outputDirHandle', dirHandle);
      updateDirStatusBanner();
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('Output directory picker error:', err);
      }
    }
  });

  btnClearCompleted.addEventListener('click', async () => {
    const remaining = [];
    for (const t of appState.tasks) {
      if (t.status === 'COMPLETED') {
        if (t.thumbUrl) URL.revokeObjectURL(t.thumbUrl);
        if (t.enhancedThumbUrl) URL.revokeObjectURL(t.enhancedThumbUrl);
        await deleteTaskFromDb(t.id);
      } else {
        remaining.push(t);
      }
    }
    appState.tasks = remaining;
    await saveAllTasksOrderToDb();
    renderTaskList();
    updateDirStatusBanner();
  });

  btnClearAllTasks.addEventListener('click', async () => {
    if (appState.queueStatus === 'RUNNING') {
      alert('请先暂停或取消正在运行的队列后再清空列表。');
      return;
    }
    for (const t of appState.tasks) {
      if (t.thumbUrl) URL.revokeObjectURL(t.thumbUrl);
      if (t.enhancedThumbUrl) URL.revokeObjectURL(t.enhancedThumbUrl);
    }
    appState.tasks = [];
    await clearAllTasksFromDb();
    renderTaskList();
    updateDirStatusBanner();
  });

  btnSaveConfig.addEventListener('click', async () => {
    await chrome.storage.local.set({
      userPrompt: promptTextarea.value,
      selectedModel: selectModel.value,
      selectedResolution: selectResolution.value,
      selectedAspect: selectAspect.value,
      selectedDelay: selectDelay.value,
      selectedMaxRetries: selectMaxRetries.value
    });
    configSavedHint.textContent = '配置已保存！';
    setTimeout(() => {
      configSavedHint.textContent = '';
    }, 2000);
  });

  btnClearPackets.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CLEAR_CAPTURED_PACKETS' });
    await loadCapturedProtocolData();
  });

  btnExportReport.addEventListener('click', async () => {
    const report = buildSanitizedProtocolReport();
    openJsonModal('Google Flow 脱敏协议诊断报告', report);
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      copyFeedback.textContent = '已自动复制到剪贴板！';
    } catch {
      copyFeedback.textContent = '请点击下方按钮复制';
    }
  });

  btnCopyDialogJson.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(dialogJsonPre.textContent);
      copyFeedback.textContent = '复制成功！';
    } catch (err) {
      copyFeedback.textContent = `复制失败: ${err.message}`;
    }
  });
}

initWorkbench();
