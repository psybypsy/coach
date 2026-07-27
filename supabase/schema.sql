-- ============================================================
-- perma-coach 資料庫結構（Supabase / PostgreSQL）
-- 這份檔案是目前線上 Supabase 專案（PSY by PSY Coach）實際結構的存底。
-- 若要重建一個全新專案，依序在 SQL Editor 貼上整段執行即可。
-- ============================================================

-- ── 1. 個人資料（登入後自動建立）──────────────────────────────
create table profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null default '',
  avatar_key text not null default 'avatar1',
  role text not null default 'member' check (role in ('member', 'coach')),
  has_set_name boolean not null default false, -- 首次登入設定過名字後為 true
  created_at timestamptz not null default now()
);

-- ── 2. Email 白名單（只有名單內的人能用）──────────────────────
create table allowed_emails (
  email text primary key,
  role text not null default 'member' check (role in ('member', 'coach')),
  note text
);

-- ── 3. PERMA 書寫（核心表）─────────────────────────────────────
create table perma_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  dimension text not null check (dimension in ('P','E','R','M','A')),
  content text not null,
  is_public boolean not null default true,
  input_method text not null default 'text' check (input_method in ('text','voice')),
  created_at timestamptz not null default now()
);
create index on perma_entries (user_id, created_at desc);
create index on perma_entries (is_public, created_at desc);

-- ── 3b. 週記合併貼文（社群牆單位：內含 PERMA 五答案，同一週可多則）──
-- 每次填完 5 題會同時寫入這裡（社群牆讀取）＋ 5 列 perma_entries（報告/AI 沿用）。
-- week_start = 該篇所屬日曆週（週一起算），用來算「第幾週之幾次」。
create table journal_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  week_start date not null,
  p_content text not null default '',
  e_content text not null default '',
  r_content text not null default '',
  m_content text not null default '',
  a_content text not null default '',
  is_public boolean not null default true,
  created_at timestamptz not null default now()
);
create index on journal_posts (is_public, created_at desc);
create index on journal_posts (user_id, week_start);

-- ── 4. 按讚與留言 ──────────────────────────────────────────────
-- 舊的 likes / comments 掛在單題 perma_entries 上（保留，未使用）。
create table likes (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references perma_entries(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (entry_id, user_id)
);

create table comments (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references perma_entries(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);

-- 社群牆實際使用的按讚 / 留言（掛在 journal_posts 上）。
create table post_likes (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references journal_posts(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (post_id, user_id)
);

create table post_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references journal_posts(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);

-- ── 5. AI 週分析結果（快取）────────────────────────────────────
create table weekly_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  period_start date not null,
  entry_count int not null default 0,
  content jsonb not null,
  created_at timestamptz not null default now(),
  unique (user_id, period_start)
);

-- ── 6. AI 用量記帳（後端 service_role 寫入，前端不可讀寫）──────
create table ai_usage_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  provider text not null,
  source text not null,
  model text not null,
  user_id uuid,
  input_tokens integer,
  output_tokens integer,
  cache_write_tokens integer,
  cache_read_tokens integer,
  audio_seconds numeric,
  cost_usd numeric not null default 0
);
alter table ai_usage_log enable row level security;

-- ── 6b. 教練深度分析結果（一人一列，重新生成即 upsert）──────────
-- 見遷移 002。sessions/blocks/client_* 由後端（service_role）寫入；
-- 教練前端可讀取既有分析並儲存「納入客戶版」勾選與手動編輯。
create table coach_analyses (
  member_id     uuid primary key references profiles(id) on delete cascade,
  based_on      integer not null default 0,
  sessions      jsonb   not null default '[]'::jsonb,
  blocks        jsonb   not null default '[]'::jsonb,
  client_charts jsonb   not null default '{}'::jsonb,
  client_text   text,
  client_date   date,
  coach_id      uuid references profiles(id),
  translations  jsonb   not null default '{}'::jsonb, -- 繁中原文；{ "en": { blocks, sessions } } 為英文翻譯快取
  baseline      jsonb,                                 -- 見遷移 005：T0 基準點五面向分數 {"P":n,...}（0–10），圖表起點
  report_emailed_at timestamptz,
  report_email_recipient text,
  report_email_content_hash text,
  report_email_provider_id text,
  report_email_error text,
  updated_at    timestamptz not null default now()
);

-- 每週完成時產生的單週 PERMA vs T0 報告（見遷移 008）。
create table perma_weekly_reports (
  member_id uuid not null references profiles(id) on delete cascade,
  week_start date not null,
  post_id uuid references journal_posts(id) on delete set null,
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

-- ── 7. RLS：資料庫層的權限牆 ───────────────────────────────────
alter table profiles enable row level security;
alter table perma_entries enable row level security;
alter table journal_posts enable row level security;
alter table likes enable row level security;
alter table comments enable row level security;
alter table post_likes enable row level security;
alter table post_comments enable row level security;
alter table weekly_reviews enable row level security;
alter table allowed_emails enable row level security;
alter table coach_analyses enable row level security;
alter table perma_weekly_reports enable row level security;

-- 判斷目前登入者是否為教練。
-- 注意：security definer 函式若不明確指定 search_path，在 auth schema
-- 的觸發器情境下會抓不到 public schema 的資料表（relation does not exist）。
create or replace function is_coach() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'coach');
$$;

create policy "read all profiles" on profiles for select to authenticated using (true);
create policy "update own profile" on profiles for update to authenticated using (id = auth.uid());
create policy "insert own profile" on profiles for insert to authenticated with check (id = auth.uid());

create policy "read entries" on perma_entries for select to authenticated
  using (is_public = true or user_id = auth.uid() or is_coach());
create policy "insert own entries" on perma_entries for insert to authenticated
  with check (user_id = auth.uid());
create policy "update own entries" on perma_entries for update to authenticated
  using (user_id = auth.uid());
create policy "delete own entries" on perma_entries for delete to authenticated
  using (user_id = auth.uid());

create policy "read journal_posts" on journal_posts for select to authenticated
  using (is_public = true or user_id = auth.uid() or is_coach());
create policy "insert own journal_post" on journal_posts for insert to authenticated
  with check (user_id = auth.uid());
create policy "update own journal_post" on journal_posts for update to authenticated
  using (user_id = auth.uid());
create policy "delete own journal_post" on journal_posts for delete to authenticated
  using (user_id = auth.uid());

create policy "read likes" on likes for select to authenticated using (true);
create policy "insert own like" on likes for insert to authenticated with check (user_id = auth.uid());
create policy "delete own like" on likes for delete to authenticated using (user_id = auth.uid());
create policy "read comments" on comments for select to authenticated using (true);
create policy "insert own comment" on comments for insert to authenticated with check (user_id = auth.uid());
create policy "delete own comment" on comments for delete to authenticated using (user_id = auth.uid());

create policy "read post_likes" on post_likes for select to authenticated using (true);
create policy "insert own post_like" on post_likes for insert to authenticated with check (user_id = auth.uid());
create policy "delete own post_like" on post_likes for delete to authenticated using (user_id = auth.uid());
create policy "read post_comments" on post_comments for select to authenticated using (true);
create policy "insert own post_comment" on post_comments for insert to authenticated with check (user_id = auth.uid());
create policy "delete own post_comment" on post_comments for delete to authenticated using (user_id = auth.uid());

create policy "read own or coach" on weekly_reviews for select to authenticated
  using (user_id = auth.uid() or is_coach());

-- coach_analyses：只有教練能讀寫（後端 service_role 另可略過 RLS 寫入）。
create policy "coach read analyses"   on coach_analyses for select to authenticated using (is_coach());
create policy "coach insert analyses" on coach_analyses for insert to authenticated with check (is_coach());
create policy "coach update analyses" on coach_analyses for update to authenticated using (is_coach());
create policy "member or coach read weekly perma reports" on perma_weekly_reports for select to authenticated
  using (auth.uid() = member_id or is_coach());

-- allowed_emails / ai_usage_log：不建任何 policy = 只有 service_role 能讀寫。

-- ── 8. 新使用者登入時自動建 profile ＋ 白名單檢查 ──────────────
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare allowed record;
begin
  select * into allowed from public.allowed_emails where email = new.email;
  if allowed is null then
    raise exception '此 Email 不在允許名單內';
  end if;
  insert into public.profiles (id, display_name, role)
  values (new.id, coalesce(allowed.note, split_part(new.email, '@', 1)), allowed.role);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ── 9. 白名單名單（依實際邀請對象增減）──────────────────────────
-- insert into allowed_emails (email, role, note) values
--   ('coach@example.com', 'coach', '陳郁敏教練 / Tan Yee Ming'),
--   ('member1@example.com', 'member', '成員一');
