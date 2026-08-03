# 密碼登入（與 email 驗證碼並存）

登入頁現在有兩條路，學員自己選：

| 方式 | 怎麼用 | 適合誰 |
|---|---|---|
| **Email 驗證碼**（預設） | 輸入 email → 收信 → 輸入 6 位數 | 收得到信的人 |
| **密碼** | 輸入 email + 密碼 | **公司郵件閘道會攔截或延遲放行的人** |

兩條路走同一個 Supabase Email provider，互不衝突。設了密碼的人照樣可以用驗證碼登入。

> ⚠️ **密碼登入只解決「登入」。** 每週報告信與提醒信仍然走 email，一樣會被對方公司擋。
> 那件事要靠 Brevo custom SMTP 解決，見 [`email-deliverability-plan.html`](email-deliverability-plan.html)。

---

## 一、學員怎麼取得密碼

### 情況 A：收得到驗證碼（大多數人）

1. 照舊用驗證碼登入一次
2. 進「**個人資料 → 登入密碼**」，輸入兩次新密碼 → 按「設定密碼」
3. 之後就能用 email + 密碼登入

這是最單純的路徑，不需要教練介入。

### 情況 B：完全收不到信（被公司擋住）

學員連第一次都進不來，沒辦法自己設密碼，要由教練用腳本代設：

```bash
cd backend && .venv/bin/python tools/set_member_password.py someone@ipsen.com
```

腳本會印出一組隨機密碼。**請用 email 以外的管道交給學員**——當面、通訊軟體、電話。
用 email 寄就等於白做。

學員登入後可以自己到「個人資料 → 登入密碼」改成好記的密碼。

想指定密碼就加 `--password`：

```bash
cd backend && .venv/bin/python tools/set_member_password.py someone@ipsen.com --password 你想要的密碼
```

腳本的行為：

- 學員**已經登入過** → 直接更新密碼
- 學員**從沒登入過**（`auth.users` 還沒有那一列）→ 建立帳號並設定密碼，
  `email_confirm` 直接給 true，所以**不會寄出任何確認信**
- 不在 `allowed_emails` 白名單內 → 被 `handle_new_user()` trigger 擋下，
  腳本會印出要執行的 SQL

需要 `backend/.env` 裡的 `SUPABASE_URL` 與 `SUPABASE_SERVICE_ROLE_KEY`。

---

## 二、Supabase 後台要確認的設定

| 位置 | 設定 | 為什麼 |
|---|---|---|
| Authentication → Sign In / Providers → Email | **Enable Email provider** 開啟 | 同一個 provider 同時管驗證碼與密碼，本來就是開的 |
| Authentication → Sign In / Providers → Email | **Minimum password length** 設 8 | 前端已擋 8 碼，後端也擋才是真的 |
| Authentication → Sign In / Providers → Email | **Leaked Password Protection** 開啟 | 比對 HaveIBeenPwned，擋掉已外洩的密碼 |

「Confirm email」不用動——腳本建立帳號時已經帶 `email_confirm: true`，
學員自己設密碼時本來就已經是驗證過的帳號。

---

## 三、忘記密碼

**重設密碼信一樣會被公司擋**，所以對受影響的學員來說「忘記密碼」只能走人工：

1. 學員聯絡教練
2. 教練跑一次 `set_member_password.py`
3. 用 email 以外的管道把新密碼給他

收得到信的學員則沒這個問題——他們也可以直接改用驗證碼登入，不必重設密碼。

> 這是密碼登入的長期營運成本，八週梯次期間幾乎一定會發生幾次。

---

## 四、為什麼要並存，而不是全面改密碼

- 驗證碼登入在安全性上其實**更強**——它每次都做一次 email 持有證明，而且是單次使用
- 密碼沒有 MFA、可能被共用、可能很弱
- 大多數學員收得到信，沒有理由讓他們多記一組密碼

所以密碼是**給收不到信的人的逃生門**，不是預設路徑。登入頁也照這個優先序呈現：
預設顯示驗證碼，密碼藏在「改用密碼登入」後面。

---

## 五、Safari 的 7 天清除讓這件事更有價值

iOS／macOS Safari 的 ITP 會在**連續 7 天沒互動**後清掉 localStorage（含登入 session），
細節見 [`persistent-login.md`](persistent-login.md)。

學員正好是「每週寫一次」，剛好卡在 7 天邊緣——晚個一兩天就會被登出。

- 只有驗證碼時：重新登入 = 等一封可能被擋住的信
- 有密碼時：重新登入 = 密碼管理器自動填，3 秒

---

## 六、相關程式

| 檔案 | 內容 |
|---|---|
| [`src/routes/login.tsx`](../src/routes/login.tsx) | 登入頁的兩種模式；`signInWithPassword()` 與 `verifyCode()` |
| [`src/routes/app.settings.tsx`](../src/routes/app.settings.tsx) | 「登入密碼」區塊，`supabase.auth.updateUser({ password })` |
| [`backend/tools/set_member_password.py`](../backend/tools/set_member_password.py) | 教練代設密碼的腳本（service_role） |
| [`supabase/schema.sql`](../supabase/schema.sql) | `allowed_emails` 白名單與 `handle_new_user()` trigger |

登入頁與個人資料頁的密碼欄位都包在真正的 `<form>` 裡——密碼管理器要看到 `<form>`
才會提示儲存與自動填入，而「打開網站按一下就進去」的體驗完全靠這個。改動時不要把 form 拆掉。
