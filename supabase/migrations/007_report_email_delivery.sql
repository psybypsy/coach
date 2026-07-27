-- 八週客戶報告寄送狀態：內容雜湊用於避免相同版本重複寄送。
alter table public.coach_analyses
  add column if not exists report_emailed_at timestamptz,
  add column if not exists report_email_recipient text,
  add column if not exists report_email_content_hash text,
  add column if not exists report_email_provider_id text,
  add column if not exists report_email_error text;
