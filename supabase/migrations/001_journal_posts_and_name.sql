-- ============================================================
-- 遷移 001：週記合併貼文 + 首次登入設定名字
-- 在 Supabase → SQL Editor 貼上整段執行一次即可（可重複執行，具冪等性）。
-- ============================================================

-- ── 1. profiles 增加「是否已自訂名字」旗標 ──────────────────
-- 首次登入尚未設定名字時為 false，設定過後為 true，
-- 前端用它決定是否要顯示「設定你的名字」歡迎頁。
alter table profiles
  add column if not exists has_set_name boolean not null default false;

-- ── 2. 週記合併貼文（一人一週一則，內含 PERMA 五個答案）──────
-- 社群牆讀這張表；每週填完 5 題後寫入一列，並同步寫 5 列 perma_entries
-- 供個人報告 / 教練儀表板 / AI 週分析沿用（那些功能仍讀 perma_entries）。
create table if not exists journal_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  week_start date not null,
  p_content text not null default '',
  e_content text not null default '',
  r_content text not null default '',
  m_content text not null default '',
  a_content text not null default '',
  is_public boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, week_start)
);
create index if not exists journal_posts_public_created_idx
  on journal_posts (is_public, created_at desc);

-- ── 3. 貼文按讚 / 留言（掛在 journal_posts 上）────────────────
create table if not exists post_likes (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references journal_posts(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (post_id, user_id)
);

create table if not exists post_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references journal_posts(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);

-- ── 4. RLS：資料庫層的權限牆 ───────────────────────────────
alter table journal_posts enable row level security;
alter table post_likes enable row level security;
alter table post_comments enable row level security;

-- journal_posts：公開的、或自己的、或教練都能讀；只能新增/改/刪自己的。
drop policy if exists "read journal_posts" on journal_posts;
create policy "read journal_posts" on journal_posts for select to authenticated
  using (is_public = true or user_id = auth.uid() or is_coach());
drop policy if exists "insert own journal_post" on journal_posts;
create policy "insert own journal_post" on journal_posts for insert to authenticated
  with check (user_id = auth.uid());
drop policy if exists "update own journal_post" on journal_posts;
create policy "update own journal_post" on journal_posts for update to authenticated
  using (user_id = auth.uid());
drop policy if exists "delete own journal_post" on journal_posts;
create policy "delete own journal_post" on journal_posts for delete to authenticated
  using (user_id = auth.uid());

-- post_likes / post_comments：大家都能讀，只能新增/刪自己的。
drop policy if exists "read post_likes" on post_likes;
create policy "read post_likes" on post_likes for select to authenticated using (true);
drop policy if exists "insert own post_like" on post_likes;
create policy "insert own post_like" on post_likes for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "delete own post_like" on post_likes;
create policy "delete own post_like" on post_likes for delete to authenticated using (user_id = auth.uid());

drop policy if exists "read post_comments" on post_comments;
create policy "read post_comments" on post_comments for select to authenticated using (true);
drop policy if exists "insert own post_comment" on post_comments;
create policy "insert own post_comment" on post_comments for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "delete own post_comment" on post_comments;
create policy "delete own post_comment" on post_comments for delete to authenticated using (user_id = auth.uid());
