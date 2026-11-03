-- Take away "the emails' words must name exactly one job number" from rule (f): the view keeps every rule but reads
-- words that name two job numbers. The contract must catch it.
DO $$
DECLARE
  v text := pg_get_viewdef('public.v_dispatch_order_bills'::regclass, true);
  b text;
BEGIN
  b := replace(v, 'm.jobs_named = 1', 'm.jobs_named >= 1');
  IF b = v THEN
    RAISE EXCEPTION 'break-contract found nothing to break';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_dispatch_order_bills AS ' || b;
END $$;
