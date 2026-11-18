-- An isolated case uses the same tables and functions as the CI stack.
SELECT to_regprocedure('public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text)') IS NULL AS needs_raise \gset
\if :needs_raise
\ir ../20261118073218_reconcile_item_raise/setup.sql
\ir ../../../migrations/20261118073218_reconcile_item_raise.sql
\endif
SELECT to_regclass('public.match_clues') IS NULL AS needs_clues \gset
\if :needs_clues
\ir ../../../migrations/20261117160500_match_tables.sql
\endif
SELECT to_regprocedure('public.job_cost_lines_set_state(uuid,text,jsonb,text,bigint,text)') IS NULL AS needs_writer \gset
\if :needs_writer
-- The standalone jobs fixture has no metadata yet. The empty relations provide
-- the row types for functions declared beside the real cost-line writer.
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS metadata jsonb;
CREATE TABLE IF NOT EXISTS public.trade_invoices(id uuid PRIMARY KEY);
CREATE TABLE IF NOT EXISTS public.trade_invoice_lines(id uuid PRIMARY KEY);
CREATE TABLE IF NOT EXISTS public.xero_supplier_credit_notes(id uuid PRIMARY KEY);
\ir ../../../migrations/20261117171501_job_cost_lines_writer.sql
\ir ../../../migrations/20261117173001_job_cost_lines_followup8.sql
\ir ../../../migrations/20261117195501_job_cost_lines_refollow_index.sql
\endif
