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

## ⚠️ 先看這段：兩個新帳號一定會撞到的關卡

實測（2026-07-28）依序撞到三個問題，**照順序處理才不會白忙**：

1. **IP 封鎖**（`401 unrecognised IP address`）—— 2024/5/16 之後開的帳號預設開啟。
   到 **Settings → Security → Authorized IPs**，在 `API keys` 那一列按 **Deactivate for API keys**。
   > 注意這跟「停用 API key 本身」是兩個不同的東西，Brevo 介面上長很像，很容易按錯。
   > 驗收：SMTP & API 頁上方的橫幅要變成 "Unauthorized IP addresses are **not** blocked"。
   >
   > 為什麼要整個關掉而不是把 IP 加白名單：Render 用的是[跟其他客戶共用的浮動 IP 範圍](https://render.com/docs/outbound-ip-addresses)，
   > 列不進白名單，就算列了範圍變動時信也會靜默斷掉。而且**只要授權任何一個 IP，就會自動啟用對其餘所有 IP 的封鎖**。

2. **帳號未開通 transactional**（`403 Your SMTP account is not yet activated`）——
   新帳號預設不能寄 transactional email，要開支援單請 Brevo 人工開通，**約 1–2 個工作天**，
   沒有自助按鈕。開單方式見下面步驟 4。

3. **只驗證單一寄件地址不夠** —— Brevo 實務上會要求先完成**網域驗證**才開通 transactional。
   所以下面直接走網域驗證，不要只加 sender。

---

## 設定步驟

### 1. 註冊 Brevo

到 [brevo.com](https://www.brevo.com/) 用 Email 註冊免費帳號。不需要信用卡。

### 2. 關掉 API 的 IP 封鎖

見上面第 1 點。**這步不做，後面每一步都會回 401，會很難判斷是哪裡錯。**

### 3. 驗證寄件網域（用 `psybypsy.com`）

本專案已擁有 `psybypsy.com`（GoDaddy 代管），且該網域目前**沒有 MX、沒有 SPF/TXT 紀錄**，
沒有在收發信，所以加 Brevo 的紀錄不會影響任何現有服務。

1. Brevo 左側 **Senders, Domains & Dedicated IPs** → **Domains** → **Add a domain**
2. 填 `psybypsy.com`
3. Brevo 會給幾筆 DNS 紀錄（`brevo-code` 的 TXT、DKIM 的 TXT/CNAME，可能還有 DMARC）
4. 到 [GoDaddy DNS 管理](https://dcc.godaddy.com/control/portfolio)照抄上去
5. 回 Brevo 按 **Verify**（DNS 生效通常幾分鐘，最久可能要幾小時）

> **寄件位址（2026-07-28 確認）**：`report@psybypsy.com`，顯示名稱 `Ipsen Taiwan`。
> PSYbyPSY 是公司／品牌名稱，用自己的網域寄信沒有問題。
> （`src/` 底下那條「網頁 UI 不出現 PSYbyPSY」的規則是講**頁面呈現**，跟寄件網域無關，
> 兩者不衝突。）

### 4. 開單請 Brevo 開通 transactional

網域驗證完成後，Brevo 右上角 **?** → **Support and Tickets** → 開單，內容講明：

> Requesting activation for **transactional email** (not marketing).
> Website: https://coach-roan-eta.vercel.app
> Sending domain: psybypsy.com (already verified in my account)
> Use case: weekly personal well-being report emails sent to enrolled coaching
> participants who signed up — one email per participant per week, with a PDF attachment.
> Expected volume: under 100 emails/month.

約 1–2 個工作天回覆。**開通前寄信一律回 `403 permission_denied`，這不是設定錯誤，是還在排隊。**

### 5. 產生 API key

左側頭像選單 → **SMTP & API** → **API keys & MCP** 分頁 → **Generate API key**。
取個名字，複製產生的字串（`xkeysib-` 開頭）。

> ⚠️ 這把 key 只會顯示一次，關掉就看不到了，請先貼到安全的地方。
> 它等同於「可以用你的帳號寄信」的權限，不要 commit 進 Git、不要貼在聊天群組。
>
> 產完記得確認列表裡那把 key 的 Status 是 **Active** 不是 `Deactivated`。

### 6. 設進 Render

Render 主控台 → 你的 service → **Environment** → 加入：

| 變數 | 值 |
|---|---|
| `BREVO_API_KEY` | 步驟 5 複製的那把 key |
| `REPORT_FROM_EMAIL` | `report@psybypsy.com` |

存檔後 Render 會自動重新部署。**不用刪 `GMAIL_*` 的變數**——程式碼的管道優先序是
Brevo → Gmail API → Gmail SMTP，設了 `BREVO_API_KEY` 就會走 Brevo，其餘留著當備援。

### 7. 先用 curl 確認（不用等部署）

拿到 key 就可以直接測，10 秒有答案：

```bash
curl -i -X POST https://api.brevo.com/v3/smtp/email -H "api-key: 你的KEY" -H "content-type: application/json" -d '{"sender":{"name":"Ipsen Taiwan","email":"report@psybypsy.com"},"to":[{"email":"你的測試信箱@gmail.com"}],"subject":"Brevo 測試","htmlContent":"<p>收到就成功了。</p>"}'
```

| 回應 | 意思 |
|---|---|
| `201` + `messageId` | ✅ 成功 |
| `401 unrecognised IP` | 步驟 2 的 IP 封鎖沒關掉 |
| `403 not yet activated` | 步驟 4 的開通還沒下來，繼續等 |
| `400 sender is not valid` | 步驟 3 的網域驗證沒過，或寄件位址不屬於已驗證網域 |

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

## 關於投遞率

因為走的是**已驗證網域**（`psybypsy.com`）而不是 `@gmail.com`，SPF／DKIM 完全對齊，
投遞率跟一般商業信件一樣，不會有「via brevo.com」那種標記。

> 這點很重要：早期曾考慮只驗證單一 Gmail 寄件地址（不綁網域），但那樣 SPF／DKIM
> 對不齊，自 2024 年 2 月 Gmail／Yahoo [收緊寄件者驗證要求](https://help.brevo.com/hc/en-us/articles/14925263522578-Comply-with-Gmail-Yahoo-and-Microsoft-s-requirements-for-email-senders)
> 之後很容易進垃圾信匣。**不要退回那個做法。**

若仍有個別學員收不到，先請他們查垃圾信匣並把寄件者加入聯絡人；
`psybypsy.com` 是新網域，剛開始寄信時信譽尚未建立，量少而穩定地寄一陣子就會改善。

另一條備援路線是 Gmail API（DKIM 天然對齊，因為信真的從 Gmail 伺服器出去），
程式碼已經寫好測好，只差 Google Cloud 的設定——見 [gmail-api-setup.md](gmail-api-setup.md)。

---

## 其他可能遇到的狀況

| 症狀 | 原因與處理 |
|---|---|
| `400 sender is not valid` | 網域驗證沒過，或 `REPORT_FROM_EMAIL` 不屬於已驗證的網域。 |
| `401 unrecognised IP address` | IP 封鎖沒關掉，見上面的關卡 1。**不要去授權那個 IP**——授權任何一個 IP 反而會啟用對其餘所有 IP 的封鎖。 |
| `401 unauthorized`（沒提到 IP） | API key 錯、被刪掉、或 Status 是 `Deactivated`。 |
| `403 not yet activated` | 帳號的 transactional 還沒開通，見關卡 2，等 Brevo 回覆。 |
| `402` / 額度用罄 | 免費方案每天 300 封。正常用量不會碰到，除非補寄迴圈異常。 |
| 又出現 `TimeoutError` | 代表還在走 SMTP——`BREVO_API_KEY` 沒設到或拼錯，檢查 Render 的環境變數。 |
