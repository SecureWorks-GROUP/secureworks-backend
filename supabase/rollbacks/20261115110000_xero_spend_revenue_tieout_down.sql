-- Rollback for 20261115110000_xero_spend_revenue_tieout.sql.
-- Drops public.xero_spend_revenue_monthly (only while it is this migration's), then each of the two tables the
-- migration created, public.xero_bank_transaction_lines and public.xero_accounts, only while that table is empty.
-- A table holding rows is our only copy of what xero-sync read from Xero, so it is left in place with a notice;
-- it is service role only and nothing reads it once the function is gone. Nothing else was changed by the
-- migration. A second run is a no-op.

DO $down$
DECLARE
  fn regprocedure := to_regprocedure('public.xero_spend_revenue_monthly(date,integer,uuid)');
  t text;
  has_rows boolean;
BEGIN
  IF fn IS NOT NULL THEN
    IF COALESCE(obj_description(fn, 'pg_proc'), '') NOT LIKE 'TP-08 Xero tie-out, spend money and customer invoices (20261115110000)%' THEN
      RAISE EXCEPTION 'xero_spend_revenue_tieout_down_preimage_mismatch: public.xero_spend_revenue_monthly is not 20261115110000''s';
    END IF;
    DROP FUNCTION public.xero_spend_revenue_monthly(date, integer, uuid);
  END IF;
  FOREACH t IN ARRAY ARRAY['xero_bank_transaction_lines', 'xero_accounts'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', t) INTO has_rows;
    IF has_rows THEN
      RAISE NOTICE 'public.% holds rows read from Xero and is left in place (service role only)', t;
    ELSE
      EXECUTE format('DROP TABLE public.%I', t);
    END IF;
  END LOOP;
END
$down$;
