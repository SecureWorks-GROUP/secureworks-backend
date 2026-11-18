-- Undo 20261118999909 (placeholder version): the service role may update the cap settings
-- again, as 20261118194100 left it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $down$ BEGIN
  IF to_regclass('public.work_order_cap_settings') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, UPDATE ON TABLE public.work_order_cap_settings TO service_role';
  END IF;
END $down$;
