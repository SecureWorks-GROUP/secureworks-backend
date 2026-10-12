-- Deliberately undo the promise that a draft is never a record against the
-- job: list every dated line, drafts included. contract.sql must notice.
CREATE OR REPLACE VIEW public.job_trade_time_entries
WITH (security_invoker = true) AS
SELECT
  line.id AS trade_invoice_line_id,
  line.job_id,
  line.job_number,
  invoice.user_id,
  trade.name AS user_name,
  line.work_date,
  line.start_time,
  line.finish_time,
  COALESCE(line.break_minutes, 0) AS break_minutes,
  line.total_hours AS hours,
  ((line.work_date + line.start_time::time) AT TIME ZONE 'Australia/Perth') AS started_at,
  ((line.work_date + line.finish_time::time) AT TIME ZONE 'Australia/Perth') AS finished_at,
  line.line_type,
  line.trade_invoice_id,
  invoice.invoice_number,
  invoice.status AS invoice_status,
  invoice.submitted_at
FROM public.trade_invoice_lines AS line
JOIN public.trade_invoices AS invoice
  ON invoice.id = line.trade_invoice_id
LEFT JOIN public.users AS trade
  ON trade.id = invoice.user_id
WHERE line.job_id IS NOT NULL
  AND line.work_date IS NOT NULL
  AND line.start_time IS NOT NULL
  AND line.finish_time IS NOT NULL;
