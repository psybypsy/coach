# 交接筆記：教練版網站（陳郁敏老師版）

> 這份文件是給**新的 Claude 對話／帳號**接手用的。把這個資料夾（`perma-coach`）打開，
> 貼上這份文件的內容，或直接請 Claude 讀取 `docs/handoff.md` 和 `docs/coach-edition-從零架站計畫書.md`，
> 就能延續原本的討論脈絡，不需要重新解釋一次。

---

## 一句話說明專案

幫陳郁敏老師（企業教練）做一個獨立的網頁版平台，服務一個 10 人封閉小社群（9 位企業成員＋老師本人）。
核心功能：PERMA 五題書寫（可打字或語音輸入）→ 發布到社群 → 每週 AI 分析。
風格調性沿用 PSY by PSY 的 MindGym App（暖色系、手寫感）。**這是網頁版，不是 App。**

完整規格與資料庫設計，請看同資料夾的 [`coach-edition-從零架站計畫書.md`](./coach-edition-從零架站計畫書.md)——那份是主要的架構藍圖，這份 handoff 只補充「目前做到哪、已經決定什麼」。

---

## 已經確認的決定（不用再問使用者一次）

1. **私人書寫教練可見**：成員選「只留給自己」的內容不會進社群牆，但陳郁敏老師（coach 角色）看得到全部。寫作頁 UI 要明確告知「你的教練可以看到所有書寫內容」。
2. **允許刪除已發布貼文**：成員可以刪除自己發布過的貼文，RLS 已經開放這個權限。
3. **帳號結構（重要，這樣做才不會又卡在憑證問題）**：
   - **GitHub**：沿用現有的 `PSY-by-PSY` organization（MindGym 也放在這裡：`github.com/PSY-by-PSY/MindGym`），只是在裡面另開一個新 repo（建議名稱 `perma-coach`），**不要新開 GitHub 帳號**——本機已經對這個帳號設好推送權限，重開帳號只會製造憑證麻煩。
   - **Vercel**：開全新帳號，用 `psybypsy01@gmail.com` 註冊，跟公司/個人帳號分開，避免額度衝突。
   - **Render**：同樣開全新帳號，同一信箱。
   - **原因**：使用者提到個人 Vercel 快滿額、個人 Render 帳號不是專案用的帳號，容易混亂；用戶信箱是 `psybypsy01@gmail.com`。
4. **網域**：先用 psybypsy 子網域上線（例如 `xxx.vercel.app` 或之後接 `perma.psybypsy.com`），之後若要做成教練自有品牌再花約 $12/年買獨立網域——Vercel 換網域不影響任何資料，不用現在卡住。
5. **不換技術棧**：完全沿用 MindGym 現有的 Vite + React + TypeScript + Tailwind + TanStack Router（前端）／FastAPI（後端）／Supabase（資料庫＋登入），只是開四個全新的獨立專案（新 repo、新 Supabase 專案、新 Vercel 專案、新 Render 服務），不共用資料庫，不影響 MindGym。

---

## 目前的實作進度

專案位置：`/Users/ongcien/Desktop/Claude PSYbyPSY/GitHub/perma-coach`（跟 MindGym 同一層的資料夾，兄弟目錄，各自獨立的 git repo）。

已完成（Step 2 前半，對照計畫書第 5 章）：

- [x] `npm create vite@latest perma-coach -- --template react-ts` 建立骨架
- [x] 安裝套件：`@supabase/supabase-js`、`@tanstack/react-router`、`tailwindcss@3`、`autoprefixer`、`postcss`、router 相關 devDependencies
- [x] 複製並簡化 `tailwind.config.js`（沿用 MindGym 色票變數系統）
- [x] 複製並簡化 `vite.config.ts`（拿掉 PWA/Capacitor，只留 TanStack Router + React plugin）
- [x] 複製並簡化 `src/index.css`（暖色系 CSS 變數、字型、動畫，拿掉原生 App 專屬的 `.native-app` 區塊）
- [x] 建立 `src/lib/supabase.ts`（client 初始化，跟 MindGym 一致）
- [x] 建立 `src/lib/perma.ts`（PERMA 五題、hints、五維度配色，從 MindGym 的 `src/components/pretest/types.ts` 搬過來並改名，因為這裡是「日記框架」不是「測驗」）
- [x] 建立最小可跑的 TanStack Router 骨架：`src/routes/__root.tsx`、`src/routes/index.tsx`（暫時的首頁，顯示五個 PERMA 卡片，之後會被登入/書寫頁取代）
- [x] `.env.example`、`vercel.json`、`.gitignore`（含排除 `.env`）
- [x] 本機驗證通過：`npm run dev` 在瀏覽器截圖確認畫面正確（暖色卡片、字型、配色都對）；`npm run build` 建置成功無錯誤
- [x] `git init` 完成，`git add -A` 已 staged，**尚未 commit**（依照使用者規矩：commit/push 前一定要先問過使用者）
- [x] 在 MindGym 的 `.claude/launch.json` 加了一個 `perma-coach-dev` 設定（跑在 port 5174），方便之後用瀏覽器預覽 perma-coach（因為 Claude Code 的 preview 工具目前只認得主要工作目錄底下的 launch.json）

尚未開始（對照計畫書第 5 章 Step 3 之後）：

- [ ] Supabase 專案還沒建（等使用者提供 URL / anon key / service_role key）
- [ ] GitHub repo 還沒建（等使用者在 `PSY-by-PSY` org 開好 `perma-coach` repo）
- [ ] Vercel / Render 帳號還沒開（使用者正在處理）
- [ ] 登入流程（Magic Link）
- [ ] 書寫頁（PERMA 五題＋語音輸入）
- [ ] 社群牆
- [ ] 後端 FastAPI（`/api/transcribe`、`/api/weekly-review`）
- [ ] 教練儀表板
- [ ] 部署上線

---

## 交給使用者的待辦事項（使用者正在處理，帳號建立我無法代勞）

1. 到 GitHub `PSY-by-PSY` org 開一個新的 **private repo**，名稱建議 `perma-coach`（先開空的，不用勾任何初始化選項）。
2. 到 [vercel.com](https://vercel.com) 用 `psybypsy01@gmail.com` 註冊新帳號。
3. 到 [render.com](https://render.com) 用同一信箱註冊新帳號。
4. 到 [supabase.com](https://supabase.com) 建新專案（區域選 Tokyo），把 Project URL、anon key、service_role key 交給接手的 Claude。

---

## 給接手的 Claude 的操作提醒

- 使用者的偏好（已存在其 memory，若換帳號記得問清楚或直接照做）：
  - **commit/push 前一定要先問過使用者**，不要自己決定推送。
  - **主動幫使用者開新分支**做新工作，但 commit/push 仍要確認。
  - **UI 不用 emoji**，用現有 SVG 圖示或色點取代。
  - **文案不得出現「心理諮商」「心理治療」字眼**，一律用「心理諮詢」（《心理師法》法遵紅線）。
- 使用者是非工程背景，需要**逐步、白話**的教學式操作指引，不要假設他懂術語。
- 一旦使用者給了 GitHub repo 網址，把本機 `perma-coach` 的 git remote 設好並詢問是否要 commit + push。
- 一旦使用者給了 Supabase 金鑰，先建資料庫（計畫書第 2 章整段 SQL），再接登入頁。
- 後續開發順序照計畫書第 5 章 Step 3 → Step 10 走。
