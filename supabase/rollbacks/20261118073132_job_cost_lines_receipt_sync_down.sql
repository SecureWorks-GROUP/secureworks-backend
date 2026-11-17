DROP TRIGGER IF EXISTS job_cost_lines_receipt_sync ON public.expense_receipts;
DROP FUNCTION IF EXISTS public.job_cost_lines_install_receipt_trigger();
DROP FUNCTION IF EXISTS public.job_cost_lines_remove_receipt_trigger();
DROP FUNCTION IF EXISTS public.job_cost_lines_receipt_row();
DROP FUNCTION IF EXISTS public.job_cost_lines_try_receipt(uuid);
DROP FUNCTION IF EXISTS public.job_cost_lines_sync_receipt(uuid);
