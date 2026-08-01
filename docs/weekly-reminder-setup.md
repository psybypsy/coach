# 每週 Email 提醒設定

系統會每週自動發送郵件提醒學員填寫 PERMA 週記。

## 工作原理

1. **Cron Job** 每週一次調用 `/api/send-weekly-reminders` 端點
2. 端點查詢所有學員，檢查是否已填該週週記
3. 未填的學員會收到提醒郵件（同時記錄提醒已發送，避免重複）
4. 已填或已寄過的學員會跳過

---

## 設定步驟（Render）

### 1. 執行數據庫遷移

**這一步要自己做，Render 不會幫你跑 Supabase 的遷移。**

到 Supabase Dashboard → SQL Editor，貼上 `supabase/migrations/011_weekly_email_reminders.sql`
的內容執行，建立 `email_reminders` 表。

檢查是否成功（沒建表的話這句會報錯，端點也會整個寄不出去）：
```sql
select * from email_reminders limit 1;
```

### 2. 在 Render 設定 Cron Job

1. 登入 [Render Dashboard](https://dashboard.render.com)
2. 進入 `perma-coach-api` service
3. 左側 → **Events** → **Cron Jobs**
4. 點 **Create Cron Job**

填入以下配置：

| 欄位 | 值 |
|---|---|
| **Name** | `send-weekly-reminders` |
| **URL** | `https://perma-coach-api.onrender.com/api/send-weekly-reminders` |
| **HTTP Method** | `POST` |
| **Schedule** | 週一 08:00（`0 8 * * 1`）或其他時間 |
| **Headers** | 新增 header：<br/>`X-Webhook-Secret: <你的 REPORT_WEBHOOK_SECRET>` |

**時間表示法（Cron）：**
- `0 8 * * 1` = 每週一早上 8 點
- `0 9 * * 1` = 每週一早上 9 點

### 3. 測試

手動調用一次（替換 `SECRET`）：

```bash
curl -X POST https://perma-coach-api.onrender.com/api/send-weekly-reminders \
  -H "X-Webhook-Secret: <你的 REPORT_WEBHOOK_SECRET>"
```

檢查回應：
- `"sent": n` → 成功寄出 n 封提醒
- `"skipped": m` → 跳過 m 位（已填週記或已寄過）
- `"errors": [...]` → 任何錯誤訊息

### 4. 驗證（Supabase）

```sql
select user_id, week_start, sent_at, error
from email_reminders
order by sent_at desc
limit 10;
```

---

## 郵件內容

學員收到的提醒郵件會：
- 顯示親切的問候
- 簡短說明本週要填什麼（P/E/R/M/A）
- 提供「點此進入寫作」的按鈕連結
- 署名「Yee Ming Tan 教練」

---

## 故障排除

| 症狀 | 解決方案 |
|---|---|
| Cron Job 顯示 `401 Unauthorized` | 檢查 `X-Webhook-Secret` header 是否正確（要跟 Render 環境變數一致） |
| Cron Job 超時 | 增加等待時間；若太多學員可能要優化查詢 |
| 有些學員沒收到提醒 | 檢查 `email_reminders` 表，看是否已記錄該週提醒；check Render 日誌 |
| 學員收到重複提醒 | 檢查 Cron 設定，確認不是執行多次 |

---

## 後續改進

- 可在 `profiles` 表新增 `reminder_opt_out` 欄位，讓學員選擇退出提醒
- 可調整提醒時間（目前固定周一早上）
- 可針對不同族群發送不同內容
