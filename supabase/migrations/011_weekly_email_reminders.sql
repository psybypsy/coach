-- 011: 每週 Email 提醒
-- 記錄每個學員每週是否已發送提醒郵件，避免重複寄送。

create table email_reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  week_start date not null,
  sent_at timestamptz not null default now(),
  error text,
  created_at timestamptz not null default now(),
  unique (user_id, week_start)
);

create index email_reminders_user_week_idx on email_reminders (user_id, week_start desc);

-- 學員只看不到（這是系統表），教練也看不到
alter table email_reminders enable row level security;

-- 防止學員寫入，系統角色 (service role) 才能寫
create policy "no one can read reminders" on email_reminders for select to authenticated
  using (false);
