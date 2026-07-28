# PSY by PSY Coach

Tan Yee Ming（陳郁敏）教練的職場幸福感書寫平台。PERMA 五題書寫（文字／語音）→ 發布到社群 → AI 每週個人幸福報告。

> 最後更新：2026-07-22

技術棧：Vite + React + TypeScript + Tailwind CSS + TanStack Router（前端）／FastAPI（後端）／Supabase（資料庫＋登入）。

## 上線網址

- 前端（給教練＋成員用）：https://coach-roan-eta.vercel.app
- 後端 API：https://perma-coach-api.onrender.com（免費方案，閒置後喚醒約需 50 秒）
- GitHub：https://github.com/psybypsy/coach
- 所有服務（GitHub / Vercel / Render / Supabase）都掛在 `psybypsy01@gmail.com` 這個帳號底下，跟舊的 PSY-by-PSY 團隊帳號完全分開。

---

## 環境需求

- [Node.js](https://nodejs.org)(LTS 版本)
- [Git](https://git-scm.com)
- （只有要碰後端／語音轉文字／AI 分析的人才需要）[Python 3.11+](https://www.python.org/downloads/)

---

## 第一次上手：前端

```bash
git clone https://github.com/psybypsy/coach.git
cd coach
npm install
cp .env.example .env
npm run dev
```

瀏覽器打開終端機顯示的網址（通常是 `http://localhost:5173`）。

`.env.example` 裡已經填好 Supabase 的網址跟 **anon key**——這把 key 設計上就是公開的（前端程式碼裡本來就看得到），安全性是靠資料庫的 RLS 權限規則把關，不是靠隱藏這把 key，所以直接複製貼上即可，不需要另外跟人要。

---

## 第一次上手：後端（只有要跑語音轉文字／AI 週分析的人需要）

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

接著打開 `backend/.env`，填入以下三個值——**這些是機密資訊，不會放在 GitHub 上，也不會寫在這份文件裡，請跟專案負責人直接要（用私訊或密碼管理工具傳，不要貼在群組裡）**：

| 變數 | 說明 | 去哪裡拿 |
|---|---|---|
| `ANTHROPIC_API_KEY` | AI 週分析用 | [console.anthropic.com](https://console.anthropic.com) |
| `OPENAI_API_KEY` | 語音轉文字（Whisper）用 | [platform.openai.com](https://platform.openai.com/api-keys) |
| `SUPABASE_SERVICE_ROLE_KEY` | 後端寫入資料庫用（權限極高，絕對不能外流） | Supabase 專案 → Settings → API Keys |
| `BREVO_API_KEY` | **正式環境寄信必填**：走 Brevo HTTP API（443 埠），免費 300 封/天 | 見 [docs/brevo-setup.md](docs/brevo-setup.md) |
| `GMAIL_ADDRESS` | 寄報告信用的 Gmail 位址（不需自有網域、不必設 DNS） | 教練的 Gmail |
| `GMAIL_APP_PASSWORD` | 本機開發用；Google「應用程式密碼」，**不是登入密碼** | Google 帳號 → 安全性 |
| `REPORT_WEBHOOK_SECRET` | 驗證 Supabase journal_posts Database Webhook；請使用長隨機字串 | 自行產生並同時設在 Render 與 Webhook header |

`SUPABASE_URL` 已經幫你填好了，不用改。寄信管道全都沒設定時完全不寄信，其餘功能照常運作。

> ⚠️ **正式環境不能用 SMTP。** Render 免費方案封鎖所有對外 SMTP 連接埠（25／465／587），
> `smtplib` 一定會以 `TimeoutError` 收場，調長 timeout 或重試都沒有用。
>
> 寄信管道的優先序是 **Brevo → Gmail API → Gmail SMTP**，前兩條都走 HTTPS 443 不受封鎖影響：
> - **Brevo**（正式環境採用）—— 只要一把 API key，設定見 [docs/brevo-setup.md](docs/brevo-setup.md)
> - **Gmail API**（備援，程式碼已就緒）—— DKIM 天然對齊、投遞率最好，但要跑 Google Cloud
>   的 OAuth 設定，見 [docs/gmail-api-setup.md](docs/gmail-api-setup.md)

**每週報告自動產生與寄送**：在 Supabase 建立 `journal_posts` 的 Database Webhook（INSERT、UPDATE），
URL 指向 `https://<render-domain>/api/coach/report-completed-webhook`，並加入
`X-Report-Webhook-Secret: <REPORT_WEBHOOK_SECRET>` header。每當某一週的 P／E／R／M／A
五欄完整提交，系統就產生一份只看該週、並與 T0 比較的報告：

- **第 1、2、3、5、6、7 週** —— 直接發布給學員，並用 Brevo 寄出信件＋PDF 附件（後端 reportlab 產生，含雷達圖／主題占比圓餅圖／情緒詞雲）。教練不需要介入。
- **第 4、8 週** —— 只產生草稿（`pending_coach`），學員看不到也不寄信，等教練在後台編輯確認後按「發布給學員」才寄出。

webhook 是伺服器端觸發，不受學員關閉分頁影響；前端的 `/api/member/report` 與報告頁的
「產生我的報告」是同一支冪等函式的另外兩個入口，重複觸發不會產生兩份。

填完後啟動：

```bash
uvicorn app:app --reload --port 8000
```

`/healthz` 打得通（`http://localhost:8000/healthz` 回傳 `{"ok":true}`）就代表成功。

---

## Git 協作流程

1. 開工前先拿最新版本：
   ```bash
   git pull
   ```
2. 開一個新分支做修改（不要直接改 `main`）：
   ```bash
   git checkout -b 你的名字-這次要做的事
   ```
3. 改完後：
   ```bash
   git add .
   git commit -m "說明這次改了什麼"
   git push -u origin 你的名字-這次要做的事
   ```
4. 到 [GitHub](https://github.com/psybypsy/coach) 開一個 **Pull Request**，等 review 過再合併進 `main`——避免大家同時改同一份程式碼互相覆蓋。

### 重要：關於自動部署

前端（Vercel）是免費方案，**只有專案帳號本人（psybypsy01@gmail.com）的 commit 才會自動觸發部署**，其他協作者 push 的 commit 會被 Vercel 擋下（顯示 "Deployment Blocked"）。

所以：
- 大家還是照常開分支、push、開 PR。
- 但**合併 PR 到 `main` 這個動作，請由 psybypsy01@gmail.com 本人在 GitHub 網頁上點「Merge」**，這樣合併出來的 commit 才會被 Vercel 認可、自動部署上線。
- 如果不是本人合併、部署被擋下了，去 Vercel Dashboard 手動點 Redeploy 也沒用（一樣會被擋），只能請本人重新用她自己的帳號 push 一次（例如空 commit）。

後端（Render）沒有這個限制，任何人 push 到 `main` 都會正常觸發部署。

---

## 邀請新協作者（只有專案負責人需要做）

1. **GitHub**：到 [github.com/psybypsy/coach/settings/access](https://github.com/psybypsy/coach/settings/access) →「Add people」→ 輸入對方 GitHub 帳號 → 對方會收到邀請信，要自己點「接受」才算完成。沒接受之前對方的電腦沒辦法 `git push`。
2. **App 登入白名單**：Perma-Coach 用 email 白名單 + Magic Link 登入，新成員的 email 要先加進 Supabase 資料庫的 `allowed_emails` 這張表，才能收到登入信。去 Supabase Dashboard → SQL Editor 執行：
   ```sql
   -- 一般成員（role 預設就是 'member'，可省略）
   insert into allowed_emails (email, note) values ('對方的email@example.com', '顯示名稱');
   -- 教練帳號（能看到全部成員的教練儀表板）
   insert into allowed_emails (email, role, note) values ('教練email@example.com', 'coach', '顯示名稱');
   ```
3. 協作者的登入方式不需要密碼——輸入 email、收信、點連結即可，不需要另外開帳號。

---

## 專案結構

```
src/                前端原始碼
  routes/           頁面（TanStack Router 檔案式路由）
  lib/               共用邏輯（Supabase client、PERMA 題目、i18n 字典）
  components/        共用元件
backend/             FastAPI 後端（語音轉文字、AI 週分析）
supabase/schema.sql  資料庫結構存底（實際套用在 Supabase Dashboard 執行）
```

## 風格規範

- 視覺調性：專業、簡潔，不用可愛風／手寫字體
- UI 不使用 emoji，一律用 SVG 圖示
- 文案不得出現「心理諮商」「心理治療」字眼，統一用「心理諮詢」（法遵要求）
