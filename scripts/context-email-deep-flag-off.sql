-- Undo scripts/context-email-deep-flag-on.sql: switch the deep email history
-- load off (feature flag email_reader_deep_v1, on to off).
--
-- DRY RUN: this file ends in ROLLBACK and changes nothing. Running it for real
-- is a flag change: the owner's go, then change the final ROLLBACK to COMMIT
-- and nothing else. The next tick idles (email_reader_deep_v1_off) and the
-- reader refuses mode deep; a run already going finishes its slice. The plan,
-- reach and member rows stay as they are, so switching on again carries on
-- where it stopped; rows already saved stay saved (ordinary evidence).
--
-- Guard: the update must touch exactly one row (the flag must exist and be on).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

SELECT 'before' AS which, flag_name, enabled, updated_at FROM public.feature_flags WHERE flag_name='email_reader_deep_v1';

DO $$
DECLARE n integer;
BEGIN
 UPDATE public.feature_flags SET enabled=false, updated_at=now() WHERE flag_name='email_reader_deep_v1' AND enabled;
 GET DIAGNOSTICS n = ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'deep_flag_off_refused: expected exactly 1 row (the flag on), updated %',n; END IF;
END $$;

SELECT 'after' AS which, flag_name, enabled, updated_at FROM public.feature_flags WHERE flag_name='email_reader_deep_v1';

ROLLBACK;
