const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

async function nativeRequest(action, payload = {}) {
  const bridge = globalThis.webkit?.messageHandlers?.desktop;
  if (typeof bridge?.postMessage !== 'function') {
    throw new Error('应用原生服务未连接，请重新打开糖果磁链');
  }
  const reply = await bridge.postMessage({ action, ...payload });
  if (!reply || reply.ok !== true) throw new Error(reply?.error || '历史记录操作未完成');
  return reply;
}

function cleanRecord(record) {
  if (!record || typeof record.id !== 'string' || !record.id ||
      typeof record.title !== 'string' || typeof record.magnet !== 'string' ||
      !record.magnet.startsWith('magnet:?') ||
      !Number.isSafeInteger(record.convertedAt) || record.convertedAt <= 0) {
    throw new Error('转换记录格式不正确，无法保存');
  }
  return { id: record.id, title: record.title, magnet: record.magnet, convertedAt: record.convertedAt };
}

export async function appendHistory(records) {
  if (!Array.isArray(records)) throw new Error('转换记录格式不正确');
  if (!records.length) return;
  const cutoff = Date.now() - RETENTION_MS;
  const clean = records.map(cleanRecord).filter((record) => record.convertedAt >= cutoff);
  await nativeRequest('history.append', { records: clean });
}

export async function listHistory({ before, limit = 100 } = {}) {
  const pageSize = Math.max(1, Math.min(200, Number.isFinite(limit) ? Math.floor(limit) : 100));
  if (before && (!Number.isSafeInteger(before.convertedAt) || typeof before.id !== 'string')) {
    throw new Error('历史分页位置无效，请刷新列表');
  }
  const response = await nativeRequest('history.list', { ...(before ? { before } : {}), limit: pageSize });
  if (!Array.isArray(response.records)) throw new Error('历史记录读取结果不完整');
  return { records: response.records, nextCursor: response.nextCursor || null };
}

export function openHistory() {
  return nativeRequest('history.open').then(() => undefined);
}
