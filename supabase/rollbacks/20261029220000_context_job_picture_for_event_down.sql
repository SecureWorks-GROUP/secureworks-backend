-- Down for 20261029220000_context_job_picture_for_event.sql.
--
-- Drops the event-keyed job picture. Nothing else changed, so nothing else
-- moves: context_job_picture and context_event_identity are untouched. A
-- placer that still calls the dropped function fails its picture read (jarvis
-- slice 3 then fails the row as attribution_candidates_failed, as any failed
-- candidate read does), so roll the jarvis caller back first.
-- Refuses when a later migration has since replaced the function's body: roll
-- that one back first. The function may be absent (a second run of this
-- rollback); any body it has must be this migration's, whatever its comment
-- says.

DO $guard$
DECLARE live text;
BEGIN
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_job_picture_for_event(uuid,uuid[])');
  IF live IS NOT NULL AND live <> '449f66a1cf7885f3cc5aea94beac36cb' THEN
    RAISE EXCEPTION 'context_job_picture_for_event_down_preimage_mismatch: %; roll the later migration back first',
      format('%s md5 %s', 'public.context_job_picture_for_event(uuid,uuid[])', live);
  END IF;
END $guard$;

DROP FUNCTION IF EXISTS public.context_job_picture_for_event(uuid, uuid[]);
