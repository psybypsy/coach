-- ============================================================
-- #4 診斷：新用戶是否真的即時同步到教練後台
-- 在 Supabase → SQL Editor 逐段執行，把每段結果貼回給 Claude。
-- 每段上方註解說明「期望結果」與「不符代表什麼」。
-- ============================================================

-- A. auth.users 上的觸發器（新用戶自動建 profile 的關鍵）
-- 期望：看到 on_auth_user_created，tgenabled = 'O'（啟用）。
-- 若空白 = 觸發器沒裝，新用戶登入後不會建立 profiles 列 → 後台永遠看不到他。
select tgname, tgenabled
from pg_trigger
where tgrelid = 'auth.users'::regclass and not tgisinternal;

-- B. handle_new_user() 函式是否存在
-- 期望：回傳一列 handle_new_user。
select proname
from pg_proc
where proname = 'handle_new_user';

-- C. 「已註冊但沒有 profile」的孤兒帳號（同步失敗的鐵證）
-- 期望：0 列。若有列 = 這些人登入成功了，卻沒進到後台。
select u.id, u.email, u.created_at
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null
order by u.created_at desc;

-- D. Realtime 訂閱（後台即時更新靠這三張表的推播）
-- 期望：profiles / journal_posts / perma_entries 三張都出現。
-- 缺的表不會即時推播（但後台切回分頁 / 按重新整理仍會重撈，有保底）。
select tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
  and tablename in ('profiles', 'journal_posts', 'perma_entries');

-- E. 目前 profiles 的角色分布（後台讀 role = 'member'）
-- 期望：至少 1 個 coach、若干 member。
select role, count(*) as n
from public.profiles
group by role;

-- F. 白名單（不在名單內的 email，觸發器會擋下，註冊直接失敗）
-- 對照你想新增的測試 email 是否在名單內、role 是否為 member。
select email, role, note
from public.allowed_emails
order by role, email;

-- G. profiles 的 SELECT policy（教練必須能讀到所有成員）
-- 期望：看到 "read all profiles"，cmd = SELECT，qual = true。
select policyname, cmd, qual
from pg_policies
where schemaname = 'public' and tablename = 'profiles';

-- H.（可選）最近 7 天新建的 profiles，確認新資料有進來
select id, display_name, role, created_at
from public.profiles
where created_at > now() - interval '7 days'
order by created_at desc;
