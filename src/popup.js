const videoCount = document.querySelector('#video-count');
const partCount = document.querySelector('#part-count');
const importButton = document.querySelector('#import-history');
const clearButton = document.querySelector('#clear-local');
const message = document.querySelector('#message');
const syncUnlinked = document.querySelector('#sync-unlinked');
const syncLinked = document.querySelector('#sync-linked');
const bilibiliUid = document.querySelector('#bilibili-uid');
const connectSyncCode = document.querySelector('#connect-sync-code');
const currentSyncCode = document.querySelector('#current-sync-code');
const syncAccount = document.querySelector('#sync-account');
const lastSynced = document.querySelector('#last-synced');
const createSyncButton = document.querySelector('#create-sync');
const connectSyncButton = document.querySelector('#connect-sync');
const copySyncCodeButton = document.querySelector('#copy-sync-code');
const syncNowButton = document.querySelector('#sync-now');
const disconnectSyncButton = document.querySelector('#disconnect-sync');
const deleteSyncButton = document.querySelector('#delete-sync');

async function sendMessage(payload) {
  const response = await chrome.runtime.sendMessage(payload);
  if (!response?.ok) throw new Error(response?.error || '背景程序沒有回應');
  return response;
}

async function refreshStatus() {
  const status = await sendMessage({ type: 'GET_LOCAL_STATUS' });
  videoCount.textContent = String(status.videoCount);
  partCount.textContent = String(status.partCount);
}

async function refreshSyncStatus() {
  const status = await sendMessage({ type: 'GET_SYNC_STATUS' });
  syncUnlinked.hidden = status.linked;
  syncLinked.hidden = !status.linked;
  if (!status.linked) return;

  syncAccount.textContent = `已連結 Bilibili UID ${status.bilibiliUid}`;
  currentSyncCode.value = status.syncCode;
  lastSynced.textContent = status.lastSyncedAt
    ? `上次同步：${new Date(status.lastSyncedAt).toLocaleString()}`
    : '尚未完成第一次同步';
}

async function runAction(button, action) {
  button.disabled = true;
  message.textContent = '';
  try {
    await action();
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    button.disabled = false;
  }
}

importButton.addEventListener('click', () => runAction(importButton, async () => {
  const granted = await chrome.permissions.request({
    origins: ['https://api.bilibili.com/*'],
  });
  if (!granted) throw new Error('未允許讀取 Bilibili 歷史紀錄');

  message.textContent = '正在逐頁匯入...';
  const result = await sendMessage({ type: 'IMPORT_BILIBILI_HISTORY' });
  await refreshStatus();
  message.textContent = `UID ${result.uid}，已處理 ${result.imported} 筆分 P 紀錄。`;
}));

clearButton.addEventListener('click', () => runAction(clearButton, async () => {
  if (!confirm('確定要清除這台裝置上的所有觀看進度嗎？')) return;
  await sendMessage({ type: 'CLEAR_LOCAL_PROGRESS' });
  await refreshStatus();
  message.textContent = '本機觀看進度已清除。';
}));

createSyncButton.addEventListener('click', () => runAction(createSyncButton, async () => {
  const result = await sendMessage({
    type: 'CREATE_SYNC_ACCOUNT',
    bilibiliUid: bilibiliUid.value,
  });
  await Promise.all([refreshStatus(), refreshSyncStatus()]);
  message.textContent = `同步碼已建立並完成同步。請保存：${result.config.syncCode}`;
}));

connectSyncButton.addEventListener('click', () => runAction(connectSyncButton, async () => {
  await sendMessage({
    type: 'CONNECT_SYNC_ACCOUNT',
    syncCode: connectSyncCode.value,
  });
  connectSyncCode.value = '';
  await Promise.all([refreshStatus(), refreshSyncStatus()]);
  message.textContent = '同步碼已連結並完成同步。';
}));

copySyncCodeButton.addEventListener('click', () => runAction(copySyncCodeButton, async () => {
  await navigator.clipboard.writeText(currentSyncCode.value);
  message.textContent = '同步碼已複製。';
}));

syncNowButton.addEventListener('click', () => runAction(syncNowButton, async () => {
  const result = await sendMessage({ type: 'SYNC_NOW' });
  await Promise.all([refreshStatus(), refreshSyncStatus()]);
  message.textContent = `同步完成：上傳 ${result.sync.uploaded} 筆，下載 ${result.sync.downloaded} 筆。`;
}));

disconnectSyncButton.addEventListener('click', () => runAction(disconnectSyncButton, async () => {
  if (!confirm('解除這台裝置的同步連結？雲端資料不會刪除。')) return;
  await sendMessage({ type: 'DISCONNECT_SYNC_ACCOUNT' });
  await refreshSyncStatus();
  message.textContent = '已解除這台裝置的同步連結。';
}));

deleteSyncButton.addEventListener('click', () => runAction(deleteSyncButton, async () => {
  if (!confirm('確定要永久刪除同步帳號與所有雲端進度嗎？')) return;
  await sendMessage({ type: 'DELETE_SYNC_ACCOUNT' });
  await refreshSyncStatus();
  message.textContent = '雲端同步資料已刪除。本機紀錄仍保留。';
}));

Promise.all([refreshStatus(), refreshSyncStatus()]).catch((error) => {
  message.textContent = error instanceof Error ? error.message : String(error);
});
