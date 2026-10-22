const LEGACY_BATCH_ID = 'legacy-unbatched-v1';
const encoder = new TextEncoder();

async function nativeRequest(action, payload = {}) {
  const bridge = globalThis.webkit?.messageHandlers?.desktop;
  if (typeof bridge?.postMessage !== 'function') {
    throw new Error('应用原生服务未连接，请重新打开糖果磁链');
  }
  const reply = await bridge.postMessage({ action, ...payload });
  if (!reply || reply.ok !== true) throw new Error(reply?.error || '历史记录操作未完成');
  return reply;
}

function isIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') && encoder.encode(value).length <= 128;
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function cleanBatch(batch) {
  if (!batch || !isIdentifier(batch.id) || batch.id === LEGACY_BATCH_ID ||
      !Number.isSafeInteger(batch.startedAt) || batch.startedAt <= 0 || !isCount(batch.completedAt) ||
      !isCount(batch.totalFiles) || !isCount(batch.successCount) || !isCount(batch.failedCount) ||
      batch.successCount + batch.failedCount > batch.totalFiles ||
      !((batch.status === 'running' && batch.completedAt === 0) ||
        (batch.status === 'completed' && batch.completedAt >= batch.startedAt))) {
    throw new Error('转换批次格式不正确，无法保存');
  }
  return {
    id: batch.id, startedAt: batch.startedAt, completedAt: batch.completedAt,
    totalFiles: batch.totalFiles, successCount: batch.successCount,
    failedCount: batch.failedCount, status: batch.status,
  };
}

function cleanRecord(record, batch) {
  if (!record || !isIdentifier(record.id) ||
      typeof record.title !== 'string' || record.title.includes('\0') ||
      typeof record.magnet !== 'string' || !record.magnet.startsWith('magnet:?') || record.magnet.includes('\0') ||
      !Number.isSafeInteger(record.convertedAt) || record.convertedAt <= 0 ||
      record.batchId !== batch.id || !isCount(record.position) || record.position >= batch.totalFiles) {
    throw new Error('转换记录格式不正确，无法保存');
  }
  return {
    id: record.id, title: record.title, magnet: record.magnet, convertedAt: record.convertedAt,
    batchId: record.batchId, position: record.position,
  };
}

function cleanOperation(operation) {
  if (!operation || !isIdentifier(operation.id) || !isIdentifier(operation.action) ||
      typeof operation.detail !== 'string' || operation.detail.includes('\0') || encoder.encode(operation.detail).length > 8192 ||
      !isCount(operation.count) || !Number.isSafeInteger(operation.createdAt) || operation.createdAt <= 0 ||
      typeof operation.success !== 'boolean' ||
      (operation.batchId != null && !isIdentifier(operation.batchId))) {
    throw new Error('操作记录格式不正确，无法保存');
  }
  return {
    id: operation.id, action: operation.action, detail: operation.detail, count: operation.count,
    createdAt: operation.createdAt, success: operation.success, batchId: operation.batchId ?? null,
  };
}

function cleanCursor(before) {
  if (before == null) return null;
  if (!isCount(before.convertedAt) || !isIdentifier(before.id)) {
    throw new Error('历史分页位置无效，请刷新列表');
  }
  return { convertedAt: before.convertedAt, id: before.id };
}

function pageLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('分页数量必须为正整数');
  return Math.min(200, limit);
}

export async function appendHistory(records, batch) {
  if (!Array.isArray(records)) throw new Error('转换记录格式不正确');
  const clean = cleanBatch(batch);
  // Empty writes create/finalize batches, including conversions with no usable links.
  await nativeRequest('history.append', { records: records.map((record) => cleanRecord(record, clean)), batch: clean });
}

export async function listHistory({ before, limit = 50 } = {}) {
  const cursor = cleanCursor(before);
  const response = await nativeRequest('history.list', { ...(cursor ? { before: cursor } : {}), limit: pageLimit(limit) });
  if (!Array.isArray(response.batches)) throw new Error('转换批次读取结果不完整');
  return { batches: response.batches, nextCursor: response.nextCursor || null };
}

export async function listBatchRecords({ batchId, offset = 0, limit = 100 } = {}) {
  if (!isIdentifier(batchId) || !isCount(offset) || offset > Number.MAX_SAFE_INTEGER - 200) {
    throw new Error('批次分页位置无效，请刷新列表');
  }
  const response = await nativeRequest('history.records', { batchId, offset, limit: pageLimit(limit) });
  if (!Array.isArray(response.records)) throw new Error('批次链接读取结果不完整');
  return { records: response.records, nextOffset: response.nextOffset ?? null };
}

export async function appendOperations(operations) {
  if (!Array.isArray(operations)) throw new Error('操作记录格式不正确');
  await nativeRequest('history.operations.append', { operations: operations.map(cleanOperation) });
}

export async function listOperations({ before, limit = 100 } = {}) {
  const cursor = cleanCursor(before);
  const response = await nativeRequest('history.operations.list', { ...(cursor ? { before: cursor } : {}), limit: pageLimit(limit) });
  if (!Array.isArray(response.operations)) throw new Error('操作记录读取结果不完整');
  return { operations: response.operations, nextCursor: response.nextCursor || null };
}

export function openHistory() {
  return nativeRequest('history.open').then(() => undefined);
}
