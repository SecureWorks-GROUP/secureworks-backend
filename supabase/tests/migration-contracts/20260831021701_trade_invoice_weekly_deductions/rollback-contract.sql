-- Executed after the matching down migration on disposable PostgreSQL.
DO $$
DECLARE
  source_check_definition text;
  removed_column text;
BEGIN
  IF to_regprocedure(
    'public.persist_weekly_trade_invoice_v1(jsonb,jsonb,uuid)'
  ) IS NOT NULL OR to_regprocedure(
    'public.persist_trade_work_order_invoice_v1(jsonb,jsonb,uuid)'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'weekly persistence functions survived rollback';
  END IF;

  FOREACH removed_column IN ARRAY ARRAY[
    'source_work_order_id',
    'source_trade_invoice_line_id',
    'deduction_user_id',
    'deduction_assignment_id',
    'deduction_trade_rate_id',
    'site_address',
    'line_position'
  ] LOOP
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'trade_invoice_lines'
        AND column_name = removed_column
    ) THEN
      RAISE EXCEPTION 'weekly invoice line column survived rollback: %', removed_column;
    END IF;
  END LOOP;

  IF to_regclass('public.v_trade_charge_resolved') IS NULL THEN
    RAISE EXCEPTION 'trade charge resolver view was not restored';
  END IF;
  PERFORM 1 FROM public.v_trade_charge_resolved LIMIT 1;

  SELECT pg_get_constraintdef(oid)
  INTO source_check_definition
  FROM pg_constraint
  WHERE conrelid = 'public.trade_invoices'::regclass
    AND conname = 'trade_invoices_invoice_source_check';
  IF source_check_definition IS NULL
     OR source_check_definition LIKE '%weekly_work_order%'
     OR source_check_definition NOT LIKE '%hourly%'
     OR source_check_definition NOT LIKE '%work_order%' THEN
    RAISE EXCEPTION 'legacy invoice_source constraint was not restored: %',
      source_check_definition;
  END IF;
END;
$$;
