-- ============================================================
-- 遷移 010：member_reports 的來源追蹤與寄信紀錄
-- 在 Supabase → SQL Editor 貼上整段執行一次即可（可重複執行，具冪等性）。
--
-- 為什麼要這三欄（皆取自 PR #11 的設計，但併進既有的 member_reports，
-- 而不是另開一張 perma_weekly_reports）：
--
--   post_id            —— 明確記錄這份報告是哪一篇週記產生的。
--                         原本只靠 week_start 對齊，同一週若有兩篇貼文就會對不準。
--   email_content_hash —— 內文的 sha256。教練改過第 4／8 週的草稿再發布時，
--                         用它判斷「內容真的變了才需要重寄」，避免重複寄同一份。
--   email_error        —— 寄信失敗的原因。原本失敗只寫進 Render 的 log，
--                         教練在後台完全看不出來學員其實沒收到信。
-- ============================================================

alter table public.member_reports
  add column if not exists post_id uuid references public.journal_posts(id) on delete set null,
  add column if not exists email_content_hash text,
  add column if not exists email_error text;

comment on column public.member_reports.post_id is
  '產生這份報告的週記貼文；同一週有多篇時用它精確定位來源。';
comment on column public.member_reports.email_content_hash is
  'body_md 的 sha256。教練改過內容重新發布時，用來判斷是否需要重寄。';
comment on column public.member_reports.email_error is
  '最近一次寄送失敗的原因；成功寄出時清為 null。';

-- ── 收緊教練的編輯權限 ──
-- week 1、2、3、5、6、7 是「AI 產出即定稿、直接寄出、教練不介入」，
-- 一旦寄給學員就不該再變動（008 的快照設計本來就是這個意思）。
-- 只有第 4／8 週的 pending_coach 草稿才需要教練編輯。
-- 注意：這代表第 4／8 週按下「發布」之後也不能再改——若日後想保留
-- 「發布後修錯字」的餘地，把 and status = 'pending_coach' 拿掉即可。
drop policy if exists "coach update reports" on public.member_reports;
create policy "coach update reports" on public.member_reports
  for update to authenticated
  using (is_coach() and status = 'pending_coach');
