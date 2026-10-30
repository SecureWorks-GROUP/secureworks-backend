-- After the down: every object it made is gone, the flag row too, and Job
-- Profit's engine is untouched.
DO $$
BEGIN
  IF to_regclass('public.xero_supplier_credit_notes') IS NOT NULL
     OR to_regclass('public.xero_supplier_credit_note_allocations') IS NOT NULL
     OR to_regclass('public.v_supplier_credit_placement') IS NOT NULL
     OR to_regprocedure('public.xero_supplier_credit_note_copy(uuid,jsonb,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'supplier credit notes rollback: an object survived';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'xero_supplier_credit_notes_v1') THEN
    RAISE EXCEPTION 'supplier credit notes rollback: the flag row survived';
  END IF;
  IF to_regclass('public.v_job_cost_events') IS NULL OR to_regclass('public.xero_invoices') IS NULL THEN
    RAISE EXCEPTION 'supplier credit notes rollback: took something it did not make';
  END IF;
END $$;
-- A second down is a no-op.
\ir ../../../rollbacks/20261030010000_xero_supplier_credit_notes_down.sql
-- And the migration applies again on the rolled-back stack.
BEGIN;
\ir ../../../migrations/20261030010000_xero_supplier_credit_notes.sql
DO $$
BEGIN
  IF to_regclass('public.v_supplier_credit_placement') IS NULL THEN
    RAISE EXCEPTION 'supplier credit notes rollback: the migration does not re-apply after its down';
  END IF;
END $$;
ROLLBACK;
