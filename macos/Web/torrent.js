export const MAX_FILE_BYTES = 500 * 1024;

const utf8 = new TextDecoder('utf-8');
const isDictionary = (value) => value instanceof Map;
const isBytes = (value) => value instanceof Uint8Array;
const isNonnegativeInteger = (value) => typeof value === 'bigint' && value >= 0n;

function binaryKey(bytes) {
  let key = '';
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    key += String.fromCharCode(...bytes.subarray(offset, offset + 4096));
  }
  return key;
}

/** Keep the original info byte range: re-encoding a dictionary can change its hash. */
function decodeTorrent(bytes) {
  let offset = 0;
  let nodes = 0;
  let infoRange = null;

  function fail(message = '种子文件格式损坏，无法读取元数据') {
    throw new Error(message);
  }

  function readString() {
    const start = offset;
    while (offset < bytes.length && bytes[offset] >= 48 && bytes[offset] <= 57) offset += 1;
    if (offset === start || bytes[offset] !== 58) fail();
    const digits = utf8.decode(bytes.subarray(start, offset));
    if (digits.length > 1 && digits[0] === '0') fail();
    const length = Number(digits);
    offset += 1;
    if (!Number.isSafeInteger(length) || length > bytes.length - offset) fail('种子文件不完整，数据长度与文件内容不符');
    const value = bytes.subarray(offset, offset + length);
    offset += length;
    return value;
  }

  function read(depth = 0) {
    if (depth > 96 || ++nodes > 100000) fail('种子文件结构过于复杂，无法处理');
    if (offset >= bytes.length) fail('种子文件不完整');
    const token = bytes[offset];

    if (token >= 48 && token <= 57) return readString();
    if (token === 105) {
      const start = ++offset;
      while (offset < bytes.length && bytes[offset] !== 101) offset += 1;
      if (offset >= bytes.length) fail();
      const value = utf8.decode(bytes.subarray(start, offset));
      if (!/^(0|-?[1-9]\d*)$/.test(value) || value.length > 40) fail('种子文件包含无效的数值');
      offset += 1;
      return BigInt(value);
    }

    if (token === 108) {
      offset += 1;
      const list = [];
      while (offset < bytes.length && bytes[offset] !== 101) list.push(read(depth + 1));
      if (bytes[offset] !== 101) fail();
      offset += 1;
      return list;
    }

    if (token === 100) {
      offset += 1;
      const dictionary = new Map();
      while (offset < bytes.length && bytes[offset] !== 101) {
        const key = binaryKey(readString());
        if (dictionary.has(key)) fail('种子文件包含重复的元数据字段');
        const start = offset;
        const value = read(depth + 1);
        if (depth === 0 && key === 'info') infoRange = [start, offset];
        dictionary.set(key, value);
      }
      if (bytes[offset] !== 101) fail();
      offset += 1;
      return dictionary;
    }

    fail('文件不是有效的 Bencode 种子文件');
  }

  const metadata = read();
  if (offset !== bytes.length) fail('种子元数据后存在无法识别的内容');
  if (!isDictionary(metadata) || !infoRange || !isDictionary(metadata.get('info'))) {
    fail('没有找到有效的 info 字段，请选择完整的 .torrent 文件');
  }
  return { metadata, info: metadata.get('info'), infoBytes: bytes.subarray(...infoRange) };
}

export async function digestHex(algorithm, bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('当前浏览器无法计算哈希，请使用 localhost 或 127.0.0.1 打开本地页面');
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function textValue(value, encoding = 'utf-8') {
  if (!isBytes(value)) return '';
  try {
    return new TextDecoder(encoding).decode(value).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  } catch {
    return utf8.decode(value).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  }
}

function checkV1(info, pieceLength) {
  const pieces = info.get('pieces');
  if (!isBytes(pieces) || pieces.length % 20 !== 0) {
    throw new Error('种子中的分块哈希数据不完整');
  }

  const hasLength = info.has('length');
  const hasFiles = info.has('files');
  if (hasLength === hasFiles) throw new Error('种子必须包含单文件长度或多文件列表');
  let totalSize = 0n;

  if (hasLength) {
    if (!isNonnegativeInteger(info.get('length'))) throw new Error('种子的文件长度无效');
    totalSize = info.get('length');
  } else {
    const files = info.get('files');
    if (!Array.isArray(files) || files.length === 0) throw new Error('种子的文件列表为空或格式损坏');
    for (const file of files) {
      if (!isDictionary(file) || !isNonnegativeInteger(file.get('length'))) {
        throw new Error('种子文件列表包含无效的文件信息');
      }
      const path = file.get('path');
      if (!Array.isArray(path) || path.length === 0 || path.some((part) => !isBytes(part) || part.length === 0)) {
        throw new Error('种子文件列表包含无效的文件路径');
      }
      totalSize += file.get('length');
    }
  }

  const expectedPieces = (totalSize + pieceLength - 1n) / pieceLength;
  if (BigInt(pieces.length) !== expectedPieces * 20n) {
    throw new Error('种子的文件大小与分块哈希数量不匹配');
  }
}

function checkV2(info, pieceLength) {
  if (pieceLength < 16384n || (pieceLength & (pieceLength - 1n)) !== 0n) {
    throw new Error('v2 种子的分块大小无效');
  }
  const tree = info.get('file tree');
  if (!isDictionary(tree) || tree.size === 0 || tree.has('')) {
    throw new Error('v2 种子的文件树无效');
  }

  let fileCount = 0;
  function visit(directory) {
    if (!isDictionary(directory) || directory.size === 0) throw new Error('v2 种子的目录结构损坏');
    if (directory.has('')) {
      const file = directory.get('');
      if (directory.size !== 1 || !isDictionary(file) || !isNonnegativeInteger(file.get('length'))) {
        throw new Error('v2 种子的文件信息无效');
      }
      const root = file.get('pieces root');
      if (file.get('length') > 0n && (!isBytes(root) || root.length !== 32)) {
        throw new Error('v2 种子缺少有效的分块根哈希');
      }
      fileCount += 1;
      return;
    }
    for (const child of directory.values()) visit(child);
  }
  visit(tree);
  if (fileCount === 0) throw new Error('v2 种子中没有文件');
}

function trackerList(metadata) {
  const trackers = new Set();
  const add = (value) => {
    const tracker = textValue(value);
    if (!/^(https?|udp|wss?):\/\//i.test(tracker)) return;
    try {
      if (new URL(tracker).hostname) trackers.add(tracker);
    } catch { /* Malformed optional trackers do not prevent conversion. */ }
  };
  add(metadata.get('announce'));
  const tiers = metadata.get('announce-list');
  if (Array.isArray(tiers)) {
    for (const tier of tiers) {
      if (Array.isArray(tier)) tier.forEach(add);
      else add(tier);
    }
  }
  return [...trackers];
}

export async function parseTorrent(bytes, fallbackName) {
  if (!isBytes(bytes) || bytes.length === 0) throw new Error('这是一个空文件');
  if (bytes.length > MAX_FILE_BYTES) throw new Error('文件超过 500 KB 上限');
  const { metadata, info, infoBytes } = decodeTorrent(bytes);
  const version = info.get('meta version');
  if (version !== undefined && version !== 2n) throw new Error('此种子的元数据版本暂不受支持');
  const pieceLength = info.get('piece length');
  if (typeof pieceLength !== 'bigint' || pieceLength <= 0n) throw new Error('种子缺少有效的分块大小');

  const isV2 = version === 2n;
  const isV1 = !isV2 || info.has('pieces');
  if (isV1) checkV1(info, pieceLength);
  if (isV2) checkV2(info, pieceLength);

  const exactTopics = [];
  if (isV1) exactTopics.push(`urn:btih:${await digestHex('SHA-1', infoBytes)}`);
  if (isV2) exactTopics.push(`urn:btmh:1220${await digestHex('SHA-256', infoBytes)}`);
  const encoding = textValue(metadata.get('encoding')) || 'utf-8';
  const name = textValue(info.get('name.utf-8')) || textValue(info.get('name'), encoding) || fallbackName.replace(/\.torrent$/i, '');

  return {
    id: exactTopics.join('|'),
    exactTopics,
    name,
    trackers: trackerList(metadata),
    format: isV1 && isV2 ? 'v1 + v2' : isV2 ? 'v2' : 'v1',
    isPrivate: info.get('private') === 1n,
  };
}

// One read per imported File; only small metadata leaves the analysis worker.
export async function analyzeTorrentFile(file) {
  if (file.size === 0) throw new Error('这是一个空文件');
  if (file.size > MAX_FILE_BYTES) throw new Error('文件超过 500 KB 上限');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const fingerprint = await digestHex('SHA-256', bytes);
  try {
    return { fingerprint, torrent: await parseTorrent(bytes, file.name), parseError: '' };
  } catch (error) {
    return { fingerprint, torrent: null, parseError: error.message || '种子元数据无法解析' };
  }
}

export function createMagnet(torrent, options = {}) {
  const params = torrent.exactTopics.map((topic) => `xt=${topic}`);
  if (options.includeName !== false && torrent.name) params.push(`dn=${encodeURIComponent(torrent.name)}`);
  if (options.includeTrackers === true) {
    for (const tracker of torrent.trackers) params.push(`tr=${encodeURIComponent(tracker)}`);
  }
  return `magnet:?${params.join('&')}`;
}
