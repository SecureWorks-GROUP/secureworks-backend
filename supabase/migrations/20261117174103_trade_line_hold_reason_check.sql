-- Follow-up 9, P1-05.6. The nullable column already exists from the gap read.
-- Add its CHECK separately so ADD COLUMN IF NOT EXISTS cannot skip the guard.
-- NOT VALID avoids a historical scan and leaves every stored row unchanged.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.trade_invoice_lines'::regclass AND conname='trade_invoice_lines_hold_reason_check') THEN
    ALTER TABLE public.trade_invoice_lines ADD CONSTRAINT trade_invoice_lines_hold_reason_check
      CHECK (hold_reason IS NULL OR hold_reason IN (
        'no_work_order','no_amount','over_amount','hourly_no_maximum','no_job',
        'not_job_work','reimbursement','not_on_crew','commission_no_figure','rate_above_rule'
      )) NOT VALID;
  END IF;
END $$;
