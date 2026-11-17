-- After the down: the pending marker index is gone and the bucket index the table had before is untouched.
DO $c$
BEGIN
 IF to_regclass('public.business_events_pending_luna_marker') IS NOT NULL THEN
  RAISE EXCEPTION 'pending marker rollback: the index must be dropped';
 END IF;
 IF to_regclass('public.business_events_context_bucket') IS NULL THEN
  RAISE EXCEPTION 'pending marker rollback: the bucket index must remain';
 END IF;
END $c$;
-- The marker read still answers (by a scan) after the down.
SELECT count(*) FROM (SELECT id FROM public.business_events
 WHERE attribution_status = 'pending_luna' AND job_id IS NULL AND attribution_checked_at IS NOT NULL
 ORDER BY attribution_checked_at DESC NULLS FIRST LIMIT 1) m;
