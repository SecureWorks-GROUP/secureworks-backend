SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF to_regclass('public.supplier_credit_drafts') IS NOT NULL THEN
    LOCK TABLE public.supplier_credit_drafts IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (SELECT FROM public.supplier_credit_drafts) THEN
      RAISE EXCEPTION 'supplier_credit_drafts_in_use';
    END IF;
    DROP TABLE public.supplier_credit_drafts;
  END IF;
END $$;

DELETE FROM public.feature_flags WHERE flag_name = 'supplier_credit_drafts_v1';
