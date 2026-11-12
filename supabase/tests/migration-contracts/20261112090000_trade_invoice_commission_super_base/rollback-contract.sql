-- After the down: the column is gone, the unfreeze body is the 20261022050000
-- body again and the split check charges super on the whole gross.
\set ON_ERROR_STOP on
DO $$
DECLARE v_def text := pg_get_functiondef('public.unfreeze_group_work_order_split(uuid,uuid)'::regprocedure);
BEGIN
  IF EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'trade_invoices' AND column_name = 'super_base_ex'
     ) THEN
    RAISE EXCEPTION 'rollback left trade_invoices.super_base_ex behind';
  END IF;
  IF position('super_base' IN v_def) > 0
     OR position('super_amount = round(m.line_sum * 0.12, 2),' IN v_def) = 0 THEN
    RAISE EXCEPTION 'rollback did not restore the unfreeze body';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'public.trade_invoices'::regclass
         AND conname = 'trade_invoices_super_gst_split_check'
         AND pg_get_constraintdef(oid) LIKE '%round((gross_earned * super_rate), 2)%'
     ) THEN
    RAISE EXCEPTION 'rollback did not restore the split check';
  END IF;
END $$;
