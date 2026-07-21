-- ============================================================
-- 遷移 002：開放同一週可多次書寫
-- 在 Supabase → SQL Editor 貼上整段執行一次即可（冪等）。
-- 移除 journal_posts「一週一則」的唯一限制，之後同一週可有多則貼文
-- （社群顯示為 Week N 之 1、之 2…）。
-- ============================================================

alter table journal_posts
  drop constraint if exists journal_posts_user_id_week_start_key;
