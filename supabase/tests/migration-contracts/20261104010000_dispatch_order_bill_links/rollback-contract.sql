-- After the down: the two views and the two functions are gone, and the tables they read are still there.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF to_regclass('public.v_dispatch_order_bills') IS NOT NULL
     OR to_regclass('public.v_dispatch_orders') IS NOT NULL
     OR to_regprocedure('public.dispatch_supplier_name_key(text)') IS NOT NULL
     OR to_regprocedure('public.dispatch_job_number_pattern(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback left the B4 Dispatch order views or functions behind';
  END IF;
  IF to_regclass('public.dispatch_supplier_order_emails') IS NULL
     OR to_regclass('public.dispatch_v2_supplier_order_refs') IS NULL
     OR to_regclass('public.xero_invoices') IS NULL
     OR to_regclass('public.purchase_orders') IS NULL THEN
    RAISE EXCEPTION 'rollback removed a table the views read';
  END IF;
END $$;
