SELECT public.job_profit_refresh_remove();
DROP FUNCTION IF EXISTS public.job_profit_group_work_orders_trg();
DROP FUNCTION IF EXISTS public.job_profit_group_work_order_shares_trg();
DROP FUNCTION IF EXISTS public.job_profit_work_orders_trg();
DROP FUNCTION IF EXISTS public.job_profit_jobs_trg();
DROP FUNCTION IF EXISTS public.job_profit_xero_supplier_credit_note_allocations_trg();
DROP FUNCTION IF EXISTS public.job_profit_xero_invoices_trg();
DROP FUNCTION IF EXISTS public.job_profit_job_budgets_trg();
DROP FUNCTION IF EXISTS public.job_profit_purchase_orders_trg();
DROP FUNCTION IF EXISTS public.job_profit_trade_invoices_trg();
DROP FUNCTION IF EXISTS public.job_profit_trade_invoice_lines_trg();
DROP FUNCTION IF EXISTS public.job_profit_job_materials_facts_trg();
DROP FUNCTION IF EXISTS public.job_profit_refresh_remove();
DROP FUNCTION IF EXISTS public.job_profit_refresh_install();
DROP FUNCTION IF EXISTS public.job_profit_daily_mark();
DROP FUNCTION IF EXISTS public.job_profit_refresh_due();
DROP FUNCTION IF EXISTS public.job_profit_source_changed(text,jsonb,jsonb,text);
-- Queue and cursor are deliberately retained; no accepted source mark is deleted.
