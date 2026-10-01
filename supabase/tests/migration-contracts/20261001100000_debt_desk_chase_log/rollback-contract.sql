-- The runner has just run the down migration against the forward stack.
-- 1. The legacy surface is back: nine methods, no desk columns, no RLS.
DO $$
BEGIN
  IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.payment_chase_logs'::regclass) THEN
    RAISE EXCEPTION 'rollback contract: row-level security is still on';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'payment_chase_logs'
                AND column_name IN ('outcome_code', 'schedule_step', 'draft_id', 'covers_invoice_ids')) THEN
    RAISE EXCEPTION 'rollback contract: desk columns are still there';
  END IF;
  IF to_regclass('public.debt_desk_settings') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: debt_desk_settings is still there';
  END IF;
  IF position('visit' IN pg_get_constraintdef(
       (SELECT oid FROM pg_constraint WHERE conname = 'payment_chase_logs_method_check'))) > 0 THEN
    RAISE EXCEPTION 'rollback contract: the method CHECK still lists visit';
  END IF;
END $$;

BEGIN;
INSERT INTO public.payment_chase_logs (xero_invoice_id, method, notes)
VALUES ('legacy-invoice', 'classification', 'legacy write after rollback');
ROLLBACK;

-- 2. Re-running the rollback is a no-op.
\ir ../../../rollbacks/20261001100000_debt_desk_chase_log_down.sql
