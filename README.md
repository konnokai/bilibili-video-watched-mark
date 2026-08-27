# Bilibili 觀看進度標記

Chrome Manifest V3 擴充功能。它會在一般 Bilibili `BV` 影片頁保存各分 P 的播放位置，並在影片縮圖底部顯示最近觀看分 P 的進度。

## 本機載入

1. 開啟 `chrome://extensions`。
2. 啟用「開發人員模式」。
3. 選擇「載入未封裝項目」，指定本專案目錄。

本機追蹤不需要後端。資料保存在擴充功能的 `chrome.storage.local`，移除擴充功能時會一併清除。

## 已實作

- 一般 `BV` 影片與分 P 識別；播放頁若顯示 `av` 網址，會由 canonical link 取得 BVID。
- 播放中定期保存，並在暫停、結束、切頁或隱藏頁面時補存。
- 同一分 P 看完後維持完成狀態。
- 首頁、搜尋、動態、空間、熱門與影片推薦等含 BV 縮圖的桌面頁面進度條。
- 手動匯入目前登入帳號的 Bilibili 一般投稿影片歷史。
- Workers + D1 同步 API，使用隨機同步碼驗證，不以公開 UID 當密碼。

## 開發

```powershell
npm test
npm run check
```

## 同步 API

`server/` 提供下列端點。除了建立帳號外，其餘端點都需要 `Authorization: Bearer <同步碼>`。

| 方法 | 路徑 | 用途 |
| --- | --- | --- |
| `POST` | `/v1/accounts` | 以 Bilibili UID 建立同步帳號，回傳只顯示一次的同步碼 |
| `GET` | `/v1/account` | 確認同步碼及帳號資訊 |
| `GET` | `/v1/progress` | 依 `nextCursor` 分頁取得分 P 進度 |
| `PUT` | `/v1/progress` | 批次合併本機進度 |
| `DELETE` | `/v1/account` | 刪除帳號及所有雲端進度 |

同步碼以 32 bytes 的加密安全亂數產生，D1 只保存 SHA-256 雜湊。UID 只作帳號標示，不具驗證能力。

```powershell
cd server
npm test
npm run typecheck
npx wrangler d1 migrations apply bilibili-video-watched-mark --local
npx wrangler deploy --dry-run
```

擴充功能尚未設定正式 Worker URL，因此目前不會自動上傳資料。公開部署前仍需替公開的帳號建立端點加入濫用防護。

## 參考

頁面涵蓋範圍參考 [Yiero_WebScripts 的 Bilibili 觀看標記腳本](https://github.com/AliubYiero/Yiero_WebScripts/tree/main/src/com/bilibili/bilibili-video-watch-sign)。本專案為獨立實作，未複製其原始碼。
