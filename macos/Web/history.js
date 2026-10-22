import { listHistory } from './history-store.js';

const $ = (id) => document.getElementById(id);
const ui = {
  content: $('history-content'), list: $('history-list'), empty: $('history-empty'),
  loading: $('history-loading'), error: $('history-error'), errorMessage: $('history-error-message'),
  refresh: $('refresh-history'), retry: $('retry-history'), previous: $('history-previous'),
  next: $('history-next'), pageInfo: $('history-page-info'), toast: $('history-toast'),
};
const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dateFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
let records = [];
let pageCursors = [undefined];
let page = 0;
let nextCursor = null;
let loading = false;
let latestRequest = 0;
let toastTimer;
let refreshTimer;
let pendingChanges = false;
let haveLoaded = false;
let changeRevision = 0;
let retryPage = 0;

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

function render() {
  const groups = new Map();
  for (const record of records) {
    const key = localDateKey(record.convertedAt);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  const fragment = document.createDocumentFragment();
  for (const group of groups.values()) {
    const section = node('section', 'history-date-group');
    const heading = node('h2', 'history-date-title', dateFormat.format(new Date(group[0].convertedAt)));
    heading.append(node('span', '', `${group.length} 条`));
    const list = node('ul', 'history-day-list glass');
    for (const record of group) {
      const item = node('li', 'history-item');
      const top = node('div', 'history-item-top');
      const title = node('div', 'history-item-title');
      const name = node('h3', '', record.title || '未命名种子');
      name.title = record.title;
      title.append(icon('file-text'), name);
      const tools = node('div', 'history-item-tools');
      const time = node('time', 'history-time', timeFormat.format(new Date(record.convertedAt)));
      time.dateTime = new Date(record.convertedAt).toISOString();
      const copy = node('button', 'button button-copy history-copy');
      copy.type = 'button';
      copy.dataset.recordId = record.id;
      copy.setAttribute('aria-label', `复制 ${record.title || '此记录'} 的磁力链接`);
      copy.append(icon('copy'), document.createTextNode('复制'));
      tools.append(time, copy);
      top.append(title, tools);
      const link = node('input', 'history-link');
      link.type = 'text';
      link.readOnly = true;
      link.value = record.magnet;
      link.setAttribute('aria-label', `${record.title || '此记录'} 的磁力链接`);
      item.append(top, link);
      list.append(item);
    }
    section.append(heading, list);
    fragment.append(section);
  }
  ui.list.replaceChildren(fragment);
  ui.empty.hidden = !haveLoaded || records.length !== 0 || !ui.error.hidden;
  ui.previous.disabled = loading || page === 0;
  ui.next.disabled = loading || !nextCursor;
  ui.pageInfo.textContent = records.length ? `第 ${page + 1} 页 · 本页 ${records.length} 条` : '保留最近 7 天的转换记录';
}

function markChanges() {
  pendingChanges = true;
  ui.refresh.classList.add('has-updates');
  ui.refresh.querySelector('span').textContent = '有更新';
}

function clearChanges() {
  pendingChanges = false;
  ui.refresh.classList.remove('has-updates');
  ui.refresh.querySelector('span').textContent = '刷新';
}

async function loadPage(targetPage = page, { keepScroll = false } = {}) {
  const requestId = ++latestRequest;
  const revisionAtStart = changeRevision;
  retryPage = targetPage;
  const scrollTop = keepScroll ? ui.content.scrollTop : 0;
  loading = true;
  ui.content.setAttribute('aria-busy', 'true');
  ui.loading.hidden = haveLoaded;
  ui.error.hidden = true;
  ui.empty.hidden = true;
  ui.previous.disabled = true;
  ui.next.disabled = true;
  ui.refresh.disabled = true;
  ui.retry.disabled = true;
  try {
    const response = await listHistory({ before: pageCursors[targetPage], limit: 100 });
    if (requestId !== latestRequest) return;
    if (!response.records.length && targetPage > 0) {
      pageCursors = [undefined];
      await loadPage(0);
      return;
    }
    records = response.records;
    page = targetPage;
    nextCursor = response.nextCursor;
    haveLoaded = true;
    if (page === 0) {
      pageCursors = [undefined];
      if (changeRevision === revisionAtStart) clearChanges();
    }
    render();
    ui.content.scrollTop = scrollTop;
  } catch (error) {
    if (requestId !== latestRequest) return;
    ui.errorMessage.textContent = error?.message || '历史记录读取失败，请重试。';
    ui.error.hidden = false;
    ui.empty.hidden = true;
  } finally {
    if (requestId === latestRequest) {
      loading = false;
      ui.content.setAttribute('aria-busy', 'false');
      ui.loading.hidden = true;
      ui.refresh.disabled = false;
      ui.retry.disabled = false;
      ui.previous.disabled = page === 0;
      ui.next.disabled = !nextCursor;
      if (pendingChanges && page === 0 && ui.content.scrollTop < 20 && ui.error.hidden && !document.hidden) {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refresh, 300);
      }
    }
  }
}

function refresh() {
  if (loading) return;
  void loadPage(0);
}

function toast(message) {
  clearTimeout(toastTimer);
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 2400);
}

async function copyRecord(record, button) {
  button.disabled = true;
  try {
    const bridge = window.webkit?.messageHandlers?.desktop;
    if (typeof bridge?.postMessage !== 'function') {
      throw new Error('应用原生服务未连接，请重新打开糖果磁链');
    }
    const reply = await bridge.postMessage({ action: 'copy', text: record.magnet });
    if (reply?.ok !== true) throw new Error(reply?.error || '未能写入剪贴板');
    toast('已复制这条磁力链接');
  } catch (error) {
    toast(`复制失败：${error.message || '未能写入剪贴板'}`);
  } finally {
    button.disabled = false;
  }
}

ui.refresh.addEventListener('click', refresh);
ui.retry.addEventListener('click', () => { if (!loading) void loadPage(retryPage, { keepScroll: true }); });
ui.previous.addEventListener('click', () => { if (!loading && page > 0) void loadPage(page - 1); });
ui.next.addEventListener('click', () => {
  if (loading || !nextCursor) return;
  pageCursors[page + 1] = nextCursor;
  void loadPage(page + 1);
});
ui.list.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-record-id]');
  if (!button || button.disabled) return;
  const record = records.find((item) => item.id === button.dataset.recordId);
  if (record) void copyRecord(record, button);
});

window.addEventListener('history-updated', () => {
  changeRevision += 1;
  markChanges();
  clearTimeout(refreshTimer);
  if (!loading && page === 0 && ui.content.scrollTop < 20 && !document.hidden) {
    refreshTimer = setTimeout(refresh, 300);
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !loading) {
    if (pendingChanges && page === 0 && ui.content.scrollTop < 20) refresh();
    else void loadPage(page, { keepScroll: true });
  }
});

// Expired rows disappear even while the history window stays open for a long time.
setInterval(() => {
  if (document.hidden || loading) return;
  const cutoff = Date.now() - RETENTION_MS;
  if (records.some((record) => record.convertedAt < cutoff)) {
    void loadPage(page, { keepScroll: true });
  }
}, 60 * 1000);

void loadPage(0);
