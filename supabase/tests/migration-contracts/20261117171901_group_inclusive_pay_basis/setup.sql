-- P1-01.1 and the registered group stack must land first.
DO $$ BEGIN
  IF to_regprocedure('public.group_work_order_pay_for_basis(text,numeric)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.trade_invoices'::regclass
       AND conname='trade_invoices_super_basis_check'
       AND pg_get_constraintdef(oid) LIKE '%inclusive_12_112_v1%') THEN
    RAISE EXCEPTION 'ZZTEST inclusive invoice prerequisites missing';
  END IF;
END $$;
