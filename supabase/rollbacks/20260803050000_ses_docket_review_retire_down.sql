-- ROLLBACK of 20260803050000_ses_docket_review_retire.sql
--
-- Restores the Docs Ready review ledger EXACTLY as 20260728210000 defined it:
-- the queue view without the retired-docket exclusion, the original
-- review_state / event_kind / shape CHECK constraints, and no retire function
-- or retire columns.
--
-- READ THIS BEFORE RUNNING IT. This rollback can only succeed while
-- ZERO retired review events exist:
--
--   * the restored CHECK constraints reject event_kind/review_state 'retired'
--     rows, so Postgres will refuse to re-add them while any retire event is
--     present; and
--   * the append-only trigger on ses_docket_review_events forbids deleting
--     those rows to make the constraint fit.
--
-- That is deliberate: a retire is an audit event, and audit history is not
-- edited to make a rollback convenient. If dockets have already been retired
-- (captain ruling R4, 2026-08-03), treat retire as a one-way door and fix
-- forward instead of running this file.
--
-- While zero retired events exist this file is a clean, complete restore:
-- the two added columns are dropped (they are NULL on every pre-retire row),
-- the view loses only the `WHERE event.review_state <> 'retired'` predicate,
-- and the retire function is dropped. The view definition below is
-- byte-identical to lines 91-121 of
-- supabase/migrations/20260728210000_makesafe_ses_docs_ready_signoff.sql.

DROP FUNCTION IF EXISTS public.retire_ses_docket_revision_v1(jsonb);

CREATE OR REPLACE VIEW public.ses_docket_review_current
WITH (security_invoker = true)
AS
SELECT
  docket.org_id,
  docket.job_id,
  docket.id AS docket_revision_id,
  docket.output_content_hash AS docket_output_content_hash,
  docket.assembler_version,
  docket.family_matrix_version,
  docket.stage AS docket_stage,
  docket.committed_at AS docket_committed_at,
  event.id AS review_event_id,
  event.event_sequence AS review_event_sequence,
  event.review_state,
  event.event_kind,
  event.actor_user_id,
  event.actor_identity,
  event.reason,
  event.signed_off_at,
  event.created_at AS review_state_changed_at,
  event.invalidated_signoff_event_id
FROM public.makesafe_docket_revisions_current docket
JOIN LATERAL (
  SELECT candidate.*
  FROM public.ses_docket_review_events candidate
  WHERE candidate.docket_revision_id = docket.id
  ORDER BY candidate.event_sequence DESC
  LIMIT 1
) event ON true;

REVOKE ALL ON public.ses_docket_review_current
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ses_docket_review_current TO service_role;

COMMENT ON VIEW public.ses_docket_review_current IS NULL;

ALTER TABLE public.ses_docket_review_events
  DROP CONSTRAINT IF EXISTS ses_docket_review_event_shape;
ALTER TABLE public.ses_docket_review_events
  DROP CONSTRAINT IF EXISTS ses_docket_review_events_review_state_check;
ALTER TABLE public.ses_docket_review_events
  DROP CONSTRAINT IF EXISTS ses_docket_review_events_event_kind_check;

ALTER TABLE public.ses_docket_review_events
  ADD CONSTRAINT ses_docket_review_events_review_state_check CHECK (
    review_state IN ('needs_review', 'signed_off')
  );
ALTER TABLE public.ses_docket_review_events
  ADD CONSTRAINT ses_docket_review_events_event_kind_check CHECK (
    event_kind IN ('prepared', 'content_changed', 'signed_off', 'revoked')
  );
ALTER TABLE public.ses_docket_review_events
  ADD CONSTRAINT ses_docket_review_event_shape CHECK (
    (
      event_kind IN ('prepared', 'content_changed', 'revoked')
      AND review_state = 'needs_review'
      AND signed_off_at IS NULL
    )
    OR (
      event_kind = 'signed_off'
      AND review_state = 'signed_off'
      AND actor_user_id IS NOT NULL
      AND signed_off_at IS NOT NULL
    )
  );

ALTER TABLE public.ses_docket_review_events
  DROP COLUMN IF EXISTS retire_reason_code,
  DROP COLUMN IF EXISTS retired_from_state;
