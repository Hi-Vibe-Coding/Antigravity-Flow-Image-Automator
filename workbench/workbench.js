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
const selectUiScale = document.getElementById('selectUiScale');
const connectionBadge = document.getElementById('connectionBadge');
const btnSyncCatalog = document.getElementById('btnSyncCatalog');
const btnRefreshConnection = document.getElementById('btnRefreshConnection');
const btnOpenFlowTab = document.getElementById('btnOpenFlowTab');

function applyUiScale(scaleMode) {
  let scaleRatio = 1.0;
  if (scaleMode === 'auto') {
    const sw = window.screen.width || window.innerWidth;
    const dpr = window.devicePixelRatio || 1;
    const effectiveWidth = sw * dpr;

    // Detect 4K (e.g. 3840x2160) or 2K (e.g. 2560x1440) high-res monitors
    if (effectiveWidth >= 3200 || sw >= 2560) {
      scaleRatio = 1.2;
    } else if (effectiveWidth >= 2200 || sw >= 1920) {
      scaleRatio = 1.08;
    } else {
      scaleRatio = 1.0;
    }
  } else {
    scaleRatio = Number(scaleMode) / 100 || 1.0;
  }

  document.documentElement.style.zoom = String(scaleRatio);
}

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
const btnOpenActionLog = document.getElementById('btnOpenActionLog');
const actionLogBadge = document.getElementById('actionLogBadge');
const queueTimerBox = document.getElementById('queueTimerBox');
const queueTimerText = document.getElementById('queueTimerText');

const selectSampleCount = document.getElementById('selectSampleCount');
const btnRunSample = document.getElementById('btnRunSample');
const btnStartQueue = document.getElementById('btnStartQueue');
const btnPauseQueue = document.getElementById('btnPauseQueue');
const btnResumeQueue = document.getElementById('btnResumeQueue');
const btnCancelQueue = document.getElementById('btnCancelQueue');
const btnRetryFailed = document.getElementById('btnRetryFailed');
const btnExportTaskLog = document.getElementById('btnExportTaskLog');

const imageDropZone = document.getElementById('imageDropZone');
const selectImportMode = document.getElementById('selectImportMode');
const btnPickInputDir = document.getElementById('btnPickInputDir');
const btnPickFiles = document.getElementById('btnPickFiles');
const btnPasteClipboard = document.getElementById('btnPasteClipboard');
const btnPickOutputDir = document.getElementById('btnPickOutputDir');
const btnClearCompleted = document.getElementById('btnClearCompleted');
const btnClearAllTasks = document.getElementById('btnClearAllTasks');
const chkOverwriteOriginal = document.getElementById('chkOverwriteOriginal');
const chkNumericNameOnly = document.getElementById('chkNumericNameOnly');
const fileInputFallback = document.getElementById('fileInputFallback');
const dirStatusText = document.getElementById('dirStatusText');

const folderStagingArea = document.getElementById('folderStagingArea');
const folderEmptyPrompt = document.getElementById('folderEmptyPrompt');
const folderCardsContainer = document.getElementById('folderCardsContainer');
const scanProgressWrap = document.getElementById('scanProgressWrap');
const scanProgressText = document.getElementById('scanProgressText');
const scanProgressPct = document.getElementById('scanProgressPct');
const scanProgressBar = document.getElementById('scanProgressBar');
const stagedFolderCountHint = document.getElementById('stagedFolderCountHint');
const btnConfirmScanFolders = document.getElementById('btnConfirmScanFolders');

const imageTaskList = document.getElementById('imageTaskList');

let stagedFolders = []; // Array of { id, name, handle, entry }

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
const origImgWrap = document.getElementById('origImgWrap');
const enhancedImgWrap = document.getElementById('enhancedImgWrap');
const btnResetOrigZoom = document.getElementById('btnResetOrigZoom');
const btnResetEnhancedZoom = document.getElementById('btnResetEnhancedZoom');
const chkSyncFromOrig = document.getElementById('chkSyncFromOrig');
const chkSyncFromEnhanced = document.getElementById('chkSyncFromEnhanced');
const previewOrigImg = document.getElementById('previewOrigImg');
const previewEnhancedImg = document.getElementById('previewEnhancedImg');

const reportDialog = document.getElementById('reportDialog');
const reportDialogTitle = document.getElementById('reportDialogTitle');
const dialogJsonPre = document.getElementById('dialogJsonPre');
const btnCopyDialogJson = document.getElementById('btnCopyDialogJson');
const copyFeedback = document.getElementById('copyFeedback');

const completionDialog = document.getElementById('completionDialog');
const completionMainText = document.getElementById('completionMainText');
const completionTotalTime = document.getElementById('completionTotalTime');
const completionAvgTime = document.getElementById('completionAvgTime');

const actionLogDialog = document.getElementById('actionLogDialog');
const actionLogTotalCount = document.getElementById('actionLogTotalCount');
const actionLogList = document.getElementById('actionLogList');
const btnCopyActionLog = document.getElementById('btnCopyActionLog');
const btnClearActionLog = document.getElementById('btnClearActionLog');
const actionLogFeedback = document.getElementById('actionLogFeedback');

// Mandatory fallback for browsers without <dialog closedby="any"> support
for (const dlg of [reportDialog, previewDialog, completionDialog, actionLogDialog]) {
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

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Formats milliseconds into Chinese duration string, e.g.:
 * - 1小时15分19秒
 * - 45分19秒
 * - 49秒
 */
function formatDurationChinese(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}小时${minutes}分${seconds}秒`;
  }
  if (minutes > 0) {
    return `${minutes}分${seconds}秒`;
  }
  return `${seconds}秒`;
}

// ============================================================================
// 0. ACTION AUDIT LOG SYSTEM & QUEUE TIMER
// ============================================================================

let actionLogs = [];
let actionLogSaveTimer = null;

const CATEGORY_NAMES = {
  IMPORT: '导入',
  SCAN: '扫描',
  QUEUE: '队列',
  PROCESS: '处理',
  COMPLETE: '完成',
  ERROR: '失败',
  CLEAR: '清空'
};

function formatActionTimestamp(dateOrTs) {
  const d = dateOrTs instanceof Date ? dateOrTs : new Date(dateOrTs || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  return `${year}年${month}月${day}日 ${hours}:${minutes}:${seconds}`;
}

function logAction(category, title, detail = '') {
  const now = new Date();
  const timeStr = formatActionTimestamp(now);
  const entry = {
    id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    timeStr,
    category,
    title,
    detail
  };
  actionLogs.unshift(entry);
  if (actionLogs.length > 300) {
    actionLogs.length = 300;
  }
  renderActionLogBadge();
  if (actionLogDialog && actionLogDialog.open) {
    renderActionLogList();
  }
  scheduleSaveActionLogs();
}

function scheduleSaveActionLogs() {
  if (actionLogSaveTimer) return;
  actionLogSaveTimer = setTimeout(async () => {
    actionLogSaveTimer = null;
    await flushActionLogsToDisk();
  }, 200);
}

async function flushActionLogsToDisk() {
  if (actionLogSaveTimer) {
    clearTimeout(actionLogSaveTimer);
    actionLogSaveTimer = null;
  }
  try {
    await chrome.storage.local.set({ actionLogs: actionLogs.slice(0, 200) });
  } catch (err) {
    console.warn('Failed to save actionLogs to disk:', err);
  }
}

window.addEventListener('beforeunload', () => {
  flushActionLogsToDisk();
});
window.addEventListener('pagehide', () => {
  flushActionLogsToDisk();
});

function renderActionLogBadge() {
  if (actionLogBadge) {
    actionLogBadge.textContent = String(actionLogs.length);
  }
  if (actionLogTotalCount) {
    actionLogTotalCount.textContent = `共 ${actionLogs.length} 条关键操作记录`;
  }
}

function renderActionLogList() {
  if (!actionLogList) return;
  if (actionLogs.length === 0) {
    actionLogList.innerHTML = '<div class="action-log-empty">暂无任何关键操作记录</div>';
    return;
  }
  actionLogList.innerHTML = actionLogs
    .map((item) => {
      const catClass = `cat-${item.category}`;
      const catName = CATEGORY_NAMES[item.category] || item.category;
      const displayTime = item.timestamp
        ? formatActionTimestamp(item.timestamp)
        : item.timeStr || '';
      return `
        <div class="action-log-item">
          <span class="action-log-time">[${escapeHtml(displayTime)}]</span>
          <span class="action-log-pill ${catClass}">【${escapeHtml(catName)}】</span>
          <strong class="action-log-title">${escapeHtml(item.title)}</strong>
          <span class="action-log-detail">${escapeHtml(item.detail)}</span>
        </div>
      `;
    })
    .join('');
}

// Queue Timer
let queueTimerInterval = null;
let queueTimerStartedAt = 0;
let queueTimerAccumulatedMs = 0;

function startQueueTimer() {
  stopQueueTimer();
  queueTimerStartedAt = Date.now();
  queueTimerAccumulatedMs = 0;
  if (queueTimerBox) {
    queueTimerBox.classList.remove('is-paused');
    queueTimerBox.classList.add('is-running');
  }
  updateQueueTimerDisplay();
  queueTimerInterval = setInterval(updateQueueTimerDisplay, 1000);
}

function pauseQueueTimer() {
  if (queueTimerInterval) {
    clearInterval(queueTimerInterval);
    queueTimerInterval = null;
  }
  if (queueTimerStartedAt > 0) {
    queueTimerAccumulatedMs += Date.now() - queueTimerStartedAt;
    queueTimerStartedAt = 0;
  }
  if (queueTimerBox) {
    queueTimerBox.classList.remove('is-running');
    queueTimerBox.classList.add('is-paused');
  }
  if (queueTimerText) {
    queueTimerText.textContent = `任务已进行 ${formatDurationChinese(queueTimerAccumulatedMs)} (已暂停)`;
  }
}

function resumeQueueTimer() {
  queueTimerStartedAt = Date.now();
  if (queueTimerBox) {
    queueTimerBox.classList.remove('is-paused');
    queueTimerBox.classList.add('is-running');
  }
  updateQueueTimerDisplay();
  if (!queueTimerInterval) {
    queueTimerInterval = setInterval(updateQueueTimerDisplay, 1000);
  }
}

function stopQueueTimer(finalDurationMs = null) {
  if (queueTimerInterval) {
    clearInterval(queueTimerInterval);
    queueTimerInterval = null;
  }
  const totalMs =
    finalDurationMs !== null
      ? finalDurationMs
      : queueTimerAccumulatedMs +
        (queueTimerStartedAt > 0 ? Date.now() - queueTimerStartedAt : 0);

  if (queueTimerBox) {
    queueTimerBox.classList.remove('is-running', 'is-paused');
  }
  if (queueTimerText) {
    if (totalMs > 0) {
      queueTimerText.textContent = `任务已进行 ${formatDurationChinese(totalMs)}`;
    } else {
      queueTimerText.textContent = '任务等待启动';
    }
  }
  queueTimerStartedAt = 0;
  queueTimerAccumulatedMs = 0;
}

function updateQueueTimerDisplay() {
  if (!queueTimerText) return;
  const currentRunningMs = queueTimerStartedAt > 0 ? Date.now() - queueTimerStartedAt : 0;
  const totalElapsedMs = queueTimerAccumulatedMs + currentRunningMs;
  queueTimerText.textContent = `任务已进行 ${formatDurationChinese(totalElapsedMs)}`;
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
      if (rec.key === 'inputDirHandle' && rec.handle) {
        appState.inputDirHandle = rec.handle;
      }
    }
  } catch (err) {
    console.warn('[Workbench IDB] Failed to restore directory handles:', err);
  }
}

async function ensureDirReadWritePermission(dirHandle) {
  if (!dirHandle) return false;
  try {
    if (typeof dirHandle.queryPermission === 'function') {
      let perm = await dirHandle.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') return true;
      if (typeof dirHandle.requestPermission === 'function') {
        perm = await dirHandle.requestPermission({ mode: 'readwrite' });
        return perm === 'granted';
      }
    }
    return true;
  } catch (err) {
    console.warn('[Workbench Save] Directory readwrite permission check failed:', err);
    return false;
  }
}

async function ensureOutputDirPermission() {
  const handlesToVerify = new Set();
  if (appState.inputDirHandle) handlesToVerify.add(appState.inputDirHandle);
  for (const t of appState.tasks) {
    if (t.status === 'PENDING' && t.sourceDirHandle) {
      handlesToVerify.add(t.sourceDirHandle);
    }
  }
  if (appState.outputDirHandle) handlesToVerify.add(appState.outputDirHandle);

  for (const h of handlesToVerify) {
    await ensureDirReadWritePermission(h);
  }
  return true;
}

async function saveTaskToDb(task, orderIndex = 0) {
  try {
    const db = await openTaskDb();
    const record = {
      id: task.id,
      orderIndex,
      name: task.name,
      relativePath: task.relativePath || task.name,
      size: task.size,
      mimeType: task.mimeType || 'image/png',
      status: task.status,
      sourceBlob: task.sourceBlob || null,
      sourceDirHandle: task.sourceDirHandle || null,
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

function isOverwriteModeEnabled() {
  return chkOverwriteOriginal ? Boolean(chkOverwriteOriginal.checked) : true;
}

function isNumericFilterEnabled() {
  return chkNumericNameOnly ? Boolean(chkNumericNameOnly.checked) : true;
}

function isPureNumericImageName(filename) {
  const base = String(filename || '')
    .trim()
    .replace(/\.[^.]+$/, '');
  return /^\d+$/.test(base);
}

function buildOutputFileName(origName, resolution = '2K', mimeType = 'image/jpeg', overwriteOverride = null) {
  const base = origName.replace(/\.[^.]+$/, '');
  const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  const useOverwrite = overwriteOverride !== null ? overwriteOverride : isOverwriteModeEnabled();
  if (useOverwrite) {
    return `${base}.${ext}`;
  }
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
  if (!dataTransfer) return { files: [], dirHandle: null };

  // 1. Synchronously snapshot standard files and items before ANY await causes Chromium to detach the DataTransfer
  const directFiles = dataTransfer.files ? Array.from(dataTransfer.files) : [];
  const rawItems = dataTransfer.items ? Array.from(dataTransfer.items) : [];

  // 2. Synchronously inspect webkitGetAsEntry() before the event loop yields
  const entryPairs = [];
  for (const item of rawItems) {
    if (item.kind === 'file') {
      let entry = null;
      try {
        if (typeof item.webkitGetAsEntry === 'function') {
          entry = item.webkitGetAsEntry();
        }
      } catch {
        entry = null;
      }
      entryPairs.push({ item, entry });
    }
  }

  const hasAnyDirectory = entryPairs.some((p) => p.entry && p.entry.isDirectory);

  // 3. Fast Path: If no directories were dropped and directFiles contains images, return them immediately
  if (!hasAnyDirectory && directFiles.length > 0) {
    const supported = directFiles.filter(
      (f) => isSupportedImageFile(f.name) || (f.type && f.type.startsWith('image/'))
    );
    if (supported.length > 0) {
      return {
        files: supported.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
        dirHandle: null
      };
    }
  }

  // 4. If a directory was dropped, try modern File System Access API first to preserve directory handles
  let droppedDirHandle = null;
  for (const { item, entry } of entryPairs) {
    if (entry && entry.isDirectory && typeof item.getAsFileSystemHandle === 'function') {
      try {
        const handle = await item.getAsFileSystemHandle();
        if (handle && handle.kind === 'directory') {
          droppedDirHandle = handle;
          break;
        }
      } catch {
        // Ignore
      }
    }
  }

  if (droppedDirHandle) {
    return { files: [], dirHandle: droppedDirHandle };
  }

  // 5. Fallback traversal for directories (or mixed drops) using webkitGetAsEntry
  const collected = [];
  async function readEntry(entry) {
    if (!entry) return;
    if (entry.isFile) {
      try {
        const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
        if (file && (isSupportedImageFile(file.name) || (file.type && file.type.startsWith('image/')))) {
          collected.push(file);
        }
      } catch {
        // Ignore
      }
    } else if (entry.isDirectory) {
      try {
        const reader = entry.createReader();
        const readBatch = async () => {
          const batch = await new Promise((resolve) =>
            reader.readEntries(resolve, () => resolve([]))
          );
          if (batch && batch.length > 0) {
            for (const sub of batch) {
              await readEntry(sub);
            }
            await readBatch();
          }
        };
        await readBatch();
      } catch {
        // Ignore
      }
    }
  }

  for (const { entry } of entryPairs) {
    if (entry) {
      await readEntry(entry);
    }
  }

  if (collected.length > 0) {
    const seen = new Set();
    const unique = [];
    for (const f of collected) {
      const key = `${f.name}_${f.size}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(f);
      }
    }
    return {
      files: unique.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
      dirHandle: null
    };
  }

  // 6. Final safety net: filter directFiles
  const fallbackFiles = directFiles.filter(
    (f) => isSupportedImageFile(f.name) || (f.type && f.type.startsWith('image/'))
  );
  return {
    files: fallbackFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    dirHandle: null
  };
}

async function extractFoldersFromDataTransfer(dataTransfer) {
  if (!dataTransfer) return [];
  const rawItems = dataTransfer.items ? Array.from(dataTransfer.items) : [];
  const entryPairs = [];
  for (const item of rawItems) {
    if (item.kind === 'file') {
      let entry = null;
      try {
        if (typeof item.webkitGetAsEntry === 'function') {
          entry = item.webkitGetAsEntry();
        }
      } catch {
        entry = null;
      }
      entryPairs.push({ item, entry });
    }
  }

  const folderEntries = entryPairs.filter((p) => p.entry && p.entry.isDirectory);
  const results = [];

  for (const { item, entry } of folderEntries) {
    let handle = null;
    if (typeof item.getAsFileSystemHandle === 'function') {
      try {
        const h = await item.getAsFileSystemHandle();
        if (h && h.kind === 'directory') {
          handle = h;
        }
      } catch {
        // Ignore
      }
    }
    results.push({
      id: `folder_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: (handle && handle.name) || (entry && entry.name) || '未命名文件夹',
      handle,
      entry
    });
  }

  return results;
}

async function scanDirectoryHandleForImages(rootDirHandle, onProgress = null) {
  const results = [];
  async function walkDir(currentDirHandle, relPrefix = '') {
    const entries = [];
    for await (const entry of currentDirHandle.values()) {
      entries.push(entry);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const entry of entries) {
      if (entry.kind === 'file' && isSupportedImageFile(entry.name)) {
        const file = await entry.getFile();
        results.push({
          file,
          dirHandle: currentDirHandle,
          relativePath: relPrefix ? `${relPrefix}/${entry.name}` : entry.name
        });
        if (typeof onProgress === 'function') {
          onProgress(results.length, entry.name);
        }
      } else if (entry.kind === 'directory') {
        await walkDir(entry, relPrefix ? `${relPrefix}/${entry.name}` : entry.name);
      }
    }
  }
  await walkDir(rootDirHandle, '');
  return results;
}

async function scanDirectoryEntryForImages(dirEntry, onProgress = null) {
  const results = [];
  async function walk(entry, relPrefix = '') {
    if (entry.isFile) {
      if (isSupportedImageFile(entry.name)) {
        const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
        if (file) {
          results.push({
            file,
            dirHandle: null,
            relativePath: relPrefix ? `${relPrefix}/${entry.name}` : entry.name
          });
          if (typeof onProgress === 'function') {
            onProgress(results.length, entry.name);
          }
        }
      }
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const readBatch = async () => {
        const batch = await new Promise((resolve) =>
          reader.readEntries(resolve, () => resolve([]))
        );
        if (batch && batch.length > 0) {
          for (const sub of batch) {
            await walk(sub, relPrefix ? `${relPrefix}/${sub.name}` : sub.name);
          }
          await readBatch();
        }
      };
      await readBatch();
    }
  }
  await walk(dirEntry, '');
  return results;
}

function renderFolderStagingUI() {
  if (!folderStagingArea) return;
  if (stagedFolders.length === 0) {
    if (folderEmptyPrompt) folderEmptyPrompt.hidden = false;
    if (folderCardsContainer) {
      folderCardsContainer.hidden = true;
      folderCardsContainer.innerHTML = '';
    }
    if (stagedFolderCountHint) stagedFolderCountHint.textContent = '尚未添加待扫描的文件夹';
    if (btnConfirmScanFolders) {
      btnConfirmScanFolders.disabled = true;
      btnConfirmScanFolders.textContent = '确定扫描';
    }
  } else {
    if (folderEmptyPrompt) folderEmptyPrompt.hidden = true;
    if (folderCardsContainer) {
      folderCardsContainer.hidden = false;
      folderCardsContainer.innerHTML = '';
      stagedFolders.forEach((f, idx) => {
        const card = document.createElement('div');
        card.className = 'folder-card';
        card.innerHTML = `
          <div class="folder-card-icon">📁</div>
          <div class="folder-card-info">
            <div class="folder-card-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
            <div class="folder-card-badge">待扫描文件夹 #${idx + 1}</div>
          </div>
          <button type="button" class="folder-card-remove" title="移除此文件夹" data-id="${f.id}">✕</button>
        `;
        const btnRemove = card.querySelector('.folder-card-remove');
        if (btnRemove) {
          btnRemove.addEventListener('click', (e) => {
            e.stopPropagation();
            stagedFolders = stagedFolders.filter((item) => item.id !== f.id);
            renderFolderStagingUI();
            updateDirStatusBanner();
          });
        }
        folderCardsContainer.appendChild(card);
      });
    }
    if (stagedFolderCountHint) {
      stagedFolderCountHint.textContent = `已添加 ${stagedFolders.length} 个待扫描文件夹`;
    }
    if (btnConfirmScanFolders) {
      btnConfirmScanFolders.disabled = false;
      btnConfirmScanFolders.textContent = `确定扫描 (${stagedFolders.length} 个文件夹)`;
    }
  }
}

function stageFolder(folderObj) {
  if (!folderObj || !folderObj.name) return;
  if (stagedFolders.some((f) => f.name === folderObj.name)) {
    alert(`文件夹 [${folderObj.name}] 已在待扫描列表中。`);
    return;
  }
  stagedFolders.push(folderObj);
  renderFolderStagingUI();
  updateDirStatusBanner();
  queueLiveStepText.textContent = `已添加待扫描文件夹: [${folderObj.name}]（当前共 ${stagedFolders.length} 个文件夹待扫描）。请点击右下角“确定扫描”开始解析图片。`;
  logAction(
    'IMPORT',
    '添加待扫描文件夹',
    `已添加 [${folderObj.name}]（当前共 ${stagedFolders.length} 个文件夹待扫描）`
  );
}

async function executeScanStagedFolders() {
  if (stagedFolders.length === 0) return;
  if (btnConfirmScanFolders) btnConfirmScanFolders.disabled = true;
  if (scanProgressWrap) scanProgressWrap.hidden = false;
  if (scanProgressBar) scanProgressBar.style.width = '0%';
  if (scanProgressPct) scanProgressPct.textContent = '0%';
  if (scanProgressText) scanProgressText.textContent = `准备开始扫描 ${stagedFolders.length} 个文件夹...`;
  logAction(
    'SCAN',
    '开始扫描文件夹',
    `开始扫描 ${stagedFolders.length} 个文件夹: ${stagedFolders.map((f) => f.name).join(', ')}`
  );

  const totalFolders = stagedFolders.length;
  let allScannedItems = [];
  let processedFolders = 0;

  for (let i = 0; i < totalFolders; i++) {
    const f = stagedFolders[i];
    const basePct = Math.round((i / totalFolders) * 100);
    if (scanProgressBar) scanProgressBar.style.width = `${basePct}%`;
    if (scanProgressPct) scanProgressPct.textContent = `${basePct}%`;
    if (scanProgressText) {
      scanProgressText.textContent = `[${i + 1}/${totalFolders}] 正在扫描文件夹: ${f.name} (已累计发现 ${allScannedItems.length} 张图片)...`;
    }

    const onProgress = (currentFolderCount, currentFileName) => {
      if (scanProgressText) {
        scanProgressText.textContent = `[${i + 1}/${totalFolders}] 正在扫描: ${f.name}/${currentFileName} (发现 ${allScannedItems.length + currentFolderCount} 张)...`;
      }
    };

    try {
      if (f.handle) {
        if (!appState.inputDirHandle) {
          appState.inputDirHandle = f.handle;
          await saveDirHandleToDb('inputDirHandle', f.handle);
        }
        const scanned = await scanDirectoryHandleForImages(f.handle, onProgress);
        allScannedItems.push(...scanned);
      } else if (f.entry) {
        const scanned = await scanDirectoryEntryForImages(f.entry, onProgress);
        allScannedItems.push(...scanned);
      }
    } catch (err) {
      console.warn(`扫描文件夹 [${f.name}] 出错:`, err);
    }
    processedFolders++;
  }

  if (scanProgressBar) scanProgressBar.style.width = '100%';
  if (scanProgressPct) scanProgressPct.textContent = '100%';
  if (scanProgressText) {
    scanProgressText.textContent = `扫描完成！共在 ${processedFolders} 个文件夹中发现 ${allScannedItems.length} 张图片，正在导入任务队列...`;
  }

  await sleepMs(300);

  if (allScannedItems.length === 0) {
    alert('在所选文件夹中未找到任何符合条件的商品图片（支持 JPG、JPEG、PNG、WebP）。');
    if (scanProgressWrap) scanProgressWrap.hidden = true;
    if (btnConfirmScanFolders) btnConfirmScanFolders.disabled = false;
    return;
  }

  const added = await addFilesToTaskList(allScannedItems, null, { suppressLog: true });
  appState.tasksScanned = true;
  stagedFolders = [];
  if (scanProgressWrap) scanProgressWrap.hidden = true;

  renderImportModeUI();
  queueLiveStepText.textContent = `已通过扫描 ${totalFolders} 个文件夹总共导入 ${allScannedItems.length} 张图，识别有效图片 ${added} 张`;
  logAction(
    'SCAN',
    '完成文件夹扫描',
    `共在 ${totalFolders} 个文件夹中扫描出 ${allScannedItems.length} 张图片，成功识别有效图片 ${added} 张`
  );
}

function renderImportModeUI() {
  const isFolderMode = selectImportMode ? selectImportMode.value === 'FOLDER' : true;
  appState.importMode = isFolderMode ? 'FOLDER' : 'IMAGES';

  // Toggle toolbar buttons
  if (btnPickInputDir) btnPickInputDir.hidden = !isFolderMode;
  if (btnPickFiles) btnPickFiles.hidden = isFolderMode;

  const hasTasks = appState.tasks.length > 0;

  if (hasTasks) {
    // LOCK STATE:
    // Once tasks are loaded (from folder scan or direct image import), lock the mode & disable adding more
    if (selectImportMode) selectImportMode.disabled = true;
    if (btnPickInputDir) btnPickInputDir.disabled = true;
    if (btnPickFiles) btnPickFiles.disabled = true;
    if (folderStagingArea) folderStagingArea.hidden = true;
    if (imageTaskList) imageTaskList.hidden = false;
  } else {
    // UNLOCKED STATE:
    if (selectImportMode) selectImportMode.disabled = false;
    if (btnPickInputDir) btnPickInputDir.disabled = false;
    if (btnPickFiles) btnPickFiles.disabled = false;

    if (isFolderMode) {
      if (folderStagingArea) folderStagingArea.hidden = false;
      if (imageTaskList) imageTaskList.hidden = true;
      renderFolderStagingUI();
    } else {
      if (folderStagingArea) folderStagingArea.hidden = true;
      if (imageTaskList) imageTaskList.hidden = false;
    }
  }

  updateDirStatusBanner();
}

async function addFilesToTaskList(fileList, defaultSourceDirHandle = null, options = {}) {
  let addedCount = 0;
  const enforceNumeric = isNumericFilterEnabled() && !options.skipNumericFilter;

  for (const item of fileList) {
    const rawFile = item && item.file instanceof File ? item.file : item;
    const itemDirHandle = (item && item.dirHandle) || defaultSourceDirHandle || null;
    const relativePath = (item && item.relativePath) || rawFile.name || '';

    const hasValidExt = isSupportedImageFile(rawFile.name || '');
    const isImageMime = Boolean(rawFile.type && rawFile.type.startsWith('image/'));
    if (!hasValidExt && !isImageMime) continue;

    const file = hasValidExt ? rawFile : createNamedClipboardFile(rawFile);
    if (enforceNumeric && !isPureNumericImageName(file.name)) {
      continue;
    }

    const exists = appState.tasks.some(
      (t) => (t.relativePath || t.name) === (relativePath || file.name) && t.size === file.size
    );
    if (exists) continue;

    const sourceBlob = new Blob([await file.arrayBuffer()], {
      type: inferMimeType(file.name, file.type)
    });
    const thumbUrl = URL.createObjectURL(sourceBlob);
    const newTask = {
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: file.name,
      relativePath: relativePath || file.name,
      size: file.size,
      mimeType: sourceBlob.type,
      sourceBlob,
      sourceDirHandle: itemDirHandle,
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
  renderImportModeUI();
  if (addedCount > 0 && !options.suppressLog) {
    logAction('IMPORT', '导入图片', `成功添加 ${addedCount} 张有效图片至任务队列`);
  }
  return addedCount;
}

function updateDirStatusBanner() {
  const hasFolderHandle =
    Boolean(appState.inputDirHandle) || appState.tasks.some((t) => Boolean(t.sourceDirHandle));
  let inName;
  if (appState.tasks.length > 0) {
    const modeLabel = appState.importMode === 'FOLDER' ? '文件夹扫描' : '直接图片';
    inName = `已通过${modeLabel}导入 ${appState.tasks.length} 张图片（已锁定新增导入，如需重新导入请点击“清空列表”）`;
  } else if (selectImportMode && selectImportMode.value === 'FOLDER') {
    inName = stagedFolders.length > 0
      ? `待扫描文件夹：已添加 ${stagedFolders.length} 个文件夹（点击右下角“确定扫描”开始解析图片）`
      : '未选择文件夹（可拖拽或点击“选择文件夹”，添加后点击右下角“确定扫描”）';
  } else {
    inName = '未选择图片（可拖拽图片到列表或按 Ctrl+V 粘贴）';
  }

  let outName;
  if (hasFolderHandle) {
    outName = isOverwriteModeEnabled()
      ? '在原图文件夹内直接覆盖原图（如 1.png → 写入 1.jpg 并删除 1.png；1.jpg → 直接覆盖 1.jpg）'
      : `保留原图，在原图文件夹同路径输出（如 1_enhanced_${selectResolution.value || '2K'}.jpg）`;
  } else {
    outName = '单图导入（未绑定原图文件夹时将保存至系统下载目录 Flow_Enhanced/ 子目录）';
  }
  dirStatusText.textContent = `原图来源：${inName} | 输出方式：${outName}`;
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
    nameEl.textContent = `${index + 1}. ${task.relativePath || task.name}`;

    const subEl = document.createElement('div');
    subEl.className = 'task-sub';

    const stBadge = document.createElement('span');
    stBadge.className = `task-status-badge st-${task.status}`;
    stBadge.textContent = STATUS_LABELS[task.status] || task.status;
    subEl.appendChild(stBadge);

    const sizeKb = (task.size / 1024).toFixed(1);
    const outName = buildOutputFileName(task.name, selectResolution.value, 'image/jpeg');
    let overwriteDesc;
    if (isOverwriteModeEnabled()) {
      overwriteDesc =
        task.name.toLowerCase() !== outName.toLowerCase()
          ? `替换为: ${outName} (删除 ${task.name})`
          : `直接覆盖: ${outName}`;
    } else {
      overwriteDesc = `保留原图，同路径输出: ${outName}`;
    }
    let detailStr = `${sizeKb} KB | ${overwriteDesc}`;
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

function createIndependentZoomController(wrapEl, imgEl, resetBtnEl, onUserTransformChange) {
  const state = {
    scale: 1,
    tx: 0,
    ty: 0,
    isPanning: false,
    startX: 0,
    startY: 0,
    startTx: 0,
    startTy: 0
  };

  function getRenderedImageBox() {
    if (!wrapEl || !imgEl) return { width: 1, height: 1 };
    const cw = wrapEl.clientWidth || 1;
    const ch = wrapEl.clientHeight || 1;
    const nw = imgEl.naturalWidth || cw;
    const nh = imgEl.naturalHeight || ch;
    const containerRatio = cw / ch;
    const imgRatio = nw / nh;
    if (imgRatio > containerRatio) {
      return { width: cw, height: cw / imgRatio };
    }
    return { width: ch * imgRatio, height: ch };
  }

  function applyTransform(notifyPeer = false) {
    if (!imgEl) return;
    // Use individual CSS transform properties (`translate` and `scale`)
    imgEl.style.translate = `${state.tx}px ${state.ty}px`;
    imgEl.style.scale = String(state.scale);
    if (wrapEl) {
      wrapEl.classList.toggle('is-zoomed', state.scale > 1.01);
    }
    if (resetBtnEl) {
      const pct = Math.round(state.scale * 100);
      resetBtnEl.textContent = pct === 100 ? '100% 重置' : `${pct}% · 重置 100%`;
    }
    if (notifyPeer && typeof onUserTransformChange === 'function') {
      onUserTransformChange(getViewportState());
    }
  }

  function resetZoom(notifyPeer = false) {
    state.scale = 1;
    state.tx = 0;
    state.ty = 0;
    state.isPanning = false;
    if (wrapEl) wrapEl.classList.remove('is-panning', 'is-zoomed');
    applyTransform(notifyPeer);
  }

  function getViewportState() {
    const box = getRenderedImageBox();
    return {
      scale: state.scale,
      normTx: state.tx / (box.width || 1),
      normTy: state.ty / (box.height || 1)
    };
  }

  function syncToViewportState(sourceView) {
    if (!sourceView) return;
    const box = getRenderedImageBox();
    state.scale = sourceView.scale;
    state.tx = Number((sourceView.normTx * (box.width || 1)).toFixed(2));
    state.ty = Number((sourceView.normTy * (box.height || 1)).toFixed(2));
    state.isPanning = false;
    if (wrapEl) wrapEl.classList.remove('is-panning');
    applyTransform(false);
  }

  if (wrapEl) {
    wrapEl.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        e.stopPropagation();

        const rect = wrapEl.getBoundingClientRect();
        const cursorX = e.clientX - (rect.left + rect.width / 2);
        const cursorY = e.clientY - (rect.top + rect.height / 2);

        const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const nextScale = Math.min(8, Math.max(0.5, Number((state.scale * zoomFactor).toFixed(3))));
        if (nextScale === state.scale) return;

        if (Math.abs(nextScale - 1) < 0.04) {
          resetZoom(true);
          return;
        }

        const ratio = nextScale / state.scale;
        state.tx = cursorX - (cursorX - state.tx) * ratio;
        state.ty = cursorY - (cursorY - state.ty) * ratio;
        state.scale = nextScale;
        applyTransform(true);
      },
      { passive: false }
    );

    wrapEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target && e.target.closest('.zoom-toolbar'))) return;
      state.isPanning = true;
      state.startX = e.clientX;
      state.startY = e.clientY;
      state.startTx = state.tx;
      state.startTy = state.ty;
      wrapEl.classList.add('is-panning');
      try {
        wrapEl.setPointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
    });

    wrapEl.addEventListener('pointermove', (e) => {
      if (!state.isPanning) return;
      state.tx = state.startTx + (e.clientX - state.startX);
      state.ty = state.startTy + (e.clientY - state.startY);
      applyTransform(true);
    });

    const endPan = (e) => {
      if (!state.isPanning) return;
      state.isPanning = false;
      wrapEl.classList.remove('is-panning');
      try {
        wrapEl.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
    };

    wrapEl.addEventListener('pointerup', endPan);
    wrapEl.addEventListener('pointercancel', endPan);
  }

  if (resetBtnEl) {
    resetBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      resetZoom(true);
    });
  }

  return { resetZoom, getViewportState, syncToViewportState };
}

let origZoomCtrl = null;
let enhancedZoomCtrl = null;

origZoomCtrl = createIndependentZoomController(
  origImgWrap,
  previewOrigImg,
  btnResetOrigZoom,
  (viewState) => {
    if (chkSyncFromOrig && chkSyncFromOrig.checked && enhancedZoomCtrl) {
      enhancedZoomCtrl.syncToViewportState(viewState);
    }
  }
);

enhancedZoomCtrl = createIndependentZoomController(
  enhancedImgWrap,
  previewEnhancedImg,
  btnResetEnhancedZoom,
  (viewState) => {
    if (chkSyncFromEnhanced && chkSyncFromEnhanced.checked && origZoomCtrl) {
      origZoomCtrl.syncToViewportState(viewState);
    }
  }
);

if (chkSyncFromOrig) {
  chkSyncFromOrig.addEventListener('change', () => {
    if (chkSyncFromOrig.checked) {
      enhancedZoomCtrl.syncToViewportState(origZoomCtrl.getViewportState());
    }
  });
}

if (chkSyncFromEnhanced) {
  chkSyncFromEnhanced.addEventListener('change', () => {
    if (chkSyncFromEnhanced.checked) {
      origZoomCtrl.syncToViewportState(enhancedZoomCtrl.getViewportState());
    }
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
  if (chkSyncFromOrig) chkSyncFromOrig.checked = true;
  if (chkSyncFromEnhanced) chkSyncFromEnhanced.checked = true;
  origZoomCtrl.resetZoom();
  enhancedZoomCtrl.resetZoom();
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

async function saveEnhancedBlobToDisk(blob, outputFileName, task = null) {
  // 1. Prefer overwriting in the original image's source folder (or user-selected directory)
  const targetDirHandle =
    task?.sourceDirHandle || appState.inputDirHandle || appState.outputDirHandle;

  if (targetDirHandle) {
    try {
      const hasPerm = await ensureDirReadWritePermission(targetDirHandle);
      if (!hasPerm) {
        throw new Error(`未获得原图文件夹 [${targetDirHandle.name}] 的写入权限`);
      }

      const fileHandle = await targetDirHandle.getFileHandle(outputFileName, {
        create: true
      });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();

      // Only in overwrite mode: if original image had a different extension (e.g. 4.png -> 4.jpg), delete the old 4.png after 4.jpg is safely written
      const origName = task?.name ? String(task.name).trim() : '';
      if (
        isOverwriteModeEnabled() &&
        origName &&
        origName.toLowerCase() !== outputFileName.toLowerCase() &&
        typeof targetDirHandle.removeEntry === 'function'
      ) {
        try {
          await targetDirHandle.removeEntry(origName);
        } catch (delErr) {
          console.warn(`[Workbench Save] 删除旧格式原图 (${origName}) 失败:`, delErr);
        }
      }

      return {
        savedVia: 'FileSystemAccessAPI',
        path: `${targetDirHandle.name}/${outputFileName}`
      };
    } catch (err) {
      console.warn('[Workbench Save] File System Access API write failed, falling back to chrome.downloads:', err);
    }
  }

  // 2. Fallback to chrome.downloads into Flow_Enhanced/ subfolder (for loose clipboard/dragged images without folder handle)
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
  logAction('PROCESS', '上传参考原图', `[${task.name}] 正在上传参考原图至 Google Flow (maseQ)...`);

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
  logAction('PROCESS', 'AI图生图增强', `[${task.name}] 正在调用 ${selectedModelVal} 生成增强图像 (ogiZ0b)...`);

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
    logAction(
      'PROCESS',
      '超清放大导出',
      `[${task.name}] 正在执行 ${selectedResolutionVal} 超分放大 (SPrCad)...`
    );

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
  await saveEnhancedBlobToDisk(enhancedBlob, outputFileName, task);

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
  logAction(
    'COMPLETE',
    '完成单张图片',
    `[${task.name}] 成功保存为 ${outputFileName} (耗时: ${(task.durationMs / 1000).toFixed(1)}s)`
  );
}

// ============================================================================
// 6. AUTOMATED QUEUE CONTROLLER (SAMPLE MODE, BATCH MODE, RETRY & RATE-LIMIT)
// ============================================================================

function parseDelayRangeMs() {
  const val = selectDelay.value || '3000-5000';
  const [minStr, maxStr] = val.split('-');
  const min = Number(minStr) || 3000;
  const max = Number(maxStr) || 5000;
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

  const queueRunStartTime = Date.now();
  startQueueTimer();
  logAction(
    'QUEUE',
    '开始全部队列',
    `启动批量图生图队列，共 ${pendingTasks.length} 个待处理任务 (AI模型: ${selectModel.value}, 分辨率: ${selectResolution.value})`
  );

  const maxRetries = Number(selectMaxRetries.value) || 0;
  let processedInThisRun = 0;
  let failedInThisRun = 0;
  let attemptedInThisRun = 0;

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
      pauseQueueTimer();
      logAction('QUEUE', '暂停队列', `队列已暂停（当前批次已完成 ${processedInThisRun} 张）`);
      queueLiveStepText.textContent = `队列已暂停（已完成 ${processedInThisRun} 张，点击“继续队列”可从当前位置恢复）。`;
      renderTaskList();
      return;
    }

    attemptedInThisRun++;
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
          stopQueueTimer();
          logAction('QUEUE', '关键响应暂停', `检测到关键响应 (${msg})，队列已自动暂停以保护账号额度`);
          queueLiveStepText.textContent = `检测到关键响应 (${msg})，队列已自动暂停以保护账号额度。`;
          renderTaskList();
          return;
        }

        if (attempt > maxRetries) {
          task.status = 'FAILED';
          task.errorMsg = msg;
          failedInThisRun++;
          await saveTaskToDb(task, i);
          renderTaskList();
          logAction('ERROR', '单张处理失败', `[${task.name}] 失败: ${msg}`);
        }
      }
    }

    // Check if we reached sample test limit
    if (sampleLimit && processedInThisRun >= sampleLimit) {
      appState.queueStatus = 'IDLE';
      stopQueueTimer();
      queueLiveStepText.textContent = `样本测试完成（已成功处理 ${processedInThisRun} 张图片）！请点击列表中的“对比预览”检查效果，满意后可点击“开始全部队列”继续处理剩余图片。`;
      logAction('QUEUE', '样本测试完成', `已成功测试处理 ${processedInThisRun} 张图片`);
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
  const totalElapsedMs = Math.max(1000, Date.now() - queueRunStartTime);
  const avgElapsedMs = Math.round(totalElapsedMs / Math.max(1, attemptedInThisRun));
  stopQueueTimer(totalElapsedMs);
  queueLiveStepText.textContent = `队列执行完毕！共成功 ${totalCompleted} 张，失败 ${totalFailed} 张（耗时 ${formatDurationChinese(totalElapsedMs)}）。`;
  logAction(
    'QUEUE',
    '队列执行完毕',
    `共成功 ${totalCompleted} 张，失败 ${totalFailed} 张，总共耗时 ${formatDurationChinese(totalElapsedMs)}，平均每张 ${formatDurationChinese(avgElapsedMs)}`
  );
  renderTaskList();

  if (!appState.cancelRequested && attemptedInThisRun > 0) {
    showQueueCompletionModal({
      successCount: totalCompleted,
      failedCount: totalFailed,
      totalDurationMs: totalElapsedMs,
      avgDurationMs: avgElapsedMs
    });
  }
}

function showQueueCompletionModal({ successCount, failedCount, totalDurationMs, avgDurationMs }) {
  if (!completionDialog) return;
  if (completionMainText) {
    completionMainText.textContent = `恭喜成功处理 ${successCount} 张图片，失败了 ${failedCount} 张`;
  }
  if (completionTotalTime) {
    completionTotalTime.textContent = formatDurationChinese(totalDurationMs);
  }
  if (completionAvgTime) {
    completionAvgTime.textContent = formatDurationChinese(avgDurationMs);
  }
  completionDialog.showModal();
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
    selectedMaxRetries,
    overwriteOriginal,
    numericNameOnly
  } = await chrome.storage.local.get([
    'userPrompt',
    'selectedModel',
    'defaultModelV027Migrated',
    'selectedResolution',
    'selectedAspect',
    'selectedDelay',
    'selectedMaxRetries',
    'overwriteOriginal',
    'numericNameOnly'
  ]);

  promptTextarea.value = userPrompt || DEFAULT_ECOMMERCE_PROMPT;

  if (chkOverwriteOriginal) {
    chkOverwriteOriginal.checked = overwriteOriginal !== undefined ? Boolean(overwriteOriginal) : true;
    chkOverwriteOriginal.addEventListener('change', () => {
      chrome.storage.local.set({ overwriteOriginal: chkOverwriteOriginal.checked });
      renderTaskList();
      updateDirStatusBanner();
    });
  }

  if (chkNumericNameOnly) {
    chkNumericNameOnly.checked = numericNameOnly !== undefined ? Boolean(numericNameOnly) : true;
    chkNumericNameOnly.addEventListener('change', async () => {
      chrome.storage.local.set({ numericNameOnly: chkNumericNameOnly.checked });
      if (chkNumericNameOnly.checked) {
        const kept = [];
        let removedCount = 0;
        for (const t of appState.tasks) {
          if (t.status === 'PENDING' && !isPureNumericImageName(t.name)) {
            if (t.thumbUrl) URL.revokeObjectURL(t.thumbUrl);
            if (t.enhancedThumbUrl) URL.revokeObjectURL(t.enhancedThumbUrl);
            await deleteTaskFromDb(t.id);
            removedCount++;
          } else {
            kept.push(t);
          }
        }
        if (removedCount > 0) {
          appState.tasks = kept;
          await saveAllTasksOrderToDb();
          queueLiveStepText.textContent = `已开启“只处理纯数字图片”，自动移除了 ${removedCount} 张非纯数字命名的待处理图片。`;
        }
      }
      renderTaskList();
      updateDirStatusBanner();
    });
  }

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

  const VALID_DELAYS = new Set(['3000-5000', '10000-20000', '20000-30000', '30000-40000']);
  selectDelay.value = VALID_DELAYS.has(selectedDelay) ? selectedDelay : '3000-5000';

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
  if (appState.tasks.length > 0) {
    appState.tasksScanned = true;
  }
  renderTaskList();
  renderImportModeUI();

  if (selectImportMode) {
    selectImportMode.addEventListener('change', () => {
      renderImportModeUI();
    });
  }

  if (btnConfirmScanFolders) {
    btnConfirmScanFolders.addEventListener('click', executeScanStagedFolders);
  }

  const { actionLogs: storedLogs } = await chrome.storage.local.get(['actionLogs']);
  if (Array.isArray(storedLogs)) {
    actionLogs = storedLogs;
    renderActionLogBadge();
  }

  if (btnOpenActionLog && actionLogDialog) {
    btnOpenActionLog.addEventListener('click', () => {
      renderActionLogList();
      actionLogDialog.showModal();
    });
  }

  if (btnCopyActionLog) {
    btnCopyActionLog.addEventListener('click', async () => {
      if (actionLogs.length === 0) {
        if (actionLogFeedback) actionLogFeedback.textContent = '暂无记录可复制';
        return;
      }
      const text = actionLogs
        .map((a) => {
          const displayTime = a.timestamp ? formatActionTimestamp(a.timestamp) : a.timeStr;
          return `[${displayTime}] 【${CATEGORY_NAMES[a.category] || a.category}】 ${a.title} - ${a.detail}`;
        })
        .join('\n');
      try {
        await navigator.clipboard.writeText(text);
        if (actionLogFeedback) {
          actionLogFeedback.textContent = '已复制全部行为记录到剪贴板！';
          setTimeout(() => {
            if (actionLogFeedback) actionLogFeedback.textContent = '';
          }, 2000);
        }
      } catch (err) {
        if (actionLogFeedback) actionLogFeedback.textContent = `复制失败: ${err.message}`;
      }
    });
  }

  if (btnClearActionLog) {
    btnClearActionLog.addEventListener('click', async () => {
      actionLogs = [];
      await chrome.storage.local.set({ actionLogs: [] });
      renderActionLogBadge();
      renderActionLogList();
      if (actionLogFeedback) {
        actionLogFeedback.textContent = '已清空历史行为记录！';
        setTimeout(() => {
          if (actionLogFeedback) actionLogFeedback.textContent = '';
        }, 1500);
      }
    });
  }

  const { uiScaleMode } = await chrome.storage.local.get(['uiScaleMode']);
  const activeScaleMode = uiScaleMode || 'auto';
  if (selectUiScale) {
    selectUiScale.value = activeScaleMode;
    applyUiScale(activeScaleMode);
    selectUiScale.addEventListener('change', async () => {
      const mode = selectUiScale.value;
      applyUiScale(mode);
      await chrome.storage.local.set({ uiScaleMode: mode });
      logAction('QUEUE', '界面缩放调整', `切换缩放模式为: ${mode === 'auto' ? '自动检测 (最佳适配)' : mode + '%'}`);
    });
  }

  window.addEventListener('resize', () => {
    if (selectUiScale && selectUiScale.value === 'auto') {
      applyUiScale('auto');
    }
  });

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
    resumeQueueTimer();
    logAction('QUEUE', '继续队列', '从当前暂停位置继续执行剩余队列');
    startQueueLoop({ sampleLimit: null });
  });

  btnCancelQueue.addEventListener('click', async () => {
    appState.cancelRequested = true;
    appState.pauseRequested = false;
    appState.queueStatus = 'IDLE';
    stopQueueTimer();
    logAction('QUEUE', '取消队列', '用户取消了队列执行');
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
    if (appState.tasks.length > 0) {
      alert('已完成文件夹扫描，任务已锁定。如需重新选择文件夹，请先点击“清空列表”。');
      return;
    }
    if (typeof window.showDirectoryPicker !== 'function') {
      alert('当前浏览器环境不支持 window.showDirectoryPicker。');
      return;
    }
    try {
      const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      stageFolder({
        id: `folder_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: dirHandle.name,
        handle: dirHandle
      });
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('Directory picker error:', err);
      }
    }
  });

  btnPickFiles.addEventListener('click', () => {
    if (appState.tasks.length > 0) {
      alert('已导入图片任务，当前处于锁定状态。如需重新导入，请先点击“清空列表”。');
      return;
    }
    fileInputFallback.click();
  });

  fileInputFallback.addEventListener('change', async (e) => {
    if (appState.tasks.length > 0) return;
    if (e.target.files?.length > 0) {
      const sortedFiles = Array.from(e.target.files).sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true })
      );
      const added = await addFilesToTaskList(sortedFiles);
      queueLiveStepText.textContent = `已总共导入${sortedFiles.length}张图，识别有效图片${added}张`;
      fileInputFallback.value = '';
      renderImportModeUI();
    }
  });

  // Drag & Drop support on the image receiving panel
  let dragEnterDepth = 0;
  const setDragHighlight = (active) => {
    if (imageDropZone) imageDropZone.classList.toggle('is-dragover', active);
    if (imageTaskList) imageTaskList.classList.toggle('is-dragover', active);
    if (folderStagingArea) folderStagingArea.classList.toggle('is-dragover', active);
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

      if (appState.tasks.length > 0) {
        queueLiveStepText.textContent =
          '已完成图片扫描并生成任务列表，当前处于锁定状态。不可再次导入文件夹或图片，如需重新导入请先点击“清空列表”。';
        return;
      }

      const isFolderMode = selectImportMode ? selectImportMode.value === 'FOLDER' : true;

      if (isFolderMode) {
        // Mode 1: 导入文件夹
        const droppedFolders = await extractFoldersFromDataTransfer(e.dataTransfer);
        if (droppedFolders.length > 0) {
          let addedCount = 0;
          for (const f of droppedFolders) {
            if (!stagedFolders.some((s) => s.name === f.name)) {
              stagedFolders.push(f);
              addedCount++;
            }
          }
          renderFolderStagingUI();
          updateDirStatusBanner();
          queueLiveStepText.textContent = `已添加 ${addedCount} 个待扫描文件夹（当前共 ${stagedFolders.length} 个待扫描）。请点击右下角“确定扫描”开始解析图片。`;
        } else {
          queueLiveStepText.textContent =
            '当前处于【导入文件夹】模式，请拖入文件夹；或切换左上角下拉选项为【导入图片】模式。';
        }
      } else {
        // Mode 2: 导入图片
        const { files: droppedFiles } = await extractFilesFromDataTransfer(e.dataTransfer);
        if (droppedFiles.length > 0) {
          const added = await addFilesToTaskList(
            droppedFiles,
            appState.inputDirHandle
          );
          queueLiveStepText.textContent = `已通过拖拽总共导入${droppedFiles.length}张图，识别有效图片${added}张`;
          renderImportModeUI();
        } else {
          queueLiveStepText.textContent =
            '当前处于【导入图片】模式，未检测到支持的图片文件（如需导入文件夹，请先切换左上角为【导入文件夹】）。';
        }
      }
    });
  }

  // Clipboard Paste (Ctrl+V) support anywhere on the Workbench
  window.addEventListener('paste', async (e) => {
    const cb = e.clipboardData;
    if (!cb) return;

    if (appState.tasks.length > 0) {
      queueLiveStepText.textContent =
        '已生成任务列表，当前处于锁定状态。如需重新导入，请先点击“清空列表”。';
      return;
    }

    if (selectImportMode && selectImportMode.value === 'FOLDER') {
      queueLiveStepText.textContent =
        '当前处于【导入文件夹】模式。如需直接粘贴图片，请先切换左上角导入方式为【导入图片】。';
      return;
    }

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
    const added = await addFilesToTaskList(imageFiles, null, { skipNumericFilter: true });
    if (added > 0) {
      queueLiveStepText.textContent = `已从剪贴板 (Ctrl+V) 导入 ${added} 张图片: ${imageFiles
        .map((f) => f.name)
        .join(', ')}`;
      renderImportModeUI();
    }
  });

  // Toolbar "粘贴剪贴板 (Ctrl+V)" button via Async Clipboard API
  if (btnPasteClipboard) {
    btnPasteClipboard.addEventListener('click', async () => {
      if (appState.tasks.length > 0) {
        alert('已生成任务列表，当前处于锁定状态。如需重新导入，请先点击“清空列表”。');
        return;
      }
      if (selectImportMode && selectImportMode.value === 'FOLDER') {
        alert('当前处于【导入文件夹】模式。如需直接粘贴图片，请先切换左上角导入方式为【导入图片】。');
        return;
      }
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
          renderImportModeUI();
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
    const clearedTasksCount = appState.tasks.length;
    const clearedFoldersCount = stagedFolders.length;
    for (const t of appState.tasks) {
      if (t.thumbUrl) URL.revokeObjectURL(t.thumbUrl);
      if (t.enhancedThumbUrl) URL.revokeObjectURL(t.enhancedThumbUrl);
    }
    appState.tasks = [];
    stagedFolders = [];
    appState.tasksScanned = false;
    await clearAllTasksFromDb();
    renderTaskList();
    renderImportModeUI();
    stopQueueTimer();
    if (queueTimerText) {
      queueTimerText.textContent = '任务等待启动';
    }
    queueLiveStepText.textContent = '任务列表与待扫描文件夹已清空，可重新选择导入方式。';
    logAction(
      'CLEAR',
      '清空列表',
      `已清空 ${clearedTasksCount} 个任务与 ${clearedFoldersCount} 个待扫描文件夹`
    );
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
