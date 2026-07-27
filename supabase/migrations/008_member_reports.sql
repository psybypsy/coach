-- ============================================================
-- 遷移 008：學員版 PERMA 報告（member_reports）
-- 在 Supabase → SQL Editor 貼上整段執行一次即可（可重複執行，具冪等性）。
--
-- 用途：學員每次填完五題後，後端跑一次分析並產生「學員版報告」，
--   內容與排版沿用教練後台的「客戶交付版」（client_text + 圖表），確保兩邊一致。
--
-- 週次規則（week 1 = 2026/07/27 那一週）：
--   week 1、2、3、5、6、7 → status='published'，學員立刻看得到、也會寄信。
--   week 4、8            → status='pending_coach'，先產生初稿但學員看不到，
--                          等教練在後台編輯後按「發布」才轉成 published。
--
-- 快照設計：body_md / charts / sessions / baseline 都是「產生當下」的複本。
--   之後教練重跑分析不會回頭改動已發布給學員的報告，避免學員看到的內容默默變動。
-- ============================================================

create table if not exists member_reports (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references profiles(id) on delete cascade,
  week_start   date not null,
  week_number  int  not null,
  status       text not null default 'published'
                 check (status in ('published', 'pending_coach')),
  body_md      text not null default '',              -- 對應 coach_analyses.client_text
  charts       jsonb not null default '{}'::jsonb,    -- 對應 coach_analyses.client_charts
  sessions     jsonb not null default '[]'::jsonb,    -- 畫圖用的逐週資料快照
  baseline     jsonb,                                 -- T0，圖表起點
  emailed_at   timestamptz,                           -- 已寄出報告 PDF 的時間（未寄為 null）
  created_at   timestamptz not null default now(),
  published_at timestamptz,
  unique (user_id, week_start)
);

comment on table member_reports is
  '學員版 PERMA 報告，一位學員一週一列。內容沿用教練後台客戶交付版；week 4/8 需教練確認後才發布。';

create index if not exists member_reports_user_idx
  on member_reports (user_id, week_start desc);

alter table member_reports enable row level security;

drop policy if exists "read own published reports" on member_reports;
drop policy if exists "coach read all reports"     on member_reports;
drop policy if exists "coach update reports"       on member_reports;

-- 學員只看得到自己、且已發布的報告（week 4/8 的草稿對學員完全隱形）。
create policy "read own published reports" on member_reports
  for select to authenticated
  using (user_id = auth.uid() and status = 'published');

-- 教練看得到全部（含 pending_coach 草稿），並且可以編輯與發布。
create policy "coach read all reports" on member_reports
  for select to authenticated using (is_coach());
create policy "coach update reports" on member_reports
  for update to authenticated using (is_coach());

-- 刻意不建 insert policy：報告一律由後端（service_role）產生，前端不能自己塞。
