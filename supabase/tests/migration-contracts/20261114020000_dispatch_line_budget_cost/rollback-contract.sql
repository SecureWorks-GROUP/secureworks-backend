-- The runner has just run the down migration against the forward stack, with
-- nothing recorded.
-- 1. Every step 3 object is gone, and the switch with it.
DO $$
BEGIN
  IF to_regclass('public.dispatch_line_cost_reasons') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: the reasons table is still there';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'job_material_lines'
                AND column_name IN ('budget_id', 'budget_line_key', 'cost_reason_id')) THEN
    RAISE EXCEPTION 'rollback contract: a step 3 line column is still there';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'dispatch_supplier_order_emails'
                AND column_name = 'order_cost') THEN
    RAISE EXCEPTION 'rollback contract: order_cost is still there';
  END IF;
  IF to_regprocedure('public.job_material_lines_cost_reason_own()') IS NOT NULL
     OR to_regprocedure('public.dispatch_line_cost_reasons_write_once()') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: a step 3 function is still there';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'dispatch_budget_cost_v1') THEN
    RAISE EXCEPTION 'rollback contract: the switch is still there';
  END IF;
  IF to_regclass('public.job_material_lines') IS NULL OR to_regclass('public.dispatch_supplier_order_emails') IS NULL THEN
    RAISE EXCEPTION 'rollback contract: a Dispatch table was dropped';
  END IF;
END $$;

-- 2. Re-running the rollback is a no-op.
\ir ../../../rollbacks/20261114020000_dispatch_line_budget_cost_down.sql

-- 3. The forward migration applies again cleanly after a rollback.
BEGIN;
\ir ../../../migrations/20261114020000_dispatch_line_budget_cost.sql
DO $$
BEGIN
  IF to_regclass('public.dispatch_line_cost_reasons') IS NULL
     OR to_regprocedure('public.job_material_lines_cost_reason_own()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'dispatch_supplier_order_emails'
                       AND column_name = 'order_cost') THEN
    RAISE EXCEPTION 'rollback contract: the forward migration did not re-apply';
  END IF;
END $$;
ROLLBACK;
