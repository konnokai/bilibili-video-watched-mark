import { normalizeProgressRecord } from './progress.js';

const API_ORIGIN = 'https://api.bilibili.com';

async function fetchApi(path) {
  const response = await fetch(`${API_ORIGIN}${path}`, { credentials: 'include' });
  if (!response.ok) throw new Error(`Bilibili API 回傳 HTTP ${response.status}`);

  const body = await response.json();
  if (body.code === -101) throw new Error('請先登入 Bilibili');
  if (body.code !== 0) throw new Error(body.message || `Bilibili API 錯誤 ${body.code}`);
  return body.data;
}

function mapHistoryItem(item) {
  if (item?.history?.business !== 'archive') return null;

  const completed = item.progress === -1;
  const position = completed ? item.duration : item.progress;
  if (!completed && !(position > 0)) return null;

  try {
    return normalizeProgressRecord({
      bvid: item.history.bvid,
      page: item.history.page || 1,
      position,
      duration: item.duration,
      completed,
      updatedAt: item.view_at ? item.view_at * 1000 : Date.now(),
      source: 'bilibili-history',
    });
  } catch {
    return null;
  }
}

/**
 * Imports normal BV history sequentially. The private Bilibili endpoint is
 * isolated here so a future API change cannot break local player tracking.
 */
export async function importBilibiliHistory(onBatch) {
  const navigation = await fetchApi('/x/web-interface/nav');
  if (!navigation?.isLogin || !navigation.mid) throw new Error('請先登入 Bilibili');

  let cursor = null;
  const seenCursors = new Set();

  while (true) {
    const params = new URLSearchParams({ type: 'archive', ps: '30' });
    if (cursor) {
      params.set('max', String(cursor.max));
      params.set('view_at', String(cursor.view_at));
      params.set('business', cursor.business);
    }

    const data = await fetchApi(`/x/web-interface/history/cursor?${params}`);
    const items = Array.isArray(data?.list) ? data.list : [];
    if (!items.length) break;

    const records = items.map(mapHistoryItem).filter(Boolean);
    if (records.length) await onBatch(records);

    const nextCursor = data.cursor;
    if (!nextCursor) break;
    const cursorKey = `${nextCursor.max}:${nextCursor.view_at}:${nextCursor.business}`;
    if (seenCursors.has(cursorKey)) break;
    seenCursors.add(cursorKey);
    cursor = nextCursor;
  }

  return { uid: String(navigation.mid) };
}
