-- 每週完整提交後產生的單週 PERMA vs T0 報告。
create table if not exists public.perma_weekly_reports (
  member_id uuid not null references public.profiles(id) on delete cascade,
  week_start date not null,
  post_id uuid references public.journal_posts(id) on delete set null,
  week_number integer not null,
  content jsonb not null default '{}'::jsonb,
  report_emailed_at timestamptz,
  report_email_recipient text,
  report_email_content_hash text,
  report_email_provider_id text,
  report_email_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (member_id, week_start)
);

alter table public.perma_weekly_reports enable row level security;

drop policy if exists "member or coach read weekly perma reports" on public.perma_weekly_reports;
create policy "member or coach read weekly perma reports"
  on public.perma_weekly_reports for select to authenticated
  using (auth.uid() = member_id or public.is_coach());
