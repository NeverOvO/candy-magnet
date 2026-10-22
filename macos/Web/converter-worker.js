import { analyzeTorrentFile } from './torrent.js';

let processing = false;

self.addEventListener('message', async (event) => {
  const { id, file } = event.data || {};
  if (!Number.isSafeInteger(id) || !file || typeof file.arrayBuffer !== 'function') return;
  if (processing) {
    self.postMessage({ id, ok: false, error: '后台处理器正在处理另一个文件' });
    return;
  }
  processing = true;
  try {
    const analysis = await analyzeTorrentFile(file);
    self.postMessage({ id, ok: true, analysis });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error.message || '文件无法读取' });
  } finally {
    processing = false;
  }
});
