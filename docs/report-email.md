# 學員報告 Email 設定（Gmail SMTP）

學員每次完成當週記錄、報告產生後，系統會自動把報告寄到他們的信箱。
第 4、8 週則是教練在後台按「發布給學員」的當下才寄。

信件內容是**排版好的報告全文 + 一個「看完整報告（含圖表）」的連結**，
不是 PDF 附件——原因見下方「為什麼不寄 PDF 附件」。

---

## 設定步驟（約 5 分鐘）

用 Gmail 自己的 SMTP 寄信，**不需要自有網域、不需要改任何 DNS**。

### 1. 開啟兩步驟驗證

https://myaccount.google.com/security → 「兩步驟驗證」→ 開啟。

沒有開啟就無法產生應用程式密碼，這是 Google 的規定。

### 2. 產生應用程式密碼

https://myaccount.google.com/apppasswords

- 應用程式名稱隨便取，例如 `perma-coach`
- 產生後會顯示 **16 位英文字母**（像 `abcd efgh ijkl mnop`）
- **只會顯示這一次**，先複製起來

> 這不是你的 Gmail 登入密碼。它是一組專門給程式用的密碼，
> 隨時可以在同一頁撤銷，撤銷不影響你自己登入 Gmail。

### 3. 填進 Render 環境變數

https://dashboard.render.com → `perma-coach-api` → Environment：

| 變數名 | 值 | 必填 |
| --- | --- | --- |
| `GMAIL_ADDRESS` | `psybypsy01@gmail.com` | ✅ |
| `GMAIL_APP_PASSWORD` | 上一步的 16 位密碼（**空格可留可不留**） | ✅ |
| `REPORT_FROM_NAME` | 預設 `Ipsen Taiwan` | 選填 |
| `APP_BASE_URL` | 預設 `https://coach-roan-eta.vercel.app` | 選填 |

存檔後 Render 會自動重新部署。

**沒設定這兩個變數時系統完全不寄信**，但報告照常產生、網站照常運作——
所以可以先上線、之後再補設定。

---

## 收件人會看到什麼

寄件者顯示為 **`Ipsen Taiwan <psybypsy01@gmail.com>`**。

雖然位址是個人 Gmail，顯示名稱與信件內容一律是 Ipsen Taiwan 品牌，
不會出現 PSYbyPSY 字樣（品牌決定）。

## 用量限制

免費 Gmail 帳號每天最多 **500 封**。

實際用量：20 位學員 × 每週 1 封 = 每週 20 封，完全不會碰到上限。

---

## 為什麼不寄 PDF 附件

目前 PDF 是在**瀏覽器**產生的（`src/lib/exportPdf.ts` 用 html2pdf，需要 DOM 才能畫圖表）。
後端是 Python、沒有瀏覽器，要自動產 PDF 附件就得在 Python 重寫一整套圖表產生程式。

那會變成兩套實作，日後必然走鐘，與本專案「教練端看到的與學員收到的必須一致」
的原則直接衝突（見 `src/components/ReportChart.tsx` 的共用設計）。

所以改為信件直接放報告全文，圖表則透過連結在網站上看；
學員想要 PDF 可以在報告頁自行下載。

---

## 之後若要改用自有網域寄信

若想讓寄件者變成 `report@psybypsy.com` 這種比較正式的位址，
需要改用 Resend／SendGrid 之類的服務，並在網域的 DNS（目前 `psybypsy.com` 由 GoDaddy 代管）
加上該服務提供的驗證紀錄。

程式端只需要替換 `backend/app.py` 的 `_send_via_gmail()`，
信件內容產生（`backend/report_email.py`）完全不用動。

---

## 相關程式碼

- `backend/report_email.py` — 信件 HTML 產生（純函式，所有插入內容都經 `html.escape`）
- `backend/app.py` 的 `_send_via_gmail()` / `_email_report()` — 實際寄送
- `POST /api/coach/publish-report` — 教練發布第 4／8 週報告時觸發寄信
- `member_reports.emailed_at` — 已寄出的時間戳，避免重複寄送
