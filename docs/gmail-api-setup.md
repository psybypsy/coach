# 寄信改走 Gmail API（一次性設定）

## 為什麼要改

Render **免費方案封鎖所有對外 SMTP 連接埠**（25／465／587），這是平台層級的防火牆，
用來防止免費機器被拿去發垃圾信（[Render 官方公告](https://render.com/changelog/free-web-services-will-no-longer-allow-outbound-traffic-to-smtp-ports)）。

封包被靜靜丟掉，所以 `smtplib` 的表現是**逾時**（`TimeoutError: timed out`），
而不是「連線被拒」或「密碼錯誤」。這也解釋了為什麼 Anthropic／Supabase／OpenAI
的呼叫全都正常——它們走 443，只有 SMTP 那三個埠被擋。

**調長 timeout、加重試、換寫法都沒有用**，防火牆不會因為多試幾次就放行。

Gmail API 走 `https://gmail.googleapis.com`（443 埠），不在封鎖範圍內。
而且寄件仍然是經過 Gmail 本人的伺服器，DKIM／SPF 完全對齊，不會掉進垃圾信匣——
這是它比 Brevo／SendGrid 那類第三方服務好的地方（那些用 @gmail.com 當寄件者會對不齊）。

---

## 設定步驟

全部只需要做一次。用**寄件用的那個 Gmail 帳號**（`psybypsy01@gmail.com`）登入操作。

### 1. 建立 Google Cloud 專案並開啟 Gmail API

1. 到 [Google Cloud Console](https://console.cloud.google.com/)，建立一個新專案（例如 `perma-coach-mail`）。
2. 左側選單 →「API 和服務」→「程式庫」，搜尋 **Gmail API**，按「啟用」。

### 2. 設定 OAuth 同意畫面

1. 「API 和服務」→「OAuth 同意畫面」。
2. User Type 選 **外部（External）**——個人 Gmail 帳號只能選這個。
3. 填必填欄位（應用程式名稱、使用者支援電子郵件、開發人員聯絡資訊）即可。
4. 「範圍」那一步加入：`https://www.googleapis.com/auth/gmail.send`
   （只要寄信權限，不要讀信權限——權限越小越安全）。

> ### ⚠️ 這一步最容易踩雷：發布狀態一定要改成「正式版」
>
> 同意畫面若停在**「測試中」**，Google 會在 **7 天後自動撤銷 refresh token**，
> 信就會毫無預警地又寄不出去（錯誤訊息是 `invalid_grant`）。這是 Google 明文規定的行為：
> 「外部使用者類型且發布狀態為『測試中』的專案，發出的 refresh token 會在 7 天後失效」
> （[Google OAuth 2.0 文件](https://developers.google.com/identity/protocols/oauth2)）。
>
> 所以請在同意畫面頁面按 **「發布應用程式」**，把狀態改成 **「正式版 / In production」**。
>
> `gmail.send` 屬於「機密（sensitive）」範圍，不是「受限（restricted）」，
> 所以**不需要**做安全性稽核（那是 `gmail.readonly` 那類才要的）。
> 未通過驗證的正式版應用程式仍可使用，只是授權時會跳「Google 尚未驗證這個應用程式」的
> 警告畫面，點「進階」→「前往（不安全）」即可——這是你自己建的、只授權給自己用的應用程式。

### 3. 建立 OAuth 用戶端

1. 「API 和服務」→「憑證」→「建立憑證」→「OAuth 用戶端 ID」。
2. 應用程式類型選 **桌面應用程式（Desktop app）**。
   （選這個才能用 `http://localhost` 當回呼網址，不必自己架網站。）
3. 建立後會拿到 **Client ID** 和 **Client secret**，下一步要用。

### 4. 換出 refresh token

在自己的電腦上（不是在 Render 上）跑：

```bash
cd backend && python tools/get_gmail_refresh_token.py
```

它會請你貼上 Client ID／secret，開瀏覽器讓你授權，然後把三個環境變數印出來。

### 5. 設進 Render

Render 主控台 → 你的 service → **Environment** → 加入這三個變數：

| 變數 | 值 |
|---|---|
| `GMAIL_OAUTH_CLIENT_ID` | 步驟 3 的 Client ID |
| `GMAIL_OAUTH_CLIENT_SECRET` | 步驟 3 的 Client secret |
| `GMAIL_OAUTH_REFRESH_TOKEN` | 步驟 4 印出來的 refresh token |

`GMAIL_ADDRESS` 維持原樣（寄件者信箱）。存檔後 Render 會自動重新部署。

`GMAIL_APP_PASSWORD` **不用刪**——程式碼會優先走 Gmail API，只有在 OAuth 三個變數
沒設齊時才退回 SMTP（本機開發用得到，本機沒有埠封鎖問題）。

---

## 驗證有沒有成功

設好之後，讓學員（或自己的測試帳號）填完一週的五題。程式會在背景寄信，
並把結果寫進 `member_reports`。到 Supabase SQL Editor 查：

```sql
select week_number, status, emailed_at, email_error
from member_reports mr join auth.users u on u.id = mr.user_id
where u.email = '你的測試帳號@gmail.com'
order by week_number desc;
```

- `emailed_at` 有值、`email_error` 是 `null` → 成功寄出。
- `email_error` 有值 → 裡面會寫明失敗原因（現在會直接指出是不是埠被封鎖）。

**先前失敗的週次會自動補寄**：報告頁重新載入時會重試那些
「已發布但沒寄成功」的週次，不需要手動處理，也不會重複花錢重跑 AI 分析。

---

## 之後可能遇到的狀況

| 症狀 | 原因與處理 |
|---|---|
| `invalid_grant` | refresh token 失效。九成是同意畫面還停在「測試中」（7 天到期），改成「正式版」後重跑步驟 4。改過 Google 密碼、或在[帳戶權限頁](https://myaccount.google.com/permissions)移除授權也會這樣。 |
| 腳本說沒拿到 refresh token | 這個帳號先前授權過。到 [帳戶權限頁](https://myaccount.google.com/permissions)移除後重跑。 |
| `403 Gmail API has not been enabled` | 步驟 1 的 Gmail API 沒啟用，或啟用後還沒生效（等一兩分鐘）。 |
| 又出現 `TimeoutError` | 代表還在走 SMTP——三個 `GMAIL_OAUTH_*` 變數沒設齊，檢查有沒有拼錯或漏設。 |

Gmail 免費帳號每天約可寄 500 封，以目前的學員規模綽綽有餘。
