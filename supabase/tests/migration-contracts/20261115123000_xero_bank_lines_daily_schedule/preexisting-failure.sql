-- A trigger body this migration was not built on (another lane changed it since 20261103170000):
-- the migration must refuse, replacing nothing.
CREATE OR REPLACE FUNCTION public.trigger_xero_sync_action(p_action text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF p_action NOT IN ('sync_supplier_credit_notes', 'check_invoice_mirror', 'some_other_lane_action') THEN
    RAISE EXCEPTION 'xero_sync_action_not_scheduled: %', p_action;
  END IF;
  RETURN 0;
END $fn$;
