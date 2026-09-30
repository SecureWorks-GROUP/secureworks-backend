-- Pre-migration surface for the cron rewrite.
--
-- Earlier registered cases assert that no cron or net schema exists when their
-- contracts run, and that public.sw_service_key() returns their fixture value.
-- So nothing here persists a pg_cron or pg_net stand-in or redefines the key
-- accessor: in the registered stack the migration meets no cron.job and must
-- no-op. fixture.sql builds the stand-ins and the production job shapes; the
-- contract and rollback contract include it inside a rolled-back transaction,
-- and the fail-closed proof includes it in its own throwaway database.

DO $$
BEGIN
  -- Only when no registered case provides the accessor (the earlier cases'
  -- stand-in returns this same value).
  IF to_regprocedure('public.sw_service_key()') IS NULL THEN
    CREATE FUNCTION public.sw_service_key() RETURNS text
      LANGUAGE sql AS 'SELECT ''contract-fixture-key''::text';
  END IF;
END $$;
