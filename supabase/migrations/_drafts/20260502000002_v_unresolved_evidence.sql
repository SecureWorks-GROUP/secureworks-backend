-- T7 Loop 1 — Unresolved evidence quarantine view (DRAFT — NOT YET APPLIED)
--
-- Status: draft only. Apply only after explicit user approval naming this
-- migration ("apply 20260502000002_v_unresolved_evidence.sql").
--
-- Roadmap: cio/operations/2026-05-02-t7-evidence-capture-spine-roadmap.md (Section 3)
-- Depends on: 20260502000001_t7_spine_envelope.sql (must apply first)
--
-- Why:
-- Evidence that cannot be safely matched to a job/contact must be visible,
-- not silently dropped. This view surfaces every spine row whose
-- match_status is unresolved or ambiguous, ordered by recency. Powers the
-- Evidence Health page's quarantine panel and the future operator-side
-- "manual link" workflow.
--
-- The view duplicates no rows. It is a thin projection over business_events
-- so there is no second source of truth.
--
-- Backfill: none. View is a logical projection.
--
-- Rollback:
--   DROP VIEW IF EXISTS public.v_unresolved_evidence;
--   Time-to-revert: <1s.
--
-- Downstream: read-only consumers (Evidence Health page, daily-digest
-- stale-channel alarms, future link_evidence operator action). No writes.

BEGIN;

CREATE OR REPLACE VIEW public.v_unresolved_evidence AS
SELECT
  id,
  occurred_at,
  recorded_at,
  channel,
  direction,
  source_table,
  source_id,
  contact_id,
  thread_key,
  conversation_key,
  match_status,
  match_confidence,
  match_method,
  body_preview,
  safe_summary,
  event_type,
  source,
  payload,
  metadata
FROM public.business_events
WHERE match_status IN ('unresolved','ambiguous')
ORDER BY occurred_at DESC;

COMMENT ON VIEW public.v_unresolved_evidence IS
  'T7 quarantine view: every spine row whose match_status is unresolved or ambiguous. Read-only projection over business_events; never duplicates rows. Ordered by recency. Consumed by Evidence Health page and operator manual-link workflow.';

-- View inherits business_events RLS policies. No additional policy needed.

COMMIT;
