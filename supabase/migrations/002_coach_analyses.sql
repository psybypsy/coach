-- ============================================================
-- 遷移 002：教練深度分析結果（coach_analyses）
-- 在 Supabase → SQL Editor 貼上整段執行一次即可（可重複執行，具冪等性）。
--
-- 用途：儲存教練對某位成員的深度分析結果——
--   每週情緒 valence 分數（含理由與情緒詞）、教練情報簡報區塊、
--   以及據此改寫的客戶交付報告。一位成員一列，重新生成即覆蓋（upsert）。
-- 資料來源為 journal_posts（一人一週一列，內含 PERMA 五個答案）。
-- ============================================================

create table if not exists coach_analyses (
  member_id     uuid primary key references profiles(id) on delete cascade,
  based_on      integer not null default 0,          -- 分析基於幾週的書寫
  sessions      jsonb   not null default '[]'::jsonb, -- [{overall,overallReason,dims,emotions}]
  blocks        jsonb   not null default '[]'::jsonb, -- [{title,body,include}] 情報簡報區塊
  client_charts jsonb   not null default '{}'::jsonb, -- {summary:true,trend:true,...} 哪些圖表納入客戶版
  client_text   text,                                -- 客戶交付報告全文（Markdown，未生成則為 null）
  client_date   date,                                -- 客戶版生成日期
  coach_id      uuid references profiles(id),        -- 生成這份分析的教練
  updated_at    timestamptz not null default now()
);

-- ── RLS：只有教練能讀寫（沿用 schema.sql 既有的 is_coach()）─────────
-- backend 以 service_role 寫入時會略過 RLS；這些 policy 讓前端能直接
-- 讀取既有分析，並儲存「納入客戶版」勾選與手動編輯。
alter table coach_analyses enable row level security;

drop policy if exists "coach read analyses"   on coach_analyses;
drop policy if exists "coach insert analyses" on coach_analyses;
drop policy if exists "coach update analyses" on coach_analyses;

create policy "coach read analyses"   on coach_analyses for select to authenticated using (is_coach());
create policy "coach insert analyses" on coach_analyses for insert to authenticated with check (is_coach());
create policy "coach update analyses" on coach_analyses for update to authenticated using (is_coach());
