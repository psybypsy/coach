-- ============================================================
-- 遷移 007：學員自填的起始分數（baseline_scores）
-- 在 Supabase → SQL Editor 貼上整段執行一次即可（可重複執行，具冪等性）。
--
-- 用途：學員第一次登入時，回想 2026/07/17（五）在台東當天的五面向分數（0–10），
--   填完才進入第一次打卡。這份分數就是教練後台的 T0 基準點。
--
-- 設計重點：
--   1. 學員擁有自己的 baseline_scores 這一列（可讀、可新增，但不可修改／刪除
--      ——起始分數只填一次，之後不能回頭改，才有基準點的意義）。
--   2. 寫入後由 trigger 自動同步到 coach_analyses.baseline，
--      教練後台完全不用改，打開成員頁就看得到 T0 已經填好。
--      coach_analyses 只有教練能寫（RLS），所以 trigger 用 security definer 代寫。
-- ============================================================

create table if not exists baseline_scores (
  user_id uuid primary key references profiles(id) on delete cascade,
  p int not null check (p between 0 and 10),
  e int not null check (e between 0 and 10),
  r int not null check (r between 0 and 10),
  m int not null check (m between 0 and 10),
  a int not null check (a between 0 and 10),
  -- 這份分數回想的是哪一天（台東當天），之後若換梯次可帶不同日期。
  reference_date date not null default date '2026-07-17',
  created_at timestamptz not null default now()
);

comment on table baseline_scores is
  '學員自填的 PERMA 起始分數（0–10）。教練後台的 T0 基準點來源，由 trigger 同步到 coach_analyses.baseline。';

alter table baseline_scores enable row level security;

drop policy if exists "read own baseline"   on baseline_scores;
drop policy if exists "insert own baseline" on baseline_scores;
drop policy if exists "coach read baselines" on baseline_scores;

-- 學員只看得到、也只填得了自己的那一列。
create policy "read own baseline" on baseline_scores
  for select to authenticated using (user_id = auth.uid());
create policy "insert own baseline" on baseline_scores
  for insert to authenticated with check (user_id = auth.uid());
-- 刻意不建 update / delete policy：起始分數只填一次，不能事後修改。

-- 教練看得到所有人的起始分數。
create policy "coach read baselines" on baseline_scores
  for select to authenticated using (is_coach());

-- ── 同步到 coach_analyses.baseline（教練後台的 T0 欄位）──
create or replace function sync_baseline_to_coach_analyses()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into coach_analyses (member_id, baseline)
  values (
    new.user_id,
    jsonb_build_object('P', new.p, 'E', new.e, 'R', new.r, 'M', new.m, 'A', new.a)
  )
  on conflict (member_id) do update
    set baseline = excluded.baseline;
  return new;
end;
$$;

drop trigger if exists baseline_scores_sync on baseline_scores;
create trigger baseline_scores_sync
  after insert on baseline_scores
  for each row execute function sync_baseline_to_coach_analyses();
