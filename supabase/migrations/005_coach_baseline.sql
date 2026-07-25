-- ============================================================
-- 遷移 005：T0 基準點（coach_analyses.baseline）
-- 在 Supabase → SQL Editor 貼上整段執行一次即可（可重複執行，具冪等性）。
--
-- 用途：教練在成員頁最上方填入「T0 起始時間點」的五面向幸福感分數（0–10），
--   作為所有 valence 圖表的起點（趨勢圖、五面向圖、雷達圖）。
--   overall 由五項平均自動算出，不需另存。
-- 格式：{"P":7,"E":6,"R":8,"M":7,"A":5}（0–10 整數；未填為 null）。
-- ============================================================

alter table coach_analyses
  add column if not exists baseline jsonb;

comment on column coach_analyses.baseline is
  'T0 基準點五面向幸福感分數（0–10）：{"P":n,"E":n,"R":n,"M":n,"A":n}；圖表以此為起點。';
