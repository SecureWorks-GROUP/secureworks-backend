DO $$ DECLARE job bigint; BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    FOR job IN SELECT jobid FROM cron.job WHERE jobname='job-cost-lines-receipt-retry' LOOP
      PERFORM cron.unschedule(job); END LOOP;
  END IF;
END $$;
DROP TRIGGER IF EXISTS job_cost_lines_receipt_sync ON public.expense_receipts;
DROP TRIGGER IF EXISTS job_cost_lines_receipt_link_insert ON public.trade_invoice_lines;
DROP TRIGGER IF EXISTS job_cost_lines_receipt_link_update ON public.trade_invoice_lines;
DROP TRIGGER IF EXISTS job_cost_lines_receipt_link_delete ON public.trade_invoice_lines;
DROP TRIGGER IF EXISTS job_cost_lines_receipt_invoice_update ON public.trade_invoices;
DROP FUNCTION IF EXISTS public.job_cost_lines_install_receipt_trigger();
DROP FUNCTION IF EXISTS public.job_cost_lines_remove_receipt_trigger();
DROP FUNCTION IF EXISTS public.job_cost_lines_receipt_row();
DROP FUNCTION IF EXISTS public.job_cost_lines_receipt_link_row();
DROP FUNCTION IF EXISTS public.job_cost_lines_receipt_invoice_row();
DROP FUNCTION IF EXISTS public.job_cost_lines_retry_receipt_one();
DROP FUNCTION IF EXISTS public.job_cost_lines_try_receipt(uuid);
DROP FUNCTION IF EXISTS public.job_cost_lines_sync_receipt(uuid);
DROP TABLE IF EXISTS public.job_cost_lines_receipt_retries;
