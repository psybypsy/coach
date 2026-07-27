# 持久登入（登入一次，之後直接開網站就進得去）

目標：使用者第一次驗證 email 之後，接下來 30 天內直接打開網站就是登入狀態，
不必每次都回信箱點 magic link。

---

## 為什麼之前會「每次都要重點一次連結」

程式碼裡 session 的持久化其實**早就設定好了**（`src/lib/supabase.ts` 的
`persistSession: true` + `autoRefreshToken: true`，session 存在 localStorage）。
真正的問題出在三個地方：

### 1. Magic link 開在 email App 的內建瀏覽器（最主要原因）

使用者在手機的 Gmail / Outlook App 裡點登入連結時，連結**不會**開在 Safari 或
Chrome，而是開在該 App 的內建瀏覽器（webview）。session 於是被寫進那個 webview
的 localStorage。

使用者事後自己打開 Safari 進網站 → 那是完全不同的儲存空間 → 當然沒有登入紀錄
→ 只好再去點一次信裡的連結 → 又開在 webview → **無限循環**。

**解法（已實作）**：登入頁改成可以直接輸入信中的 **6 位數驗證碼**。
使用者在哪個瀏覽器輸入驗證碼，登入就完成在哪個瀏覽器，session 從此留得住。
magic link 仍然保留，兩條路都可以走。

### 2. Email 樣板沒有驗證碼 → 見下方「必做設定 A」

### 3. Session 長度是 Supabase 伺服器端決定的 → 見下方「必做設定 B」

---

## 必做設定（在 Supabase 後台，程式碼改不到）

> ⚠️ 這兩項沒設定的話，前端改再多也沒用。

### A. Email 樣板加入驗證碼

**Supabase Dashboard → Authentication → Emails → Magic Link**

樣板裡要同時有連結和驗證碼。在原本的連結下面加上：

```html
<p>或直接輸入這組驗證碼：</p>
<p style="font-size:24px;font-weight:bold;letter-spacing:4px">{{ .Token }}</p>
```

`{{ .Token }}` 就是 6 位數驗證碼。**沒有加這段，登入頁的驗證碼輸入框就永遠沒東西可填。**

### B. Session 有效期設定為 30 天

**Supabase Dashboard → Authentication → Sessions**

| 設定項 | 要設成 | 說明 |
| --- | --- | --- |
| Time-box user sessions | `720` 小時（30 天）或留空 | session 的絕對上限；留空 = 不設上限 |
| Inactivity timeout | `720` 小時（30 天）或留空 | 多久沒回來就登出；**這項若被設成很短，就是每次都要重新登入的元凶** |

**Supabase Dashboard → Authentication → Sessions → Refresh Tokens**

| 設定項 | 要設成 |
| --- | --- |
| Detect and revoke potentially compromised refresh tokens | 保持開啟 |
| Refresh token reuse interval | `10` 秒（預設值即可） |

JWT expiry（Access token lifetime，預設 3600 秒 = 1 小時）**不用改**。
那只是短效的存取權杖，前端會用 refresh token 在背景自動換新，使用者無感。
真正決定「能免驗證多久」的是上面那張表。

---

## 怎麼驗證真的生效了

1. 用驗證碼登入一次。
2. 完全關掉瀏覽器分頁，重新打開網站首頁 → 應該直接進 `/app/home`，不經過登入頁。
3. 在瀏覽器 DevTools → Application → Local Storage，應該看得到
   `sb-<專案代號>-auth-token` 這個 key，裡面有 `refresh_token`。
4. 隔天再開一次網站 → 仍然是登入狀態（access token 會自動換新）。

如果第 2 步就失敗，先回頭檢查「必做設定 B」的 Inactivity timeout。

---

## 已知限制：Safari 的 7 天儲存清除

iOS / macOS Safari 的 ITP（Intelligent Tracking Prevention）會在
**連續 7 天沒有互動**之後，清除網站由 JavaScript 寫入的儲存資料（含 localStorage）。

本專案是純前端 SPA（Vite + Vercel 靜態部署），沒有自己的後端可以下
`Set-Cookie`，所以無法完全繞過這個限制。

實務影響：使用者每週回來寫一次 PERMA，7 天的計時器每次回訪就會重置，
所以大多數情況不會被清掉。萬一真的被清掉，使用者用驗證碼重新登入一次即可
（不會是每次都要，而是很偶爾）。

若日後要徹底解決，需要在 Vercel 上加 serverless function，
由伺服器端下 HttpOnly cookie 來存 refresh token。目前評估不值得為此增加架構複雜度。

---

## 相關程式碼

- `src/lib/supabase.ts` — session 持久化設定、`flowType: 'implicit'`
  （**不要改成 pkce**：PKCE 會把 code_verifier 綁在發出登入請求的瀏覽器，
  使用者在 email App 內建瀏覽器點連結就會直接驗證失敗）
- `src/routes/login.tsx` — `verifyCode()` 驗證碼登入 + magic link 兩條路徑
