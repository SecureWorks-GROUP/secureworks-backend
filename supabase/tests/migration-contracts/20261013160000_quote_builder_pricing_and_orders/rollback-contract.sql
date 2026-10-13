-- Rollback contract: 20261013160000_quote_builder_pricing_and_orders. The down drops the settings
-- table, both link columns and the three unique indexes, and nothing else: work orders, purchase
-- orders, job documents and quote builder versions remain and take rows as before.
\set ON_ERROR_STOP on
DO $$
DECLARE i text;
BEGIN
 IF to_regclass('public.quote_builder_settings') IS NOT NULL THEN
  RAISE EXCEPTION 'quote builder pricing rollback contract: quote_builder_settings still exists';
 END IF;
 FOREACH i IN ARRAY ARRAY['public.ux_work_orders_quote_builder_version',
                          'public.ux_purchase_orders_quote_builder_version_supplier',
                          'public.ux_job_docs_quote_builder_extra'] LOOP
  IF to_regclass(i) IS NOT NULL THEN
   RAISE EXCEPTION 'quote builder pricing rollback contract: % still exists', i;
  END IF;
 END LOOP;
 IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
            AND table_name IN ('work_orders', 'purchase_orders') AND column_name = 'quote_builder_version_id') THEN
  RAISE EXCEPTION 'quote builder pricing rollback contract: a quote_builder_version_id column remains';
 END IF;
 IF to_regclass('public.work_orders') IS NULL OR to_regclass('public.purchase_orders') IS NULL
    OR to_regclass('public.job_documents') IS NULL OR to_regclass('public.quote_builder_versions') IS NULL THEN
  RAISE EXCEPTION 'quote builder pricing rollback contract: the down removed a table it does not own';
 END IF;
 BEGIN
  INSERT INTO public.purchase_orders (supplier_name, status) VALUES ('Rollback probe', 'draft');
  RAISE EXCEPTION 'rollback-probe-ok';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'rollback-probe-ok' THEN RAISE; END IF;
 END;
END $$;
