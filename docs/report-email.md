# 學員報告 Email 設定（Gmail SMTP）

> ⚠️ **這份文件的 SMTP 設定只適用於本機開發。**
> 正式環境（Render 免費方案）封鎖所有對外 SMTP 連接埠，SMTP 一定會逾時，
> 寄信改走 HTTP API——設定步驟見 **[brevo-setup.md](brevo-setup.md)**。
>
> 另外本文下方「為什麼不寄 PDF 附件」的結論已經過時：目前實際上**有**寄 PDF 附件
> （後端用 reportlab 產生，含雷達圖／主題占比圓餅圖／情緒詞雲）。

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

## 信件內容：短信 + PDF 附件

信件本文是教練提供的固定短文（`_weekly_email_html()`），報告本身以 **PDF 附件**寄出。

PDF 由後端的 reportlab 產生（`_build_weekly_report_pdf()`，字型是 `backend/assets/fonts/NotoSansTC-Regular.ttf`），
含雷達圖（T0 vs 本週）、主題占比圓餅圖與情緒詞雲——全部在 Python 畫，不需要瀏覽器。

> 註：這與本文件早期版本的說明相反。當時後端還沒有 PDF 能力，只能把報告全文放進信裡；
> PR #11 補上 reportlab 之後就改成附件了。網站上仍然看得到同一份報告，信裡也附了連結。

寄信與教練後台的「預覽學員收到的內容」共用同一組函式
（`_weekly_email_html()` / `_build_weekly_report_pdf()`），所以教練預覽到的就是學員收到的。

---

## 什麼時候會寄

| 週次 | 行為 |
|---|---|
| 1、2、3、5、6、7 | 產生即發布，**自動寄出**，教練不介入 |
| 4、8 | 只產生草稿（`pending_coach`），學員看不到、不寄信；教練在後台確認後按「發布給學員」才寄 |

寄送失敗（沒設定 Gmail、拿不到 email、PDF 產生失敗、SMTP 錯誤）一律不影響主流程，
原因會寫進 `member_reports.email_error`，教練在後台看得到。

---

## 之後若要改用自有網域寄信

若想讓寄件者變成 `report@psybypsy.com` 這種比較正式的位址，
需要改用 Resend／SendGrid 之類的服務，並在網域的 DNS（目前 `psybypsy.com` 由 GoDaddy 代管）
加上該服務提供的驗證紀錄。程式端只需要替換 `backend/app.py` 的 `_send_report_mail()`。

---

## 相關程式碼

- `backend/app.py` 的 `_weekly_email_subject()` / `_weekly_email_html()` — 信件主旨與內文（教練提供的模板；插入內容都經 `html.escape`）
- `backend/app.py` 的 `_build_weekly_report_pdf()` — PDF 附件（reportlab，含三張圖表）
- `backend/app.py` 的 `_send_report_mail()` / `_email_report()` — 實際寄送
- `backend/app.py` 的 `_ensure_member_report()` — 產生報告的共用進入點（三個觸發點共用，具冪等性）
- `POST /api/coach/report-completed-webhook` — Supabase Database Webhook，伺服器端自動觸發
- `POST /api/coach/publish-report` — 教練發布第 4／8 週報告時觸發寄信
- `POST /api/coach/weekly-reports/preview` — 教練預覽學員會收到的信與 PDF
- `member_reports.emailed_at` / `email_content_hash` / `email_error` — 寄送狀態（見遷移 010）
