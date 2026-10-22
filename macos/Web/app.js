import { MAX_FILE_BYTES, analyzeTorrentFile, createMagnet } from './torrent.js';
import { appendHistory, openHistory } from './history-store.js';

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 100;
const ui = {
  fileInput: $('file-input'), folderInput: $('folder-input'),
  selectFiles: $('select-files'), selectFolder: $('select-folder'),
  dropZone: $('drop-zone'), dropTitle: $('drop-title'),
  list: $('file-list'), convert: $('convert'), clear: $('clear'),
  summary: $('queue-summary'), result: $('magnet'), count: $('result-count'),
  copy: $('copy'), copyOdd: $('copy-odd'), copyEven: $('copy-even'),
  includeName: $('include-name'), includeTrackers: $('include-trackers'),
  resultNote: $('result-note'), characterCount: $('character-count'),
  notice: $('notice'), noticeText: $('notice-text'), toast: $('toast'),
  pagination: $('queue-pagination'), previousPage: $('previous-page'),
  nextPage: $('next-page'), pageInfo: $('page-info'), appState: $('app-state'),
  openHistory: $('open-history'), retryHistorySave: $('retry-history-save'),
};

let queue = [];
const fingerprints = new Set();
const counts = { pending: 0, converting: 0, done: 0, error: 0 };
let busy = '';
let nextId = 1;
let currentPage = 0;
let dragDepth = 0;
let toastTimer;
let renderTimer;
let completedInBatch = 0;
let batchSize = 0;
let resultCount = 0;
const visibleRows = new Map();
const pendingHistory = [];
const HISTORY_BATCH_SIZE = 50;
const HISTORY_BATCH_CHARACTERS = 256 * 1024;
let historySaving = false;
let historySaveError = '';
let worker;
let workerUnavailable = false;
let workerJob;
let workerSequence = 0;

class WorkerUnavailableError extends Error {}

function disableWorker() {
  workerUnavailable = true;
  worker?.terminate();
  worker = undefined;
  if (workerJob) {
    clearTimeout(workerJob.timeout);
    const pending = workerJob;
    workerJob = undefined;
    pending.reject(new WorkerUnavailableError('后台处理器不可用'));
  }
}

function analyzeInWorker(file) {
  return new Promise((resolve, reject) => {
    try {
      if (!worker) {
        worker = new Worker(new URL('./converter-worker.js', import.meta.url), { type: 'module' });
        worker.addEventListener('message', (event) => {
          const message = event.data;
          if (!workerJob || message?.id !== workerJob.id) return;
          clearTimeout(workerJob.timeout);
          const pending = workerJob;
          workerJob = undefined;
          if (message.ok && message.analysis) pending.resolve(message.analysis);
          else pending.reject(new Error(message.error || '文件无法读取'));
        });
        worker.addEventListener('error', (event) => { event.preventDefault(); disableWorker(); });
        worker.addEventListener('messageerror', disableWorker);
      }
      if (workerJob) {
        reject(new Error('另一个文件仍在处理，请稍候'));
        return;
      }
      const id = ++workerSequence;
      workerJob = { id, resolve, reject, timeout: setTimeout(disableWorker, 30000) };
      worker.postMessage({ id, file });
    } catch {
      if (workerJob) disableWorker();
      else {
        workerUnavailable = true;
        reject(new WorkerUnavailableError('后台处理器无法启动'));
      }
    }
  });
}

async function analyzeFile(file) {
  if (!workerUnavailable && typeof Worker !== 'undefined') {
    try { return await analyzeInWorker(file); }
    catch (error) { if (!(error instanceof WorkerUnavailableError)) throw error; }
  }
  // The same parser remains available when Web Workers are not supported.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return analyzeTorrentFile(file);
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function icon(name) {
  const element = node('i', `icon icon-${name}`);
  element.setAttribute('aria-hidden', 'true');
  return element;
}

function showNotice(message, tone = 'info') {
  ui.noticeText.textContent = message;
  ui.notice.dataset.tone = tone;
  ui.notice.hidden = false;
}

function toast(message) {
  clearTimeout(toastTimer);
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 3200);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function magnetOptions() {
  return { includeName: ui.includeName.checked, includeTrackers: ui.includeTrackers.checked };
}

function setStatus(entry, status) {
  counts[entry.status] -= 1;
  entry.status = status;
  counts[status] += 1;
  entry.revision += 1;
}

function collectResults() {
  const torrents = new Map();
  for (const entry of queue) {
    if (entry.status !== 'done') continue;
    const previous = torrents.get(entry.torrent.id);
    if (previous) {
      for (const tracker of entry.torrent.trackers) previous.trackers.add(tracker);
    } else {
      torrents.set(entry.torrent.id, { ...entry.torrent, trackers: new Set(entry.torrent.trackers) });
    }
  }
  return { torrents: [...torrents.values()], duplicates: counts.done - torrents.size };
}

function updateCopyButtons() {
  const disabled = !ui.result.value || busy === 'converting';
  ui.copy.disabled = disabled;
  ui.copyOdd.disabled = disabled;
  ui.copyEven.disabled = disabled || resultCount < 2;
}

function renderResults() {
  const { torrents, duplicates } = collectResults();
  const value = torrents.map((torrent) => createMagnet(torrent, magnetOptions())).join('\n');
  resultCount = torrents.length;
  ui.result.value = value;
  ui.count.textContent = `${resultCount} 条`;
  updateCopyButtons();
  ui.characterCount.hidden = !value;
  ui.characterCount.textContent = `${value.length.toLocaleString('zh-CN')} 字符`;
  if (resultCount) {
    ui.resultNote.textContent = duplicates ? `已合并 ${duplicates} 条重复链接` : '每行一条，可直接复制到下载工具。';
  } else if (counts.error) {
    ui.resultNote.textContent = '请查看文件列表中的错误信息';
  } else {
    ui.resultNote.textContent = '每行一条，可直接复制到下载工具。';
  }
}

function rowButton(action, label, iconName, id) {
  const button = node('button', 'icon-button');
  button.type = 'button';
  button.dataset.action = action;
  button.dataset.id = String(id);
  button.title = label;
  button.setAttribute('aria-label', label);
  button.disabled = Boolean(busy);
  button.append(icon(iconName));
  return button;
}

function createRow(entry) {
  const labels = { pending: '待转换', converting: '转换中', done: '已完成', error: '失败' };
  const row = node('tr');
  const filenameCell = node('td');
  const description = node('div', 'file-description');
  const info = node('div', 'file-info');
  const filename = node('span', 'file-name', entry.file.name);
  filename.title = entry.path;
  info.append(filename);
  if (entry.path !== entry.file.name) info.append(node('div', 'file-path', entry.path));
  if (entry.error) info.append(node('div', 'file-error', entry.error));
  if (entry.torrent?.isPrivate) info.append(node('div', 'file-warning', '私有种子，请保留原文件'));
  description.append(icon('file-text'), info);
  filenameCell.append(description);

  const sizeCell = node('td', 'file-size', formatSize(entry.file.size));
  const actionCell = node('td');
  const actions = node('div', 'row-actions');
  const status = node('span', 'file-status');
  status.dataset.status = entry.status;
  if (entry.status === 'done') status.append(icon('check'));
  if (entry.status === 'error') status.append(icon('warning-sign'));
  if (entry.status === 'converting') {
    const spinner = icon('spinner');
    spinner.classList.add('is-spinning');
    status.append(spinner);
  }
  status.append(document.createTextNode(labels[entry.status]));
  if (entry.torrent) status.title = `BitTorrent ${entry.torrent.format}`;
  actions.append(status);
  if (entry.status === 'done') actions.append(rowButton('copy', `复制 ${entry.file.name} 的磁力链接`, 'copy', entry.id));
  if (entry.status === 'error') actions.append(rowButton('retry', `重新转换 ${entry.file.name}`, 'refresh', entry.id));
  actions.append(rowButton('remove', `移除 ${entry.file.name}`, 'trash', entry.id));
  actionCell.append(actions);
  row.append(filenameCell, sizeCell, actionCell);
  return { row, revision: entry.revision, disabled: Boolean(busy), buttons: [...row.querySelectorAll('button')] };
}

function renderVisibleRows(pageStart) {
  const page = queue.slice(pageStart, pageStart + PAGE_SIZE);
  const visibleIds = new Set(page.map((entry) => entry.id));
  for (const [id, record] of visibleRows) {
    if (!visibleIds.has(id)) {
      record.row.remove();
      visibleRows.delete(id);
    }
  }
  if (!page.length) {
    if (!ui.list.firstElementChild?.classList.contains('empty-row')) {
      const row = node('tr', 'empty-row');
      const cell = node('td', '', '还没有添加种子文件');
      cell.colSpan = 3;
      row.append(cell);
      ui.list.replaceChildren(row);
    }
    return;
  }
  if (ui.list.firstElementChild?.classList.contains('empty-row')) ui.list.firstElementChild.remove();
  let position = ui.list.firstChild;
  for (const entry of page) {
    let record = visibleRows.get(entry.id);
    if (!record || record.revision !== entry.revision) {
      const replacement = createRow(entry);
      if (record) {
        if (record.row === position) position = replacement.row;
        record.row.replaceWith(replacement.row);
      }
      record = replacement;
      visibleRows.set(entry.id, record);
    } else if (record.disabled !== Boolean(busy)) {
      record.disabled = Boolean(busy);
      for (const button of record.buttons) button.disabled = record.disabled;
    }
    if (record.row === position) position = position.nextSibling;
    else ui.list.insertBefore(record.row, position);
  }
}

function renderHistoryControls() {
  if (!ui.retryHistorySave) return;
  ui.retryHistorySave.hidden = !pendingHistory.length || !historySaveError;
  ui.retryHistorySave.disabled = historySaving || Boolean(busy);
}

function renderQueue() {
  clearTimeout(renderTimer);
  renderTimer = undefined;
  const pageCount = Math.max(1, Math.ceil(queue.length / PAGE_SIZE));
  currentPage = Math.min(currentPage, pageCount - 1);
  const pageStart = currentPage * PAGE_SIZE;
  renderVisibleRows(pageStart);
  const pending = counts.pending + counts.error > 0;
  ui.selectFiles.disabled = Boolean(busy);
  ui.selectFolder.disabled = Boolean(busy);
  ui.convert.disabled = Boolean(busy) || historySaving || !pending;
  ui.clear.disabled = Boolean(busy) || queue.length === 0;
  updateCopyButtons();
  ui.includeName.disabled = busy === 'converting';
  ui.includeTrackers.disabled = busy === 'converting';
  ui.dropZone.setAttribute('aria-busy', String(busy === 'importing'));
  ui.dropTitle.textContent = busy === 'importing' ? '正在添加种子…' : '拖入种子，或整个文件夹';
  ui.convert.querySelector('span').textContent = busy === 'converting'
    ? `转换中 ${completedInBatch} / ${batchSize}`
    : queue.length > 0 && !pending ? '转换完成' : '开始转换';
  ui.convert.querySelector('.icon').classList.toggle('is-spinning', busy === 'converting');
  ui.summary.textContent = `${queue.length} 个文件${counts.done ? ` · ${counts.done} 个完成` : ''}${counts.error ? ` · ${counts.error} 个失败` : ''}`;
  if (ui.pagination) ui.pagination.hidden = pageCount <= 1;
  if (ui.previousPage) ui.previousPage.disabled = currentPage === 0;
  if (ui.nextPage) ui.nextPage.disabled = currentPage >= pageCount - 1;
  if (ui.pageInfo) ui.pageInfo.textContent = `${pageStart + 1}–${Math.min(pageStart + PAGE_SIZE, queue.length)} / ${queue.length}`;
  if (ui.appState) {
    ui.appState.textContent = busy === 'importing' ? '正在添加' : busy === 'converting' ? '正在转换' : historySaving ? '正在保存' : pendingHistory.length && historySaveError ? '历史未保存' : queue.length && !pending ? '转换完成' : '就绪';
    ui.appState.dataset.state = busy || historySaving ? 'busy' : 'ready';
  }
  renderHistoryControls();
}

// Bounded DOM work during large imports. The page size does not limit the queue.
function renderSoon() {
  if (renderTimer === undefined) renderTimer = setTimeout(renderQueue, 80);
}

async function importFiles(loadSelection) {
  if (busy) {
    toast('正在处理文件，请稍候再添加');
    return;
  }
  busy = 'importing';
  ui.notice.hidden = true;
  renderQueue();
  let accepted = 0;
  let repeated = 0;
  let otherFiles = 0;
  let oversized = 0;
  let failed = 0;
  const failureSamples = [];
  const recordFailure = (message) => {
    failed += 1;
    if (failureSamples.length < 3) failureSamples.push(message);
  };

  try {
    if (!globalThis.crypto?.subtle) throw new Error('当前环境无法计算哈希，请重新打开糖果磁链。');
    const selection = await loadSelection();
    for (const item of selection.files) {
      const file = item.file;
      if (!/\.torrent$/i.test(file.name)) { otherFiles += 1; continue; }
      if (file.size > MAX_FILE_BYTES) { oversized += 1; continue; }
      if (file.size === 0) { recordFailure(`${file.name}：空文件`); continue; }
      try {
        const analysis = await analyzeFile(file);
        const { fingerprint } = analysis;
        if (fingerprints.has(fingerprint)) { repeated += 1; continue; }
        fingerprints.add(fingerprint);
        queue.push({ id: nextId++, file, fingerprint, analysis, revision: 0, path: item.path || file.name, status: 'pending', torrent: null, error: '' });
        counts.pending += 1;
        accepted += 1;
        renderSoon();
      } catch (error) {
        recordFailure(`${file.name}：${error.message || '文件无法读取'}`);
      }
    }

    const messages = [];
    if (otherFiles) messages.push(`忽略 ${otherFiles} 个非种子文件。`);
    if (oversized) messages.push(`${oversized} 个文件超过 500 KB，未添加。`);
    if (selection.depthSkipped) messages.push(`${selection.depthSkipped} 个目录层级过深，请单独选择这些目录。`);
    if (selection.unreadable) messages.push(`${selection.unreadable} 个文件或文件夹无法读取。`);
    if (failed) messages.push(...failureSamples, ...(failed > 3 ? [`另有 ${failed - 3} 个文件无法读取。`] : []));
    if (!accepted && !repeated && messages.length === 0) messages.push('没有找到可添加的 .torrent 种子文件。');
    if (messages.length) {
      if (repeated) messages.push(`另跳过 ${repeated} 个重复文件。`);
      showNotice(messages.join(' '), 'warning');
    } else if (repeated) {
      toast(`已跳过 ${repeated} 个重复文件`);
    }
  } catch (error) {
    showNotice(error.message || '无法读取所选文件，请重新选择。', 'warning');
  } finally {
    busy = '';
    renderQueue();
  }
}

function selectedFiles(files) {
  return { files: Array.from(files, (file) => ({ file, path: file.webkitRelativePath || file.name })) };
}

/** Snapshot drag items before the browser clears the DataTransfer store. */
function snapshotDrop(dataTransfer) {
  if (dataTransfer.items?.length) {
    return Array.from(dataTransfer.items)
      .filter((item) => item.kind === 'file')
      .map((item) => {
        const file = item.getAsFile();
        try { return { entry: item.webkitGetAsEntry?.(), file }; }
        catch { return { file }; }
      });
  }
  return Array.from(dataTransfer.files, (file) => ({ file }));
}

async function readDrop(roots) {
  const files = [];
  let unreadable = 0;
  let depthSkipped = 0;
  async function visit(entry, depth = 0) {
    if (depth > 48) { depthSkipped += 1; return; }
    try {
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        files.push({ file, path: entry.fullPath.replace(/^\//, '') });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        while (true) {
          const children = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
          if (children.length === 0) break;
          for (const child of children) await visit(child, depth + 1);
        }
      }
    } catch { unreadable += 1; }
  }
  for (const item of roots) {
    if (item.entry) await visit(item.entry);
    else if (item.file) files.push({ file: item.file, path: item.file.name });
  }
  return { files, unreadable, depthSkipped };
}

function historyRecordId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function historyFailureMessage() {
  return `${pendingHistory.length} 条转换记录未保存到历史：${historySaveError || '保存暂不可用'}。当前链接仍可复制，请在关闭窗口前重试保存历史。`;
}

async function savePendingHistory() {
  if (historySaving) return false;
  if (!pendingHistory.length) {
    historySaveError = '';
    renderHistoryControls();
    return true;
  }
  historySaving = true;
  renderQueue();
  let confirmed = 0;
  try {
    while (confirmed < pendingHistory.length) {
      const batch = [];
      let characters = 0;
      for (let index = confirmed; index < pendingHistory.length && batch.length < HISTORY_BATCH_SIZE; index += 1) {
        const record = pendingHistory[index];
        const estimatedSize = record.magnet.length + record.title.length + 160;
        if (batch.length && characters + estimatedSize > HISTORY_BATCH_CHARACTERS) break;
        batch.push(record);
        characters += estimatedSize;
      }
      await appendHistory(batch);
      confirmed += batch.length;
    }
    historySaveError = '';
    return true;
  } catch (error) {
    historySaveError = String(error.message || '无法写入历史记录').slice(0, 240);
    return false;
  } finally {
    // Remove only confirmed records. Failed or uncertain transactions keep their UUIDs.
    if (confirmed) pendingHistory.splice(0, confirmed);
    historySaving = false;
    renderQueue();
  }
}

async function convert(ids) {
  if (busy || historySaving) return;
  const targets = queue.filter((entry) => ids ? ids.includes(entry.id) : entry.status === 'pending' || entry.status === 'error');
  if (!targets.length) return;
  const optionsSnapshot = magnetOptions();
  const historySeen = new Set();
  busy = 'converting';
  completedInBatch = 0;
  batchSize = targets.length;
  ui.notice.hidden = true;
  ui.resultNote.textContent = '正在转换，完成后汇总全部链接';
  renderQueue();
  let failed = 0;
  let historyAttemptFailed = false;
  let bufferedCharacters = 0;
  try {
    for (const entry of targets) {
      const retry = entry.status === 'error';
      setStatus(entry, 'converting');
      entry.error = '';
      renderSoon();
      try {
        if (retry || !entry.analysis) entry.analysis = await analyzeFile(entry.file);
        if (entry.analysis.parseError) throw new Error(entry.analysis.parseError);
        entry.torrent = entry.analysis.torrent;
        setStatus(entry, 'done');
        const magnet = createMagnet(entry.torrent, optionsSnapshot);
        const historyKey = `${entry.torrent.id}\u0000${magnet}`;
        if (!historySeen.has(historyKey)) {
          const record = {
            id: historyRecordId(), title: entry.torrent.name,
            magnet, convertedAt: Date.now(),
          };
          historySeen.add(historyKey);
          pendingHistory.push(record);
          bufferedCharacters += record.title.length + record.magnet.length + 160;
        }
      } catch (error) {
        setStatus(entry, 'error');
        entry.error = error.message || '无法解析该种子，请重新选择文件。';
        entry.torrent = null;
        failed += 1;
      }
      completedInBatch += 1;
      renderSoon();
      if (!historyAttemptFailed && (pendingHistory.length >= HISTORY_BATCH_SIZE || bufferedCharacters >= HISTORY_BATCH_CHARACTERS)) {
        historyAttemptFailed = !(await savePendingHistory());
        bufferedCharacters = 0;
      }
      // Cached metadata makes conversion fast; yield periodically for window controls.
      if (completedInBatch % PAGE_SIZE === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (!historyAttemptFailed) await savePendingHistory();
    const warnings = [];
    if (failed) warnings.push(`${failed} 个文件转换失败，请查看文件行内的原因。`);
    if (pendingHistory.length && historySaveError) warnings.push(historyFailureMessage());
    if (warnings.length) showNotice(warnings.join(' '), 'warning');
  } finally {
    busy = '';
    renderResults();
    renderQueue();
  }
}

function copyResultRows(parity) {
  if (!ui.result.value || busy === 'converting') return;
  // Count complete links in the displayed result, starting with row 1.
  const lines = ui.result.value.split('\n').filter((_, index) => index % 2 === parity);
  if (!lines.length) return;
  const label = parity === 0 ? '奇数行' : '偶数行';
  void copyText(lines.join('\n'), `已复制${label} ${lines.length} 条磁力链接`);
}

async function copyText(value, successMessage) {
  if (!value) return;
  try {
    const nativeClipboard = window.webkit?.messageHandlers?.desktop;
    if (typeof nativeClipboard?.postMessage !== 'function') {
      throw new Error('应用原生服务未连接，请重新打开糖果磁链');
    }
    const reply = await nativeClipboard.postMessage({ action: 'copy', text: value });
    if (reply?.ok !== true) throw new Error(reply?.error || '未能写入剪贴板');
    toast(successMessage);
  } catch (error) {
    showNotice(`复制失败：${error.message || '未能写入剪贴板'}`, 'warning');
  }
}

ui.selectFiles.addEventListener('click', () => ui.fileInput.click());
ui.selectFolder.addEventListener('click', () => ui.folderInput.click());
for (const input of [ui.fileInput, ui.folderInput]) {
  input.addEventListener('change', () => {
    const selection = selectedFiles(input.files);
    input.value = '';
    if (selection.files.length) void importFiles(() => selection);
  });
}

const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
ui.dropZone.addEventListener('dragenter', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  if (!busy) ui.dropZone.classList.add('is-dragging');
});
ui.dropZone.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
});
ui.dropZone.addEventListener('dragleave', (event) => {
  if (!hasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) ui.dropZone.classList.remove('is-dragging');
});
ui.dropZone.addEventListener('drop', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  ui.dropZone.classList.remove('is-dragging');
  const roots = snapshotDrop(event.dataTransfer);
  void importFiles(() => readDrop(roots));
});
document.addEventListener('dragover', (event) => { if (hasFiles(event)) event.preventDefault(); });
document.addEventListener('drop', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  ui.dropZone.classList.remove('is-dragging');
  if (!ui.dropZone.contains(event.target)) toast('请把文件拖入上方的添加区域');
});

ui.convert.addEventListener('click', () => { void convert(); });
ui.clear.addEventListener('click', () => {
  if (busy) return;
  queue = [];
  fingerprints.clear();
  for (const status of Object.keys(counts)) counts[status] = 0;
  currentPage = 0;
  ui.notice.hidden = true;
  renderResults();
  renderQueue();
  ui.selectFiles.focus();
});
ui.list.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button || busy) return;
  const entry = queue.find((item) => item.id === Number(button.dataset.id));
  if (!entry) return;
  if (button.dataset.action === 'remove') {
    queue = queue.filter((item) => item.id !== entry.id);
    fingerprints.delete(entry.fingerprint);
    counts[entry.status] -= 1;
    renderResults();
    renderQueue();
    ui.selectFiles.focus();
  }
  if (button.dataset.action === 'retry') void convert([entry.id]);
  if (button.dataset.action === 'copy' && entry.torrent) void copyText(createMagnet(entry.torrent, magnetOptions()), '已复制这条磁力链接');
});
ui.copy.addEventListener('click', () => { void copyText(ui.result.value, `已复制 ${resultCount} 条磁力链接`); });
ui.copyOdd.addEventListener('click', () => copyResultRows(0));
ui.copyEven.addEventListener('click', () => copyResultRows(1));
ui.openHistory?.addEventListener('click', async () => {
  ui.openHistory.disabled = true;
  try {
    await openHistory();
  } catch (error) {
    showNotice(`无法打开历史记录：${error.message || '请稍后重试'}。`, 'warning');
  } finally {
    ui.openHistory.disabled = false;
  }
});
ui.retryHistorySave?.addEventListener('click', async () => {
  if (busy || historySaving || !pendingHistory.length) return;
  if (await savePendingHistory()) {
    ui.notice.hidden = true;
    toast('历史记录已保存');
  } else {
    showNotice(historyFailureMessage(), 'warning');
  }
});
ui.includeName.addEventListener('change', renderResults);
ui.includeTrackers.addEventListener('change', renderResults);
ui.previousPage?.addEventListener('click', () => {
  currentPage = Math.max(0, currentPage - 1);
  renderQueue();
  ui.list.closest('.file-table-wrap')?.scrollTo({ top: 0 });
});
ui.nextPage?.addEventListener('click', () => {
  currentPage += 1;
  renderQueue();
  ui.list.closest('.file-table-wrap')?.scrollTo({ top: 0 });
});
$('dismiss-notice').addEventListener('click', () => { ui.notice.hidden = true; });
if (!('webkitdirectory' in ui.folderInput)) {
  ui.selectFolder.hidden = true;
  $('drop-hint').textContent = '当前系统不支持文件夹选择，可拖入文件夹或选择种子文件';
}

renderQueue();
renderResults();
