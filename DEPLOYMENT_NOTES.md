# Deployment Notes

## 重要：Supabase 遷移設置

### Migration 002 - 開放同一週可多次書寫

此更新允許使用者在同一週內多次填寫 PERMA Self-Reflection。

**必須在 Supabase 執行此遷移**，否則使用者在同一週第二次發布時會收到「Something went wrong」錯誤。

#### 執行步驟：

1. 登入 Supabase 控制台
2. 進入 SQL Editor
3. 複製 `supabase/migrations/002_multiple_per_week.sql` 的內容
4. 貼上並執行

#### 遷移內容：
```sql
alter table journal_posts
  drop constraint if exists journal_posts_user_id_week_start_key;
```

這會移除舊的 unique constraint，允許同一週的多次書寫。

---

### Migration 007 - 學員自填起始分數（T0）

新增 `baseline_scores` 表：學員首次登入時回想 2026/07/17（五）在台東當天的
五面向分數（0–10），填完才能開始第一次打卡。寫入後會由 trigger 自動同步到
`coach_analyses.baseline`，教練後台的 T0 欄位就會自動有值。

**必須在 Supabase 執行 `supabase/migrations/007_member_baseline.sql`**，
否則學員會卡在起始分數頁面無法送出。

---

## 其他更新

### 登入流程改進
- 寄出的信同時包含 magic link 與 6 位數驗證碼，兩種方式都可登入
- 系統會記憶最近使用的 email，方便下次登入
- 登入一次後 session 會保留在該瀏覽器，之後直接開網站即可進入，不必再驗證

> ⚠️ 驗證碼與 session 長度需要在 Supabase 後台設定才會生效，
> 詳見 [`docs/persistent-login.md`](docs/persistent-login.md)。

### UI/UX 改進
- 導航欄改為橫排顯示（Ipsen Taiwan、PERMA Self-Reflection、Community）
- 發布完成後直接跳轉到社群頁面，而非首頁

### 錯誤處理
- 改善發布失敗的錯誤訊息提示
- 控制台會記錄詳細的錯誤信息用於偵錯
