import {
  buildProgressSummaries,
  mergePartProgress,
  normalizeProgressRecord,
  progressRatio,
  progressStorageKey,
} from './progress.js';
import { importBilibiliHistory } from './bilibili-history.js';
import {
  createSyncAccount,
  deleteSyncAccount,
  downloadProgress,
  getSyncAccount,
  uploadProgress,
} from './sync.js';

const PROGRESS_PREFIX = 'progress:';
const SYNC_CONFIG_KEY = 'sync:config';
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

async function getSyncConfig() {
  await storageReady;
  const stored = await chrome.storage.local.get(SYNC_CONFIG_KEY);
  return stored[SYNC_CONFIG_KEY] || null;
}

async function saveSyncConfig(account) {
  await storageReady;
  const config = {
    accountId: account.accountId,
    bilibiliUid: account.bilibiliUid,
    syncCode: account.syncCode,
    createdAt: account.createdAt,
    lastSyncedAt: account.lastSyncedAt || null,
  };
  await chrome.storage.local.set({ [SYNC_CONFIG_KEY]: config });
  return config;
}

async function synchronizeProgress() {
  const config = await getSyncConfig();
  if (!config) throw new Error('尚未連結同步帳號');

  const localRecords = await getAllProgressRecords();
  const uploaded = await uploadProgress(config.syncCode, localRecords);
  const remoteRecords = await downloadProgress(config.syncCode);
  await saveProgressRecords(remoteRecords);

  const lastSyncedAt = Date.now();
  const current = await getSyncConfig();
  if (current?.syncCode === config.syncCode) {
    await saveSyncConfig({ ...current, lastSyncedAt });
  }
  return { uploaded, downloaded: remoteRecords.length, lastSyncedAt };
}

async function handleMessage(message) {
  switch (message?.type) {
    case 'GET_PROGRESS_SUMMARIES': {
      return { summaries: buildProgressSummaries(await getAllProgressRecords()) };
    }
    case 'SAVE_PROGRESS': {
      const record = await saveProgressRecord(message.record);
      if (message.syncRemote) {
        const config = await getSyncConfig();
        if (config) {
          await uploadProgress(config.syncCode, [record]).catch((error) => {
            console.warn('[bvw] Failed to upload playback progress', error);
          });
        }
      }
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
      if (await getSyncConfig()) {
        await synchronizeProgress().catch((error) => {
          console.warn('[bvw] Failed to sync imported history', error);
        });
      }
      return { imported, uid: result.uid };
    }
    case 'GET_SYNC_STATUS': {
      const config = await getSyncConfig();
      return config ? { linked: true, ...config } : { linked: false };
    }
    case 'CREATE_SYNC_ACCOUNT': {
      const account = await createSyncAccount(message.bilibiliUid);
      const config = await saveSyncConfig(account);
      const sync = await synchronizeProgress();
      return { config, sync };
    }
    case 'CONNECT_SYNC_ACCOUNT': {
      const syncCode = typeof message.syncCode === 'string' ? message.syncCode.trim() : '';
      const account = await getSyncAccount(syncCode);
      const config = await saveSyncConfig({ ...account, syncCode });
      const sync = await synchronizeProgress();
      return { config, sync };
    }
    case 'SYNC_NOW': {
      return { sync: await synchronizeProgress() };
    }
    case 'DISCONNECT_SYNC_ACCOUNT': {
      await chrome.storage.local.remove(SYNC_CONFIG_KEY);
      return {};
    }
    case 'DELETE_SYNC_ACCOUNT': {
      const config = await getSyncConfig();
      if (!config) throw new Error('尚未連結同步帳號');
      await deleteSyncAccount(config.syncCode);
      await chrome.storage.local.remove(SYNC_CONFIG_KEY);
      return {};
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

chrome.runtime.onStartup.addListener(() => {
  void synchronizeProgress().catch((error) => {
    if (error?.message !== '尚未連結同步帳號') {
      console.warn('[bvw] Failed to synchronize on startup', error);
    }
  });
});
