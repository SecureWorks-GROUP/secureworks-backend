-- Down for 20261020155000_context_recon_backlog_lane. Manual only: rollbacks are never applied
-- by the deploy lane. Restores the 20261020140000 queue and health bodies (no lane), then drops
-- context_recon_live_from and context_recon_settings. A live_from that was set is lost with the
-- settings row; note it before running. Run this before the 20261020140000 down, never after.
-- Writes no business row. Re-running is a no-op.

DO $$
BEGIN
  IF to_regclass('public.context_reconciliation_decisions') IS NULL THEN
    RAISE NOTICE 'context_recon_lane_down: 20261020140000 is not live, dropping lane objects only';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.context_recon_queue(timestamptz);
CREATE OR REPLACE FUNCTION public.context_recon_queue(p_as_of timestamptz DEFAULT now())
RETURNS TABLE (event_id uuid, channel text, waiting_days numeric, candidates int,
               cause text, decision_state text, last_action text, owner text)
LANGUAGE sql STABLE AS $$
  WITH pool AS (
    SELECT e.id FROM public.business_events e
    WHERE e.attribution_status = ANY (public.context_recon_queue_statuses())
       OR (e.attribution_status IS NULL AND e.job_id IS NULL)
    UNION
    SELECT DISTINCT d.subject_id FROM public.context_reconciliation_decisions d WHERE d.subject_kind = 'event')
  SELECT e.id, e.channel,
         round(extract(epoch FROM p_as_of - coalesce(e.context_captured_at, e.occurred_at)) / 86400, 1),
         coalesce(cardinality(e.candidate_job_ids), 0),
         CASE WHEN e.contact_id IS NULL THEN 'defect:no_identity'
              WHEN e.attribution_checked_at IS NULL THEN 'defect:backfill_never_asked'
              WHEN coalesce(cardinality(e.candidate_job_ids), 0) > 1 THEN 'ambiguity:several_candidates'
              WHEN coalesce(cardinality(e.candidate_job_ids), 0) = 1 THEN 'ambiguity:one_candidate'
              ELSE 'ambiguity:no_candidate' END,
         s.state, s.action,
         CASE WHEN s.state = 'decided' AND s.action = 'escalate' THEN s.escalate_to ELSE 'context_resolver' END
  FROM pool p JOIN public.business_events e ON e.id = p.id
  CROSS JOIN LATERAL public.context_recon_decision_state(e.id) s
  WHERE NOT (s.state = 'decided' AND s.action IN ('confirm','correct','split','unrelated'))
$$;

CREATE OR REPLACE FUNCTION public.context_recon_health(p_since timestamptz DEFAULT now() - interval '1 day')
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'held_total', (SELECT count(*) FROM public.business_events e WHERE e.metadata ? 'recon_held'),
    'held_since', (SELECT count(*) FROM public.business_events e
                   WHERE e.metadata ? 'recon_held' AND (e.metadata -> 'recon_held' ->> 'at')::timestamptz >= p_since),
    'queue_by_cause', coalesce((SELECT jsonb_object_agg(cause, n) FROM
                       (SELECT q.cause, count(*) AS n FROM public.context_recon_queue() q GROUP BY q.cause) c), '{}'::jsonb))
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.context_recon_queue(timestamptz)', 'public.context_recon_health(timestamptz)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', f);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS public.context_recon_live_from();
DROP TABLE IF EXISTS public.context_recon_settings;
