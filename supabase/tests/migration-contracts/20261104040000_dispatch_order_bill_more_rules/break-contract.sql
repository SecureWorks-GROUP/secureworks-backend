-- Take away "a bill matching two orders links to neither": the view keeps every rule but stops refusing two
-- order numbers or two orders at one site or job. The contract must catch it.
DO $$
DECLARE
  v text := pg_get_viewdef('public.v_dispatch_order_bills'::regclass, true);
  b text;
BEGIN
  b := replace(replace(replace(v, 'pb.pick_orders > 1', 'false'), 'pb.place_jobs > 1', 'false'), 'pb.place_orders > 1', 'false');
  IF b = v THEN
    RAISE EXCEPTION 'break-contract found nothing to break';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_dispatch_order_bills AS ' || b;
END $$;
