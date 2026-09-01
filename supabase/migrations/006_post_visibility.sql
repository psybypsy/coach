-- ============================================================
-- 遷移 006：貼文發布方式（公開 / 匿名 / 僅自己可見）
-- 在 Supabase → SQL Editor 貼上整段執行一次即可（可重複執行，具冪等性）。
--
-- 用途：書寫精靈最後一步讓使用者選擇這篇要怎麼發布：
--   public    公開發布到社群（顯示真實姓名）
--   anonymous 匿名發布到社群（顯示自然系能量代號，教練仍可看到真實身分）
--   private   僅自己與教練可見（不出現在其他學員的社群動態，教練看得到）
-- is_public 保留給既有 RLS / 排序索引沿用，由前端寫入時與 visibility 同步
--   （private → false，其餘 → true）。
-- ============================================================

alter table journal_posts add column if not exists visibility text;
alter table journal_posts add column if not exists anon_alias text;

-- 既有資料補值：依原本 is_public 換算成 visibility。
update journal_posts set visibility = case when is_public then 'public' else 'private' end
  where visibility is null;

alter table journal_posts alter column visibility set default 'public';
alter table journal_posts alter column visibility set not null;

alter table journal_posts drop constraint if exists journal_posts_visibility_check;
alter table journal_posts add constraint journal_posts_visibility_check
  check (visibility in ('public', 'anonymous', 'private'));
