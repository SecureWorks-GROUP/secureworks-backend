-- Pre-migration surface for 20261117150000_daily_digest_build_cron: only public.sw_service_key(),
-- which an earlier registered setup provides. Earlier cases assert that no cron or net schema exists,
-- so the pg_cron and pg_net stand-ins live inside contract.sql's rolled-back transactions.
DO $$
BEGIN
  IF to_regprocedure('public.sw_service_key()') IS NULL THEN
    RAISE EXCEPTION 'daily digest cron setup: public.sw_service_key() missing from the registered stack';
  END IF;
END $$;
