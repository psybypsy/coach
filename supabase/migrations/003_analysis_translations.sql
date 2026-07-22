-- ============================================================
-- 遷移 003：教練分析的翻譯快取（coach_analyses.translations）
-- 在 Supabase → SQL Editor 貼上整段執行一次即可（冪等）。
--
-- 政策：教練深度分析一律以「英文」生成（教練工作語言預設英文）。
-- 教練在介面點「中文」時，後端即時翻譯一次並存進這個欄位，之後切換即時、不再花錢。
-- 結構：{ "zh-TW": { "blocks": [...], "sessions": [...] } }，可擴充其他語言。
-- 每次「重新生成分析」會把這個欄位清空（內容變了、舊翻譯作廢）。
-- ============================================================

alter table coach_analyses
  add column if not exists translations jsonb not null default '{}'::jsonb;
