-- After the down migration every customer variation object is gone, and the
-- job work order layer it built on is untouched.
DO $$
BEGIN
  IF to_regclass('public.work_order_customer_variations') IS NOT NULL
     OR to_regclass('public.work_order_customer_variation_invoices') IS NOT NULL
     OR to_regprocedure('public.approve_work_order_customer_variation(uuid, uuid, text, timestamptz)') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback: customer variation tables and functions must be removed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'customer_variation_xero_draft_v1') THEN
    RAISE EXCEPTION 'rollback: the customer variation Xero flag must be removed';
  END IF;
  IF to_regprocedure('public.approve_job_work_order(uuid, uuid, text, timestamptz)') IS NULL
     OR to_regclass('public.work_order_variations') IS NULL THEN
    RAISE EXCEPTION 'rollback: the job work order layer must remain';
  END IF;
END $$;
