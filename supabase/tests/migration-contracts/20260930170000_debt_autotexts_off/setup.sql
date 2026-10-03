-- Pre-migration surface for the process-payment-events unschedule.
--
-- Earlier registered cases assert that no cron or net schema exists when their
-- contracts run, so nothing here persists a pg_cron stand-in: in the registered
-- stack the migration meets no cron.job and must no-op. fixture.sql builds the
-- stand-in and the production job shapes; the contract and rollback contract
-- include it inside a rolled-back transaction, and the fail-closed proof
-- includes it in its own throwaway database.
SELECT 1;
