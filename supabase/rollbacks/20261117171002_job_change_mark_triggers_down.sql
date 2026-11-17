-- Undo only P0-02.2 triggers. Keep the marks table and its writers.
SET LOCAL lock_timeout = '5s';
DO $trigger$
BEGIN
 IF to_regclass('public.business_events') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS job_mark_changed_business_events ON public.business_events;
 END IF;
END $trigger$;
DO $trigger$
BEGIN
 IF to_regclass('public.context_ledger_items') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS job_mark_changed_context_ledger_items ON public.context_ledger_items;
 END IF;
END $trigger$;
DO $trigger$
BEGIN
 IF to_regclass('public.context_ledger_generations') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS job_mark_changed_context_ledger_generations ON public.context_ledger_generations;
 END IF;
END $trigger$;
DO $trigger$
BEGIN
 IF to_regclass('public.xero_invoices') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS job_mark_changed_xero_invoices ON public.xero_invoices;
 END IF;
END $trigger$;
DO $trigger$
BEGIN
 IF to_regclass('public.job_documents') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS job_mark_changed_job_documents ON public.job_documents;
 END IF;
END $trigger$;
DO $trigger$
BEGIN
 IF to_regclass('public.email_events') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS job_mark_changed_email_events ON public.email_events;
 END IF;
END $trigger$;
DO $trigger$
BEGIN
 IF to_regclass('public.job_assignments') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS job_mark_changed_job_assignments ON public.job_assignments;
 END IF;
END $trigger$;
DO $trigger$
BEGIN
 IF to_regclass('public.job_events') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS job_mark_changed_job_events ON public.job_events;
 END IF;
END $trigger$;
DO $trigger$
BEGIN
 IF to_regclass('public.jobs') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS job_mark_changed_jobs ON public.jobs;
 END IF;
END $trigger$;
DO $trigger$
BEGIN
 IF to_regclass('public.job_materials_facts') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS job_mark_changed_job_materials_facts ON public.job_materials_facts;
 END IF;
END $trigger$;
DO $trigger$
BEGIN
 IF to_regclass('public.trade_invoice_lines') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS job_mark_changed_trade_invoice_lines ON public.trade_invoice_lines;
 END IF;
END $trigger$;
DO $trigger$
BEGIN
 IF to_regclass('public.work_orders') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS job_mark_changed_work_orders ON public.work_orders;
 END IF;
END $trigger$;
DO $trigger$
BEGIN
 IF to_regclass('public.purchase_orders') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS job_mark_changed_purchase_orders ON public.purchase_orders;
 END IF;
END $trigger$;
DO $trigger$
BEGIN
 IF to_regclass('public.job_client_signoffs') IS NOT NULL THEN
  DROP TRIGGER IF EXISTS job_mark_changed_job_client_signoffs ON public.job_client_signoffs;
 END IF;
END $trigger$;
DROP FUNCTION IF EXISTS public.job_mark_changed_trg();
