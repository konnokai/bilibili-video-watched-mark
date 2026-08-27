const videoCount = document.querySelector('#video-count');
const partCount = document.querySelector('#part-count');
const importButton = document.querySelector('#import-history');
const clearButton = document.querySelector('#clear-local');
const message = document.querySelector('#message');

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

refreshStatus().catch((error) => {
  message.textContent = error instanceof Error ? error.message : String(error);
});
