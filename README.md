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
- Workers + D1 雙向同步，使用隨機同步碼驗證，不以公開 UID 當密碼。

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

正式 API 網址為 `https://bvw-sync.konnokai.me`。擴充功能會在啟動、手動同步、匯入歷史，以及播放暫停、完成或離開頁面時同步。建立帳號端點依 Cloudflare 來源 IP 限制為每 10 秒一次。

## Cloudflare 自動部署

本 repo 可直接綁定 Cloudflare Workers Builds，不需要額外建立 GitHub Actions。

先在 Cloudflare 建立名為 `bilibili-video-watched-mark` 的 D1 database，並將它綁定為 `DB`。正式部署會先執行尚未套用的 migration，再部署 Worker，避免新程式先於資料庫 schema 上線。

Workers Builds 設定：

| 欄位 | 值 |
| --- | --- |
| Git repository | `konnokai/bilibili-video-watched-mark` |
| Production branch | `main` |
| Root directory | `/server` |
| Build command | `npm ci && npm test && npm run typecheck && npx wrangler types --check` |
| Deploy command | `npx wrangler d1 migrations apply bilibili-video-watched-mark --remote && npx wrangler deploy` |
| Non-production deploy command | `npx wrangler versions upload` |

Worker 名稱必須與 `server/wrangler.jsonc` 的 `name` 相同：`bilibili-video-watched-mark-api`。

目前使用專用的 `bilibili-video-watched-mark-api build token`。它包含 Workers Scripts 與 D1 編輯權限。

## 參考

頁面涵蓋範圍參考 [Yiero_WebScripts 的 Bilibili 觀看標記腳本](https://github.com/AliubYiero/Yiero_WebScripts/tree/main/src/com/bilibili/bilibili-video-watch-sign)。本專案為獨立實作，未複製其原始碼。
