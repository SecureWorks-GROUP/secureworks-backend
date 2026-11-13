-- Rollback for 20261114020000_dispatch_line_budget_cost.sql.
-- Refuses while anything step 3 recorded exists (a line linked to its budget
-- line, a reason given, an order's cost): dropping the columns or the table
-- would lose what was ordered against the budget and why. Switch
-- dispatch_budget_cost_v1 off instead; that alone returns Dispatch to how it
-- was. With nothing recorded, takes every step 3 object away. The check and
-- every drop are one statement, so a refusal leaves nothing dropped. Safe to
-- re-run.

DO $$
DECLARE
  v_kept boolean := false;
  v_step boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'job_material_lines'
                AND column_name = 'budget_id') THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.job_material_lines
                             WHERE budget_id IS NOT NULL OR cost_reason_id IS NOT NULL)'
      INTO v_step;
    v_kept := v_kept OR v_step;
  END IF;
  IF to_regclass('public.dispatch_line_cost_reasons') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.dispatch_line_cost_reasons)' INTO v_step;
    v_kept := v_kept OR v_step;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'dispatch_supplier_order_emails'
                AND column_name = 'order_cost') THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.dispatch_supplier_order_emails
                             WHERE order_cost IS NOT NULL)'
      INTO v_step;
    v_kept := v_kept OR v_step;
  END IF;
  IF v_kept THEN
    RAISE EXCEPTION 'Dispatch lines, reasons or order costs recorded against a job budget exist; switch dispatch_budget_cost_v1 off instead of rolling back 20261114020000';
  END IF;

  DROP TRIGGER IF EXISTS job_material_lines_cost_reason_own ON public.job_material_lines;
  DROP FUNCTION IF EXISTS public.job_material_lines_cost_reason_own();
  ALTER TABLE public.job_material_lines
    DROP CONSTRAINT IF EXISTS job_material_lines_budget_link_shape,
    DROP COLUMN IF EXISTS cost_reason_id,
    DROP COLUMN IF EXISTS budget_line_key,
    DROP COLUMN IF EXISTS budget_id;
  ALTER TABLE public.dispatch_supplier_order_emails
    DROP CONSTRAINT IF EXISTS dispatch_supplier_order_emails_order_cost_shape,
    DROP COLUMN IF EXISTS order_cost;
  DROP TABLE IF EXISTS public.dispatch_line_cost_reasons;
  DROP FUNCTION IF EXISTS public.dispatch_line_cost_reasons_write_once();
  DELETE FROM public.feature_flags WHERE flag_name = 'dispatch_budget_cost_v1';
END $$;
