-- Switch the deep email history load on (history depth go point G7), for use
-- AFTER 20261007080000 and its outlook-mail-capture are deployed and the
-- counts-only probe (G6, scripts/context-email-deep-probe.sh) has been read.
--
-- DRY RUN: this file ends in ROLLBACK and changes nothing. Running it for real
-- is a flag change and needs the owner's go; then change the final ROLLBACK
-- to COMMIT and nothing else. Run scripts/context-email-deep-check.sql first
-- and keep its output.
--
-- What it changes, on exactly one row: feature flag email_reader_deep_v1, off
-- to on. From the next outlook-mail-deep-history tick (every 5 minutes) the
-- load reads each of the selected mailboxes backwards, two calls a tick,
-- groups first, to the start of the oldest monitored live job: about 4 to 8
-- hours of background reading, owner-privacy mailboxes (jan, marnin) under the
-- reader's privacy rule. No model call places a deep row (history_tier deep is
-- never asked). Off switch: scripts/context-email-deep-flag-off.sql, or the
-- capture lane.
--
-- Guards (each refuses, writing nothing): the migration is not in the ledger;
-- the flag row is missing or already on; a reader flag or the capture lane is
-- off; the cron job is missing or inactive (pg_cron row security can hide
-- another role's job: run as postgres); the update does not touch exactly one
-- row.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
DECLARE f jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20261007080000')
 THEN RAISE EXCEPTION 'deep_flag_on_refused: 20261007080000 is not applied'; END IF;
 IF (SELECT count(*) FROM public.feature_flags WHERE flag_name='email_reader_deep_v1' AND NOT enabled)<>1
 THEN RAISE EXCEPTION 'deep_flag_on_refused: email_reader_deep_v1 is missing or already on'; END IF;
 f:=public.context_email_reader_flags();
 IF NOT (coalesce((f->>'reader')::boolean,false) AND coalesce((f->>'schedule')::boolean,false) AND coalesce((f->>'program')::boolean,false))
 THEN RAISE EXCEPTION 'deep_flag_on_refused: a reader flag is off %',f; END IF;
 IF NOT public.automation_lane_enabled('capture') THEN RAISE EXCEPTION 'deep_flag_on_refused: the capture lane is off'; END IF;
 IF (SELECT count(*) FROM cron.job WHERE jobname='outlook-mail-deep-history' AND active)<>1
 THEN RAISE EXCEPTION 'deep_flag_on_refused: cron job outlook-mail-deep-history is missing or inactive'; END IF;
END $$;

SELECT 'before' AS which, flag_name, enabled, updated_at FROM public.feature_flags WHERE flag_name='email_reader_deep_v1';

DO $$
DECLARE n integer;
BEGIN
 UPDATE public.feature_flags SET enabled=true, updated_at=now() WHERE flag_name='email_reader_deep_v1' AND NOT enabled;
 GET DIAGNOSTICS n = ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'deep_flag_on_refused: expected exactly 1 row, updated %',n; END IF;
END $$;

SELECT 'after' AS which, flag_name, enabled, updated_at FROM public.feature_flags WHERE flag_name='email_reader_deep_v1';

ROLLBACK;
