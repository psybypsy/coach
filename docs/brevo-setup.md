# 報告寄信設定（Brevo）

## 為什麼用 Brevo

Render **免費方案封鎖所有對外 SMTP 連接埠**（25／465／587），這是平台層級的防火牆，
用來防止免費機器被拿去發垃圾信（[Render 官方公告](https://render.com/changelog/free-web-services-will-no-longer-allow-outbound-traffic-to-smtp-ports)）。

封包被靜靜丟掉，所以 `smtplib` 的症狀是**逾時**（`TimeoutError: timed out`），
而不是「連線被拒」或「密碼錯誤」——這也是為什麼 Anthropic／Supabase／OpenAI 全都正常，
它們走 443，只有 SMTP 那三個埠被擋。**調長 timeout、加重試都沒有用**，防火牆不會因為多試幾次就放行。

Brevo 的寄信是 HTTP API（`api.brevo.com`，443 埠），完全不碰 SMTP 埠。
免費方案每天 300 封，以目前學員規模綽綽有餘，而且只要一把 API key，
不必像 Gmail API 那樣去 Google Cloud 建專案、設同意畫面、跑 OAuth 流程。

---

## 設定步驟（約 5 分鐘）

### 1. 註冊 Brevo

到 [brevo.com](https://www.brevo.com/) 用 Email 註冊免費帳號。不需要信用卡。

### 2. 驗證寄件地址

左側 **Senders, Domains & Dedicated IPs** → **Senders** → **Add a sender**，
填入要當寄件者的 Gmail 位址（`psybypsy01@gmail.com`）與顯示名稱。

Brevo 會寄一封確認信到那個信箱，**點裡面的連結完成驗證**。沒驗證的話寄信會回
`400 sender is not valid`。

### 3. 產生 API key

左側頭像選單 → **SMTP & API** → **API Keys** 分頁 → **Generate a new API key**。
取個名字（例如 `perma-coach`），複製產生的字串（`xkeysib-` 開頭）。

> ⚠️ 這把 key 只會顯示一次，關掉就看不到了，請先貼到安全的地方。
> 它等同於「可以用你的帳號寄信」的權限，不要 commit 進 Git、不要貼在聊天群組。

### 4. 設進 Render

Render 主控台 → 你的 service → **Environment** → 加入：

| 變數 | 值 |
|---|---|
| `BREVO_API_KEY` | 步驟 3 複製的那把 key |
| `REPORT_FROM_EMAIL` | 步驟 2 驗證過的寄件位址（若跟 `GMAIL_ADDRESS` 一樣可以不設） |

存檔後 Render 會自動重新部署。**不用刪 `GMAIL_*` 的變數**——程式碼的管道優先序是
Brevo → Gmail API → Gmail SMTP，設了 `BREVO_API_KEY` 就會走 Brevo，其餘留著當備援。

---

## 驗證有沒有成功

讓測試帳號填完一週的五題，然後到 Supabase SQL Editor 查：

```sql
select week_number, status, emailed_at, email_error
from member_reports mr join auth.users u on u.id = mr.user_id
where u.email = '你的測試帳號@gmail.com'
order by week_number desc;
```

- `emailed_at` 有值、`email_error` 是 `null` → 成功寄出。
- `email_error` 有值 → 裡面會寫明失敗原因（含 Brevo 回傳的原始訊息）。

**先前失敗的週次會自動補寄**：報告頁重新載入時會重試那些「已發布但沒寄成功」的週次，
不需要手動處理，也不會重複花錢重跑 AI 分析。

Brevo 後台的 **Transactional → Logs** 也看得到每封信的投遞狀態（已送達／開啟／退信）。

---

## ⚠️ 收不到信、或信進了垃圾信匣

這是這個方案**已知的取捨**，不是設定錯誤。

從 `@gmail.com` 的位址經由 Brevo 寄信，SPF／DKIM 無法對齊——因為 Brevo 的伺服器
不在 gmail.com 的授權寄件清單裡。gmail.com 的 DMARC 政策是 `p=none`，所以信**不會被退回**，
但收件方（尤其 Gmail、Yahoo）可能判定成垃圾信，或在寄件者旁顯示「via brevo.com」。

自 2024 年 2 月起 Gmail／Yahoo 收緊了寄件者驗證要求，
[Brevo 官方也建議](https://help.brevo.com/hc/en-us/articles/14925263522578-Comply-with-Gmail-Yahoo-and-Microsoft-s-requirements-for-email-senders)綁定自有網域。

**如果實際遇到投遞問題，處理順序：**

1. 先請學員檢查垃圾信匣，並把寄件者加入聯絡人（治標，但立即有效）。
2. 真正的解法是**買一個網域**（約 NT$400/年），在 Brevo 完成 **Domain Authentication**
   （加幾筆 DNS 的 TXT／CNAME 紀錄）。之後信從 `@你的網域` 寄出，SPF／DKIM 完全對齊，
   投遞率跟一般商業信件一樣，而且比 `@gmail.com` 更符合 Ipsen Taiwan 的品牌形象。
3. 另一條路是改走 Gmail API（免費、DKIM 天然對齊，因為信真的從 Gmail 伺服器出去），
   程式碼已經寫好了，只差 Google Cloud 那邊的設定——見 [gmail-api-setup.md](gmail-api-setup.md)。

---

## 其他可能遇到的狀況

| 症狀 | 原因與處理 |
|---|---|
| `400 sender is not valid` | 寄件位址還沒在 Brevo 完成驗證，或 `REPORT_FROM_EMAIL` 跟驗證過的位址不一致。 |
| `401 unauthorized` | API key 錯或被刪掉了，重新產生一把。 |
| `402` / 額度用罄 | 免費方案每天 300 封。正常用量不會碰到，除非補寄迴圈異常。 |
| 又出現 `TimeoutError` | 代表還在走 SMTP——`BREVO_API_KEY` 沒設到或拼錯，檢查 Render 的環境變數。 |
