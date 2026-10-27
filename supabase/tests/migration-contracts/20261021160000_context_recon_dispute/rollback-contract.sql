-- After the down migration: the marker table and its two functions are gone, the job view and
-- health read are the 20261020140000 and 20261020155000 bodies, and the queue function is still there.
\set ON_ERROR_STOP 1
DO $$
BEGIN
  IF to_regclass('public.context_recon_disputes') IS NOT NULL THEN
    RAISE EXCEPTION 'recon dispute rollback: table remains';
  END IF;
  IF to_regprocedure('public.context_recon_set_dispute(uuid,uuid,text)') IS NOT NULL
     OR to_regprocedure('public.context_recon_dispute(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'recon dispute rollback: functions remain';
  END IF;
  IF to_regprocedure('public.context_recon_queue(timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'recon dispute rollback: queue function is gone';
  END IF;
  IF position('context_recon_disputes' IN pg_get_functiondef('public.context_job_view(uuid)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'recon dispute rollback: job view still reads disputes';
  END IF;
  IF position('candidate_job_ids @> ARRAY[p_job]' IN pg_get_functiondef('public.context_job_view(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'recon dispute rollback: job view lost the candidate containment';
  END IF;
  IF position('disputed_open' IN pg_get_functiondef('public.context_recon_health(timestamptz)'::regprocedure)) > 0
     OR public.context_recon_health() ? 'disputed_open' THEN
    RAISE EXCEPTION 'recon dispute rollback: health still publishes disputed_open';
  END IF;
  IF NOT (public.context_recon_health() ? 'queue_by_lane') THEN
    RAISE EXCEPTION 'recon dispute rollback: health lost queue_by_lane from 20261020155000';
  END IF;
END $$;
BEGIN;
INSERT INTO public.business_events (id, channel, direction, occurred_at, payload, event_type, source)
VALUES ('7d300000-0000-0000-0000-000000000001', 'sms', 'inbound', '2026-10-18 01:00Z', '{"body":"x"}', 'sms.inbound', 'recon-dispute-rollback');
UPDATE public.business_events SET attribution_status = 'unplaced' WHERE id = '7d300000-0000-0000-0000-000000000001';
ROLLBACK;
