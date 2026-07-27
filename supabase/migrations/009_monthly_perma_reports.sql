-- ============================================================
-- 遷移 009：每月（里程碑）PERMA 報告
-- 在 Supabase → SQL Editor 貼上整段執行一次即可（可重複執行，具冪等性）。
--
-- 用途：在第 4 週與第 8 週各產生一份跨週回顧：
--   milestone_week = 4 → 分析第 1–4 週
--   milestone_week = 8 → 分析第 1–8 週（累積完整回顧）
-- 與每週報告不同：每週報告只看單週，這裡看整段期間的軌跡，並與 T0 基準比較。
-- 僅教練端閱讀，不寄送給成員。
-- ============================================================

create table if not exists public.perma_monthly_reports (
  member_id      uuid not null references public.profiles(id) on delete cascade,
  milestone_week integer not null,                  -- 4 或 8
  weeks_covered  integer not null default 0,        -- 實際涵蓋幾週
  week_start_from date,
  week_start_to   date,
  content        jsonb not null default '{}'::jsonb, -- {baseline, sessions, blocks, scope}
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (member_id, milestone_week)
);

alter table public.perma_monthly_reports enable row level security;

drop policy if exists "member or coach read monthly perma reports" on public.perma_monthly_reports;
create policy "member or coach read monthly perma reports"
  on public.perma_monthly_reports for select to authenticated
  using (auth.uid() = member_id or public.is_coach());
