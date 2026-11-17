-- CI: the registered stack already holds the list, the raise, the cost-line
-- writer and users, so this is a no-op. Isolated local proof: build them from
-- their own case and migration files. Stand-ins, isolated only: empty
-- trade_invoices, trade_invoice_lines and xero_supplier_credit_notes (row types
-- the writer migrations declare), a four-column users table, and the Job
-- Profit and job page marks (two tables and job_profit_mark /
-- job_mark_changed, the shape main declares) so the mark assertions run here too.
SELECT to_regprocedure('public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text)') IS NULL AS isolated_decide_setup \gset
\if :isolated_decide_setup
\ir ../20261118073218_reconcile_item_raise/setup.sql
\ir ../../../migrations/20261118073218_reconcile_item_raise.sql
\endif
SELECT to_regprocedure('public.job_cost_lines_set_state(uuid,text,jsonb,text,bigint,text)') IS NULL AS isolated_decide_writer \gset
\if :isolated_decide_writer
-- Row types the writer migrations declare; empty, isolated proof only.
CREATE TABLE IF NOT EXISTS public.trade_invoices(id uuid PRIMARY KEY);
CREATE TABLE IF NOT EXISTS public.trade_invoice_lines(id uuid PRIMARY KEY);
CREATE TABLE IF NOT EXISTS public.xero_supplier_credit_notes(id uuid PRIMARY KEY);
\ir ../../../migrations/20261117171501_job_cost_lines_writer.sql
\ir ../../../migrations/20261117173001_job_cost_lines_followup8.sql
\ir ../../../migrations/20261117195501_job_cost_lines_refollow_index.sql
\endif
SELECT to_regclass('public.users') IS NULL AS isolated_decide_users \gset
\if :isolated_decide_users
CREATE TABLE public.users(id uuid PRIMARY KEY, org_id uuid, name text, role text);
\endif
SELECT to_regprocedure('public.job_profit_mark(uuid,text)') IS NULL AS isolated_decide_profit_mark \gset
\if :isolated_decide_profit_mark
CREATE TABLE IF NOT EXISTS public.job_profit_dirty(job_id uuid PRIMARY KEY, reason text NOT NULL,
 marked_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION public.job_profit_mark(p_job_id uuid, p_reason text) RETURNS void LANGUAGE sql AS $f$
 INSERT INTO public.job_profit_dirty(job_id, reason, marked_at) VALUES (p_job_id, p_reason, clock_timestamp())
 ON CONFLICT (job_id) DO UPDATE SET reason = EXCLUDED.reason, marked_at = EXCLUDED.marked_at $f$;
\endif
SELECT to_regprocedure('public.job_mark_changed(uuid,text)') IS NULL AS isolated_decide_page_mark \gset
\if :isolated_decide_page_mark
CREATE TABLE IF NOT EXISTS public.job_change_mark_events(job_id uuid NOT NULL, source text NOT NULL,
 marked_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE FUNCTION public.job_mark_changed(p_job_id uuid, p_source text) RETURNS void LANGUAGE sql AS $f$
 INSERT INTO public.job_change_mark_events(job_id, source) VALUES (p_job_id, p_source) $f$;
\endif
