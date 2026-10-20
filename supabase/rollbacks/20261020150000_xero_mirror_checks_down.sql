-- Rollback for 20261020150000_xero_mirror_checks.sql.
--
-- Removes the mirror check table. The rows are only a record of past checks (each check
-- is re-run from Xero every hour), so nothing is lost that cannot be read again. The
-- xero_sync_state cursor row 'invoice_mirror_check_last_run_at' is left in place: it is
-- harmless and the next check after a re-apply simply runs. Re-running it is a no-op.
--
-- Roll back the matching xero-sync and ops-api code first: xero-sync then stops writing
-- here, and ops-api reports the check as "not checked" when the table is missing.

DROP TABLE IF EXISTS public.xero_mirror_checks;
