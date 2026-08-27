import { normalizeProgressRecord } from './progress.js';

export const SYNC_API_BASE_URL = 'https://bvw-sync.konnokai.me';

const MAX_PROGRESS_RECORDS = 49;
const SYNC_CODE_PATTERN = /^bvw_[A-Za-z0-9_-]{43}$/;
const API_ERRORS = {
  invalid_bilibili_uid: 'Bilibili UID 格式不正確',
  invalid_sync_code: '同步碼無效',
  invalid_progress: '觀看進度格式不正確',
  invalid_progress_batch: '觀看進度批次格式不正確',
  rate_limited: '建立同步帳號太頻繁，請稍後再試',
  request_too_large: '同步資料過大',
};

function normalizeSyncCode(value) {
  const syncCode = typeof value === 'string' ? value.trim() : '';
  if (!SYNC_CODE_PATTERN.test(syncCode)) throw new Error('同步碼格式不正確');
  return syncCode;
}

async function request(path, init = {}, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(`${SYNC_API_BASE_URL}${path}`, init);
  } catch {
    throw new Error('無法連線同步服務');
  }

  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(API_ERRORS[body?.error] || `同步服務錯誤 (${response.status})`);
  }
  return body;
}

function authenticated(syncCode, init = {}) {
  return {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${normalizeSyncCode(syncCode)}`,
    },
  };
}

function toRemoteRecord(value) {
  const { bvid, page, position, duration, completed, updatedAt } = normalizeProgressRecord(value);
  return { bvid, page, position, duration, completed, updatedAt };
}

/** Creates a remote account. The returned sync code must be kept by the extension. */
export function createSyncAccount(bilibiliUid, fetchImpl) {
  const uid = typeof bilibiliUid === 'string' ? bilibiliUid.trim() : '';
  return request('/v1/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bilibiliUid: uid }),
  }, fetchImpl);
}

/** Validates a sync code and returns its remote account metadata. */
export function getSyncAccount(syncCode, fetchImpl) {
  return request('/v1/account', authenticated(syncCode), fetchImpl);
}

export function deleteSyncAccount(syncCode, fetchImpl) {
  return request('/v1/account', authenticated(syncCode, { method: 'DELETE' }), fetchImpl);
}

/** Uploads valid local progress in batches accepted by the D1 endpoint. */
export async function uploadProgress(syncCode, values, fetchImpl) {
  const records = values.map(toRemoteRecord).filter((record) => record.duration > 0);
  for (let index = 0; index < records.length; index += MAX_PROGRESS_RECORDS) {
    await request('/v1/progress', authenticated(syncCode, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: records.slice(index, index + MAX_PROGRESS_RECORDS) }),
    }), fetchImpl);
  }
  return records.length;
}

/** Downloads every cursor page and rejects a repeated cursor instead of looping forever. */
export async function downloadProgress(syncCode, fetchImpl) {
  const records = [];
  const cursors = new Set();
  let cursor = null;

  do {
    const path = cursor ? `/v1/progress?cursor=${encodeURIComponent(cursor)}` : '/v1/progress';
    const result = await request(path, authenticated(syncCode), fetchImpl);
    if (!Array.isArray(result?.records)) throw new Error('同步服務回應格式不正確');
    records.push(...result.records.map(normalizeProgressRecord));

    cursor = result.nextCursor;
    if (cursor !== null && typeof cursor !== 'string') {
      throw new Error('同步服務回應格式不正確');
    }
    if (cursor && cursors.has(cursor)) throw new Error('同步服務回傳重複分頁');
    if (cursor) cursors.add(cursor);
  } while (cursor);

  return records;
}
