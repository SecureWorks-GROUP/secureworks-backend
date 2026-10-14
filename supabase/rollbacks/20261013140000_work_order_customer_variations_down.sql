-- Rollback for 20261013140000_work_order_customer_variations.sql.
--
-- Removes the customer variation layer. Refuses while any customer variation
-- exists, so it can never silently delete an approved (sealed) addendum or the
-- record of a Xero draft made from one: those rows are decided by a human first.

DO $$
BEGIN
  IF to_regclass('public.work_order_customer_variations') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.work_order_customer_variations) THEN
    RAISE EXCEPTION 'customer variations exist: resolve them before rolling back 20261013140000_work_order_customer_variations';
  END IF;
END $$;

DROP TABLE IF EXISTS public.work_order_customer_variation_invoices;
DROP FUNCTION IF EXISTS public.work_order_customer_variation_invoices_guard();
DROP FUNCTION IF EXISTS public.approve_work_order_customer_variation(uuid, uuid, text, timestamptz);
DROP TABLE IF EXISTS public.work_order_customer_variations;
DROP FUNCTION IF EXISTS public.work_order_customer_variations_guard();

DELETE FROM public.feature_flags WHERE flag_name = 'customer_variation_xero_draft_v1';
