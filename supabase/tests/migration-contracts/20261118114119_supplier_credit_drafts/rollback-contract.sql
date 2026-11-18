DO $$
BEGIN
  IF to_regclass('public.supplier_credit_drafts') IS NOT NULL OR EXISTS (
    SELECT FROM public.feature_flags WHERE flag_name = 'supplier_credit_drafts_v1'
  ) THEN
    RAISE EXCEPTION 'supplier_credit_rollback_incomplete';
  END IF;
END $$;
