import {
  buildProgressSummaries,
  mergePartProgress,
  normalizeProgressRecord,
  progressRatio,
  progressStorageKey,
} from './progress.js';
import { importBilibiliHistory } from './bilibili-history.js';

const PROGRESS_PREFIX = 'progress:';
const saveQueues = new Map();

const storageReady = chrome.storage.local
  .setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  .catch((error) => console.warn('[bvw] Failed to restrict storage access', error));

async function getAllStorage() {
  await storageReady;
  return chrome.storage.local.get(null);
}

async function getAllProgressRecords() {
  const stored = await getAllStorage();
  const records = [];

  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(PROGRESS_PREFIX)) continue;
    try {
      records.push(normalizeProgressRecord(value));
    } catch {
      // Ignore a damaged record instead of breaking every card on the page.
    }
  }

  return records;
}

function saveProgressRecord(value) {
  const incoming = normalizeProgressRecord(value);
  const key = progressStorageKey(incoming.bvid, incoming.page);
  const previous = saveQueues.get(key) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    await storageReady;
    const stored = await chrome.storage.local.get(key);
    const merged = mergePartProgress(stored[key], incoming);
    await chrome.storage.local.set({ [key]: merged });
    return merged;
  });

  saveQueues.set(key, operation);
  const cleanup = () => {
    if (saveQueues.get(key) === operation) saveQueues.delete(key);
  };
  void operation.then(cleanup, cleanup);
  return operation;
}

async function saveProgressRecords(values) {
  return Promise.all(values.map(saveProgressRecord));
}

async function clearLocalProgress() {
  const stored = await getAllStorage();
  const keys = Object.keys(stored).filter((key) => key.startsWith(PROGRESS_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
}

async function handleMessage(message) {
  switch (message?.type) {
    case 'GET_PROGRESS_SUMMARIES': {
      return { summaries: buildProgressSummaries(await getAllProgressRecords()) };
    }
    case 'SAVE_PROGRESS': {
      const record = await saveProgressRecord(message.record);
      return { record, summary: { ...record, ratio: progressRatio(record) } };
    }
    case 'GET_LOCAL_STATUS': {
      const records = await getAllProgressRecords();
      return {
        partCount: records.length,
        videoCount: Object.keys(buildProgressSummaries(records)).length,
      };
    }
    case 'CLEAR_LOCAL_PROGRESS': {
      await clearLocalProgress();
      return {};
    }
    case 'IMPORT_BILIBILI_HISTORY': {
      const hasPermission = await chrome.permissions.contains({
        origins: ['https://api.bilibili.com/*'],
      });
      if (!hasPermission) throw new Error('尚未允許讀取 Bilibili 歷史紀錄');

      let imported = 0;
      const result = await importBilibiliHistory(async (records) => {
        imported += (await saveProgressRecords(records)).length;
      });
      return { imported, uid: result.uid };
    }
    default:
      throw new Error('Unknown message type');
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((data) => sendResponse({ ok: true, ...data }))
    .catch((error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  return true;
});
