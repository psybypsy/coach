# 每週 Email 提醒設定

系統會每週自動發送郵件提醒學員填寫 PERMA 週記。

## 工作原理

1. **GitHub Actions 排程**（`.github/workflows/weekly-reminders.yml`）每週一次調用
   `/api/send-weekly-reminders` 端點
2. 端點查詢所有學員，檢查是否已填**該課程週**的週記
3. 未填的學員會收到提醒郵件（同時記錄提醒已發送，避免重複）
4. 已填或已寄過的學員會跳過

> **為什麼不用 Render Cron Job？** Render 的 cron 每個服務最低月費 $1，而且它不是
> 「填 URL 就會定時打」的排程器——只有 Schedule 與 Command 兩個欄位，要自己在
> Command 裡寫 curl。這支排程只是定時打一個 HTTP 端點，用 GitHub Actions 免費且更單純。

---

## 設定步驟

### 1. 執行數據庫遷移

**這一步要自己做，Render 不會幫你跑 Supabase 的遷移。**

到 Supabase Dashboard → SQL Editor，貼上 `supabase/migrations/011_weekly_email_reminders.sql`
的內容執行，建立 `email_reminders` 表。

檢查是否成功（沒建表的話這句會報錯，端點也會整個寄不出去）：
```sql
select * from email_reminders limit 1;
```

### 2. 在 GitHub 設定 secret

排程要用 `REPORT_WEBHOOK_SECRET` 才能通過端點驗證，值必須跟 **Render 環境變數
`REPORT_WEBHOOK_SECRET` 一模一樣**。

1. 到 https://github.com/psybypsy/coach/settings/secrets/actions
2. 點 **New repository secret**
3. Name 填 `REPORT_WEBHOOK_SECRET`，Secret 貼上 Render 上那個值
4. 存檔

沒設這個 secret 的話，排程會直接失敗並在 Actions 頁面標紅字提示。

### 3. 排程時間

排程寫在 `.github/workflows/weekly-reminders.yml`，目前是 **台灣時間週日下午 3 點**。

**GitHub Actions 的 cron 一律吃 UTC**，台灣是 UTC+8，換算時要減 8 小時：

| 想要的台灣時間 | cron 寫法 |
|---|---|
| 週日下午 3 點（目前設定） | `0 7 * * 0` |
| 週五下午 3 點 | `0 7 * * 5` |
| 週一早上 9 點 | `0 1 * * 1` |
| 週一早上 8 點 | `0 0 * * 1` |

註：GitHub 的排程在尖峰時段可能延遲幾分鐘到數十分鐘，週報提醒不受影響。

### 4. 測試

不用等到週五——到 [Actions 分頁](https://github.com/psybypsy/coach/actions)
選「每週 PERMA 書寫提醒」→ **Run workflow** 手動跑一次，執行紀錄裡會直接印出回應。

也可以在本機打（替換 `<SECRET>`）：

```bash
curl -X POST https://perma-coach-api.onrender.com/api/send-weekly-reminders -H "X-Webhook-Secret: <SECRET>"
```

檢查回應：
- `"sent": n` → 成功寄出 n 封提醒
- `"skipped": m` → 跳過 m 位（已填週記或已寄過）
- `"errors": [...]` → 任何錯誤訊息

> ⚠️ 這一打就會**真的寄信**給所有沒填本週週記的學員。測試前先確認
> `profiles` 裡 `role=member` 的名單，免得寄給一堆測試帳號。

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
| 回 `401 Unauthorized` | GitHub secret `REPORT_WEBHOOK_SECRET` 跟 Render 環境變數的值對不上 |
| 回 `500`，訊息提到 `email_reminders` | 遷移 011 沒跑，回到步驟 1 |
| 回 200 但 `sent` 一直是 0 | 全部學員都被 skip：查 `email_reminders` 看該課程週是否已寄過，或他們本來就填完了 |
| 第一次呼叫很慢 | Render 免費方案閒置會休眠，冷啟動約 50 秒；workflow 已先打 `/docs` 暖機 |
| 學員收到重複提醒 | 查 `email_reminders`；第 1 週橫跨 7/27 與 8/3 兩個日曆週，端點用 `_program_week_bounds` 以區間比對，兩週只會寄一次 |

---

## 後續改進

- 可在 `profiles` 表新增 `reminder_opt_out` 欄位，讓學員選擇退出提醒
- 目前會寄給所有 `role=member` 的帳號，包含測試帳號；正式上線後可考慮加白名單過濾
- 可針對不同族群發送不同內容
