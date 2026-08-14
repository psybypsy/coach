-- ============================================================
-- 遷移 012：member_reports 的去重單位從「每週」改成「每篇週記」
-- 在 Supabase → SQL Editor 貼上整段執行一次即可（可重複執行，具冪等性）。
--
-- 原本 unique (user_id, week_start) 代表「一位學員一週只會有一份報告」，
-- 同一週不管填幾篇週記、按幾次「產生報告」都只出得了一份、也只花一次
-- Claude 費用。現在改成「一篇週記（post_id）產生一份報告」——同一週學員
-- 想填幾次都可以，每篇各自出一份報告；但同一篇週記被前端與 Supabase
-- webhook 兩條路徑重複觸發時，仍然只會產生一份（去重單位變成 post_id）。
--
-- 010 已經把 post_id 欄位加上去了（當時只是拿來記錄來源，不是拿來去重），
-- 這裡確認現有資料都已經有值後才把它收緊成 not null + unique。
-- ============================================================

alter table public.member_reports
  alter column post_id set not null;

alter table public.member_reports
  drop constraint if exists member_reports_user_id_week_start_key;

alter table public.member_reports
  add constraint member_reports_user_id_post_id_key unique (user_id, post_id);

comment on column public.member_reports.post_id is
  '產生這份報告的週記貼文；報告去重的單位（同一篇週記只會有一份報告，同一週可以有多篇、各自出報告）。';
