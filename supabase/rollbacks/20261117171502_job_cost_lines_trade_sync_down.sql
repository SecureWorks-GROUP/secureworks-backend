DROP TRIGGER IF EXISTS job_cost_lines_trade_insert ON public.trade_invoice_lines;
DROP TRIGGER IF EXISTS job_cost_lines_trade_update ON public.trade_invoice_lines;
DROP TRIGGER IF EXISTS job_cost_lines_trade_delete ON public.trade_invoice_lines;
DROP TRIGGER IF EXISTS job_cost_lines_trade_invoice_update ON public.trade_invoices;
DROP FUNCTION IF EXISTS public.job_cost_lines_trade_statement();
DROP FUNCTION IF EXISTS public.job_cost_lines_trade_invoice_row();
DROP FUNCTION IF EXISTS public.job_cost_lines_sync_trade_invoice(uuid);
DROP FUNCTION IF EXISTS public.job_cost_lines_install_trade_triggers();
DROP FUNCTION IF EXISTS public.job_cost_lines_remove_trade_triggers();
