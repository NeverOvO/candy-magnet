import { listHistory, listBatchRecords, listOperations, appendOperations } from './history-store.js';

const $ = (id) => document.getElementById(id);
const ui = {
  content: $('history-content'), list: $('history-list'), empty: $('history-empty'),
  emptyTitle: $('history-empty-title'), emptyMessage: $('history-empty-message'),
  loading: $('history-loading'), error: $('history-error'), errorMessage: $('history-error-message'),
  refresh: $('refresh-history'), retry: $('retry-history'), previous: $('history-previous'),
  next: $('history-next'), pageInfo: $('history-page-info'), toast: $('history-toast'),
  batches: $('view-batches'), operations: $('view-operations'),
  saveNotice: $('operation-save-notice'), saveMessage: $('operation-save-message'),
  retrySave: $('retry-operation-save'),
};
const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dateFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ACTION_NAMES = {
  convert: '转换', copy_odd: '复制奇数行', copy_even: '复制偶数行',
  copy_all: '复制全部', copy_single: '复制单条链接', import: '导入文件',
  clear: '清空列表', remove: '移除文件', options: '修改链接选项',
};
let mode = 'batches';
let rows = [];
let pageCursors = [undefined];
let page = 0;
let nextCursor = null;
let loading = false;
let latestRequest = 0;
let toastTimer;
let haveLoaded = false;
let changeRevision = 0;
const seenRevisions = { batches: 0, operations: 0 };
let retryPage = 0;
const batchDetails = new Map();
const pendingOperations = new Map();
let savingOperations = false;
let operationSaveError = '';

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

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function timestamp(row) {
  return mode === 'batches' ? row.startedAt : row.createdAt;
}

function timeNode(timestamp) {
  const time = node('time', 'history-time', timeFormat.format(new Date(timestamp)));
  time.dateTime = new Date(timestamp).toISOString();
  return time;
}

function renderBatch(batch) {
  const item = node('li', 'history-batch');
  const toggle = node('button', 'history-batch-toggle');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  const summary = node('span', 'history-batch-summary');
  summary.append(node('span', 'history-batch-title', batch.legacy
    ? '旧版记录（批次未知）'
    : `${timeFormat.format(new Date(batch.startedAt))} 的转换`));
  summary.append(node('span', 'history-batch-counts', batch.legacy
    ? `${batch.recordCount} 条链接 · 旧版未保存转换批次信息`
    : `${batch.totalFiles} 个文件 · 成功 ${batch.successCount} · 失败 ${batch.failedCount} · ${batch.recordCount} 条链接`));
  toggle.append(icon('folder-open'), summary);
  if (batch.status === 'running') toggle.append(node('span', 'history-batch-state', '未完成'));
  const chevron = node('span', 'history-batch-chevron');
  chevron.setAttribute('aria-hidden', 'true');
  toggle.append(chevron);
  const body = node('div', 'history-batch-detail');
  body.id = `batch-${batch.id}`;
  body.hidden = true;
  toggle.setAttribute('aria-controls', body.id);
  const list = node('ul', 'history-batch-links');
  const bottom = node('div', 'history-batch-bottom');
  const status = node('span', '', '');
  status.setAttribute('role', 'status');
  const error = node('p', 'history-batch-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const more = node('button', 'button button-clear', '加载更多');
  more.type = 'button';
  more.hidden = true;
  bottom.append(error, status, more);
  body.append(list, bottom);
  item.append(toggle, body);
  const state = { batch, body, list, status, error, more, records: new Map(), nextOffset: 0, loading: false, loaded: false, failed: false };
  batchDetails.set(batch.id, state);
  toggle.addEventListener('click', () => {
    body.hidden = !body.hidden;
    toggle.setAttribute('aria-expanded', String(!body.hidden));
    if (!body.hidden && !state.loaded && !state.loading) void loadBatch(state);
  });
  more.addEventListener('click', () => { void loadBatch(state); });
  return item;
}

function renderRecord(record, position) {
  const item = node('li', 'history-item');
  const top = node('div', 'history-item-top');
  const title = node('div', 'history-item-title');
  const name = node('h3', '', record.title || '未命名种子');
  name.title = record.title;
  title.append(node('span', 'history-record-position', String(position)), name);
  const copy = node('button', 'button button-copy history-copy');
  copy.type = 'button';
  copy.setAttribute('aria-label', `复制 ${record.title || '此记录'} 的磁力链接`);
  copy.append(icon('copy'), document.createTextNode('复制'));
  copy.addEventListener('click', () => { if (!copy.disabled) void copyRecord(record, copy); });
  top.append(title, copy);
  const link = node('input', 'history-link');
  link.type = 'text';
  link.readOnly = true;
  link.value = record.magnet;
  link.setAttribute('aria-label', `${record.title || '此记录'} 的磁力链接`);
  item.append(top, link);
  return item;
}

function updateBatchLoading(state) {
  state.body.setAttribute('aria-busy', String(state.loading));
  state.status.textContent = state.loading ? '正在读取链接…' : state.records.size
    ? `已显示 ${state.records.size} / ${state.batch.recordCount} 条链接`
    : state.loaded ? (state.batch.status === 'running' ? '此批次尚未保存成功转换的链接。' : '此批次没有成功转换的链接。') : '';
  state.more.disabled = state.loading;
  state.more.hidden = !state.failed && (state.loading || state.nextOffset === null);
  state.more.textContent = state.failed ? '重试读取' : '加载更多';
}

async function loadBatch(state) {
  if (state.loading || (state.loaded && state.nextOffset === null)) return;
  state.loading = true;
  state.failed = false;
  state.error.hidden = true;
  updateBatchLoading(state);
  try {
    const response = await listBatchRecords({ batchId: state.batch.id, offset: state.nextOffset || 0, limit: 100 });
    if (batchDetails.get(state.batch.id) !== state) return;
    const fragment = document.createDocumentFragment();
    for (const record of response.records) {
      if (state.records.has(record.id)) continue;
      state.records.set(record.id, record);
      fragment.append(renderRecord(record, state.records.size));
    }
    state.list.append(fragment);
    state.nextOffset = response.nextOffset;
    state.loaded = true;
  } catch (error) {
    if (batchDetails.get(state.batch.id) !== state) return;
    state.failed = true;
    state.error.textContent = error?.message || '链接读取失败，请重试。';
    state.error.hidden = false;
  } finally {
    if (batchDetails.get(state.batch.id) === state) {
      state.loading = false;
      updateBatchLoading(state);
    }
  }
}

function renderOperation(operation) {
  const item = node('li', 'history-item history-operation');
  const top = node('div', 'history-item-top');
  const heading = node('div', 'history-operation-heading');
  heading.append(node('h3', '', ACTION_NAMES[operation.action] || operation.action));
  if (operation.count > 0) {
    const unit = operation.action.startsWith('copy_') || operation.action === 'convert' ? '条链接' : '个文件';
    heading.append(node('span', 'history-operation-count', `${operation.count} ${unit}`));
  }
  heading.append(node('span', `history-operation-status${operation.success ? '' : ' is-failed'}`, operation.success ? '成功' : '失败'));
  top.append(heading, timeNode(operation.createdAt));
  item.append(top);
  if (operation.detail) item.append(node('p', 'history-operation-detail', operation.detail));
  if (operation.batchStartedAt) {
    item.append(node('p', 'history-operation-batch', `所属转换：${dateFormat.format(new Date(operation.batchStartedAt))} ${timeFormat.format(new Date(operation.batchStartedAt))}`));
  }
  return item;
}

function updatePagination() {
  ui.previous.disabled = loading || page === 0;
  ui.next.disabled = loading || !nextCursor;
  const unit = mode === 'batches' ? '组转换记录' : '条操作记录';
  ui.pageInfo.textContent = rows.length ? `第 ${page + 1} 页 · 本页 ${rows.length} ${unit}` : '保留最近 7 天的记录';
}

function render() {
  batchDetails.clear();
  const groups = new Map();
  for (const row of rows) {
    const key = localDateKey(timestamp(row));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const fragment = document.createDocumentFragment();
  for (const group of groups.values()) {
    const section = node('section', 'history-date-group');
    const heading = node('h2', 'history-date-title', dateFormat.format(new Date(timestamp(group[0]))));
    heading.append(node('span', '', `${group.length} ${mode === 'batches' ? '组记录' : '条操作'}`));
    const list = node('ul', 'history-day-list glass');
    for (const row of group) list.append(mode === 'batches' ? renderBatch(row) : renderOperation(row));
    section.append(heading, list);
    fragment.append(section);
  }
  ui.list.replaceChildren(fragment);
  ui.emptyTitle.textContent = mode === 'batches' ? '还没有转换记录' : '还没有操作记录';
  ui.emptyMessage.textContent = mode === 'batches'
    ? '每次点击转换会生成一条批次记录，展开后可查看磁力链接。'
    : '转换、复制奇数行、复制偶数行等操作会记录在这里。';
  ui.empty.hidden = !haveLoaded || rows.length !== 0 || !ui.error.hidden;
  updatePagination();
}

function updateChanges() {
  const pending = changeRevision > seenRevisions[mode];
  ui.refresh.classList.toggle('has-updates', pending);
  ui.refresh.querySelector('span').textContent = pending ? '有更新' : '刷新';
  ui.refresh.setAttribute('aria-label', pending ? '有新记录，点击刷新' : '刷新历史记录');
}

async function loadPage(targetPage = page, { keepScroll = false } = {}) {
  const requestId = ++latestRequest;
  const requestMode = mode;
  const revisionAtStart = changeRevision;
  retryPage = targetPage;
  const scrollTop = keepScroll ? ui.content.scrollTop : 0;
  loading = true;
  ui.content.setAttribute('aria-busy', 'true');
  ui.loading.hidden = haveLoaded;
  ui.error.hidden = true;
  ui.empty.hidden = true;
  ui.refresh.disabled = true;
  ui.retry.disabled = true;
  updatePagination();
  try {
    const response = requestMode === 'batches'
      ? await listHistory({ before: pageCursors[targetPage], limit: 50 })
      : await listOperations({ before: pageCursors[targetPage], limit: 100 });
    if (requestId !== latestRequest || requestMode !== mode) return;
    const result = requestMode === 'batches' ? response.batches : response.operations;
    if (!result.length && targetPage > 0) {
      pageCursors = [undefined];
      await loadPage(0);
      return;
    }
    rows = result;
    page = targetPage;
    nextCursor = response.nextCursor;
    haveLoaded = true;
    if (page === 0) {
      pageCursors = [undefined];
      seenRevisions[mode] = revisionAtStart;
      updateChanges();
    }
    render();
    ui.content.scrollTop = scrollTop;
  } catch (error) {
    if (requestId !== latestRequest || requestMode !== mode) return;
    ui.errorMessage.textContent = error?.message || '历史记录读取失败，请重试。';
    ui.error.hidden = false;
    ui.empty.hidden = true;
  } finally {
    if (requestId === latestRequest && requestMode === mode) {
      loading = false;
      ui.content.setAttribute('aria-busy', 'false');
      ui.loading.hidden = true;
      ui.refresh.disabled = false;
      ui.retry.disabled = false;
      updatePagination();
    }
  }
}

function refresh() {
  if (!loading) void loadPage(0);
}

function switchView(nextMode) {
  if (mode === nextMode) return;
  mode = nextMode;
  page = 0;
  rows = [];
  pageCursors = [undefined];
  nextCursor = null;
  haveLoaded = false;
  ui.batches.classList.toggle('is-active', mode === 'batches');
  ui.operations.classList.toggle('is-active', mode === 'operations');
  ui.batches.setAttribute('aria-pressed', String(mode === 'batches'));
  ui.operations.setAttribute('aria-pressed', String(mode === 'operations'));
  ui.content.setAttribute('aria-label', mode === 'batches' ? '转换批次记录' : '操作记录');
  render();
  updateChanges();
  void loadPage(0);
}

function toast(message) {
  clearTimeout(toastTimer);
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 2600);
}

function updateOperationSaveNotice() {
  ui.saveNotice.hidden = !pendingOperations.size;
  ui.saveMessage.textContent = operationSaveError
    ? `${pendingOperations.size} 条操作记录保存失败：${operationSaveError}`
    : `正在保存 ${pendingOperations.size} 条操作记录…`;
  ui.retrySave.hidden = !operationSaveError;
  ui.retrySave.disabled = savingOperations;
}

async function saveOperations() {
  if (savingOperations || !pendingOperations.size) return;
  savingOperations = true;
  operationSaveError = '';
  updateOperationSaveNotice();
  try {
    while (pendingOperations.size) {
      const operations = Array.from(pendingOperations.values());
      await appendOperations(operations);
      for (const operation of operations) pendingOperations.delete(operation.id);
      updateOperationSaveNotice();
    }
  } catch (error) {
    operationSaveError = error?.message || '请重试保存';
  } finally {
    savingOperations = false;
    updateOperationSaveNotice();
  }
}

async function copyRecord(record, button) {
  const operation = {
    id: crypto.randomUUID(), action: 'copy_single', count: 1,
    detail: `历史记录：${record.title || '未命名种子'}`, batchId: record.batchId,
    createdAt: Date.now(), success: false,
  };
  button.disabled = true;
  try {
    const bridge = window.webkit?.messageHandlers?.desktop;
    if (typeof bridge?.postMessage !== 'function') {
      throw new Error('应用原生服务未连接，请重新打开糖果磁链');
    }
    const reply = await bridge.postMessage({ action: 'copy', text: record.magnet });
    if (reply?.ok !== true) throw new Error(reply?.error || '未能写入剪贴板');
    operation.success = true;
    toast('已复制这条磁力链接');
  } catch (error) {
    const message = error?.message || '未能写入剪贴板';
    operation.detail += `；复制失败：${message}`;
    toast(`复制失败：${message}`);
  } finally {
    button.disabled = false;
  }
  pendingOperations.set(operation.id, operation);
  void saveOperations();
}

ui.batches.addEventListener('click', () => switchView('batches'));
ui.operations.addEventListener('click', () => switchView('operations'));
ui.refresh.addEventListener('click', refresh);
ui.retry.addEventListener('click', () => { if (!loading) void loadPage(retryPage, { keepScroll: true }); });
ui.retrySave.addEventListener('click', () => { void saveOperations(); });
ui.previous.addEventListener('click', () => { if (!loading && page > 0) void loadPage(page - 1); });
ui.next.addEventListener('click', () => {
  if (loading || !nextCursor) return;
  pageCursors[page + 1] = nextCursor;
  void loadPage(page + 1);
});

// Show updates without collapsing an open batch when a copy operation is recorded.
window.addEventListener('history-updated', () => {
  changeRevision += 1;
  updateChanges();
});

function removeExpiredRows() {
  if (document.hidden || loading) return;
  const cutoff = Date.now() - RETENTION_MS;
  if (rows.some((row) => timestamp(row) < cutoff)) void loadPage(page, { keepScroll: true });
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) removeExpiredRows();
});
setInterval(removeExpiredRows, 60 * 1000);

void loadPage(0);
