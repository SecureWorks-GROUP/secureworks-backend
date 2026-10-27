-- Context reconciliation backlog lane (CTX-R1 follow-up), 20 Oct 2026.
-- Design: context-system contract ctx-reconciliation-workflow-design-v2.1-20261020.md, section 14.1.
-- Builds on 20261020140000_context_reconciliation_decisions.sql, which must be live first.
--
-- live_from is go-live day. A queued row is in the live lane when it was captured on or after
-- live_from, or when its contact has any row captured on or after live_from. Every other queued
-- row is backlog, worked by the backlog plan rather than the daily list. The lane is read at
-- query time: nothing is copied or moved, and a backlog row stays visible and decidable. While
-- live_from is null there is no split and every row is live. This migration leaves it null, so
-- applying it changes no lane. It is set by migration or a hand-run update on the owner's word,
-- never by a caller.
--
-- 1. context_recon_settings: one row (id true), live_from, updated_at. RLS on, service role reads.
-- 2. context_recon_live_from(): the one read of live_from.
-- 3. context_recon_queue gains lane ('live' or 'backlog') and lane_reason (no_live_from,
--    captured_after_live_from, contact_active_since_live_from, captured_before_live_from). Its
--    other columns and rows are unchanged. The return type changes, so it is dropped and created.
-- 4. context_recon_health gains queue_by_lane.
-- Writes no business row. Service role only, as in 20261020140000.

DO $$
BEGIN
  IF to_regclass('public.context_reconciliation_decisions') IS NULL
     OR to_regprocedure('public.context_recon_decision_state(uuid)') IS NULL THEN
    RAISE EXCEPTION 'context_recon_lane_prerequisite_missing: apply 20261020140000_context_reconciliation_decisions first';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.context_recon_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  live_from timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO public.context_recon_settings (id, live_from) VALUES (true, NULL) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.context_recon_settings ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.context_recon_settings IS
  'Context reconciliation settings (20261020155000). One row. live_from splits the queue into live and backlog lanes; null means no split.';
REVOKE ALL ON public.context_recon_settings FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON public.context_recon_settings FROM anon, authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT SELECT ON public.context_recon_settings TO service_role';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.context_recon_live_from() RETURNS timestamptz
LANGUAGE sql STABLE AS $$ SELECT s.live_from FROM public.context_recon_settings s WHERE s.id $$;

DROP FUNCTION IF EXISTS public.context_recon_queue(timestamptz);
CREATE OR REPLACE FUNCTION public.context_recon_queue(p_as_of timestamptz DEFAULT now())
RETURNS TABLE (event_id uuid, channel text, waiting_days numeric, candidates int,
               cause text, decision_state text, last_action text, owner text, lane text, lane_reason text)
LANGUAGE sql STABLE AS $$
  WITH lf AS (SELECT public.context_recon_live_from() AS t),
  pool AS (
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
         CASE WHEN s.state = 'decided' AND s.action = 'escalate' THEN s.escalate_to ELSE 'context_resolver' END,
         CASE WHEN l.reason = 'captured_before_live_from' THEN 'backlog' ELSE 'live' END,
         l.reason
  FROM pool p JOIN public.business_events e ON e.id = p.id
  CROSS JOIN lf
  CROSS JOIN LATERAL (SELECT CASE
      WHEN lf.t IS NULL THEN 'no_live_from'
      WHEN coalesce(e.context_captured_at, e.occurred_at) >= lf.t THEN 'captured_after_live_from'
      WHEN e.contact_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM public.business_events n WHERE n.contact_id = e.contact_id
               AND coalesce(n.context_captured_at, n.occurred_at) >= lf.t) THEN 'contact_active_since_live_from'
      ELSE 'captured_before_live_from' END AS reason) l
  CROSS JOIN LATERAL public.context_recon_decision_state(e.id) s
  WHERE NOT (s.state = 'decided' AND s.action IN ('confirm','correct','split','unrelated'))
$$;
COMMENT ON FUNCTION public.context_recon_queue(timestamptz) IS
  'Context reconciliation queue (20261020155000). What needs a person, with cause, owner and lane (live or backlog by live_from).';

-- Counts for the daily health row: held re-placements (all time and since p_since), the queue
-- by cause and the queue by lane.
CREATE OR REPLACE FUNCTION public.context_recon_health(p_since timestamptz DEFAULT now() - interval '1 day')
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'held_total', (SELECT count(*) FROM public.business_events e WHERE e.metadata ? 'recon_held'),
    'held_since', (SELECT count(*) FROM public.business_events e
                   WHERE e.metadata ? 'recon_held' AND (e.metadata -> 'recon_held' ->> 'at')::timestamptz >= p_since),
    'queue_by_cause', coalesce((SELECT jsonb_object_agg(cause, n) FROM
                       (SELECT q.cause, count(*) AS n FROM public.context_recon_queue() q GROUP BY q.cause) c), '{}'::jsonb),
    'queue_by_lane', coalesce((SELECT jsonb_object_agg(lane, n) FROM
                       (SELECT q.lane, count(*) AS n FROM public.context_recon_queue() q GROUP BY q.lane) c), '{}'::jsonb))
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.context_recon_live_from()',
    'public.context_recon_queue(timestamptz)',
    'public.context_recon_health(timestamptz)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', f);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
END $$;
