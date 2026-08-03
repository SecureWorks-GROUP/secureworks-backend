-- SES Docs Ready: captain-gated docket RETIRE (queue eviction).
--
-- Captain ruling R4, 2026-08-03 (mission contract
-- MISSION-CONTRACT-2026-08-03-BOARD-TRUTH.md): build the audited,
-- captain-gated `retire_ses_docket_revision` action -- reason-coded,
-- audit-trailed, refusing on already-sent/executed dockets -- and use it for
-- all review-queue evictions. No direct SQL evictions.
--
-- WHY THIS EXISTS
-- ---------------
-- The Docs Ready queue (`ses_docket_review_current`) is polluted: dockets were
-- persisted on jobs already reported by hand (e.g. 261025) and on wrong-family
-- jobs (e.g. 261029, a repair). No eviction path existed, so a polluted docket
-- could sit in `needs_review` forever, or worse, be ticked and sent. Retire is
-- the eviction mechanism: a terminal review event that removes the exact
-- docket revision from the queue without touching the append-only docket
-- bytes, the money path, or any sent artifact.
--
-- DESIGN CHOICE: RETIRE IS A FIRST-CLASS TERMINAL REVIEW EVENT
-- ------------------------------------------------------------
-- The review ledger (`ses_docket_review_events`, 20260728210000) is already
-- the audit surface for the queue: every queue decision is an append-only
-- event bound to the exact docket bytes, assembler and family versions, with
-- `previous_event_id` linkage. Retire is one more event on that ledger, not a
-- status column on the docket and not a delete:
--
--   * `review_state` gains 'retired' (terminal) and `event_kind` gains
--     'retired'. The shape constraint keeps the existing arms byte-identical
--     and adds exactly one arm: a retired event carries a structured
--     `retire_reason_code` (already_reported | wrong_family | superseded |
--     captain_ruling) and `retired_from_state` -- the prior queue state,
--     recorded ON the event because a ticked pack (signed_off) can still be
--     discovered polluted before send, and the audit must show which state
--     each docket was evicted from. When the prior state is signed_off, the
--     event also sets `invalidated_signoff_event_id`, reusing the column
--     'content_changed' and 'revoked' already use to void a tick.
--   * `retire_ses_docket_revision_v1` is the atomic authority, modelled on
--     `record_ses_docket_review_state_v1`: same advisory lock domain
--     ('ses-docs-ready:<job_id>') so a retire serialises against any
--     concurrent prepare/signoff/revoke on the same job, same current-exact-
--     revision freshness check, same append-only insert. It adds the retire
--     guard rails and nothing else.
--   * The queue view keeps its exact column list (CREATE OR REPLACE preserves
--     columns and grants) and gains one predicate: the latest event must not
--     be retired. Every consumer -- the queue list, the reviewable-pack read,
--     the signoff/revoke pre-reads, and the `assert_ses_dockets_signed_off_v1`
--     send wall -- reads the view by docket_revision_id, so a retired docket
--     becomes unreachable through every one of them with no consumer edits.
--
-- GUARD RAILS (all inside the atomic function)
-- --------------------------------------------
--   * not the current exact docket revision for its job  -> refused (40001),
--     same freshness posture as signoff.
--   * already retired                                    -> refused (23514);
--     no duplicate event, so a double-retire is a clean refusal.
--   * never queued (no review events at all)             -> refused (23514);
--     there is nothing to evict.
--   * stage = 'invoice_bound'                            -> refused (23514):
--     an AUTHORISED Xero invoice is bound to these exact bytes.
--   * any invoice_create / invoice_authorise effect recorded against the
--     docket or its bound obligation revision (any state except failed /
--     compensated)                            -> refused (23514).
--   * any release containing this docket reached dispatching / released, or
--     any route_send effect exists for such a release (any state except
--     failed / compensated)                   -> refused (23514).
--     Already-sent dockets can never be retired.
--
-- An APPROVED-but-never-executed release does not block retire on purpose:
-- no send has been recorded, and the unchanged send path re-asserts the
-- Docs Ready signoff wall before reservation and before every route, so the
-- retired docket simply hard-fails there for a human to re-prepare.
--
-- WHAT THIS DOES NOT DO
-- ---------------------
--   * No change to any money-path function: commit/begin/execute invoice or
--     release bodies are untouched, as are the approval tables and views.
--   * No change to `record_ses_docket_review_state_v1`: the application layer
--     reads the queue view before every signoff/revoke/prepare call, so a
--     retired docket is already unreachable there; this migration makes the
--     minimal correct change and keeps the historical function body intact.
--   * No docket bytes are mutated or deleted; the append-only trigger on
--     `ses_docket_review_events` is untouched; this migration writes ZERO
--     rows at apply time.
--
-- HOW TO RESTORE THE GATE
-- -----------------------
-- supabase/rollbacks/20260803050000_ses_docket_review_retire_down.sql
-- restores the exact pre-retire view definition, drops the retire function,
-- and restores the original CHECK constraints. It can only run while ZERO
-- retired events exist: the restored constraints reject retired rows, and the
-- append-only trigger forbids deleting them. Read its header before running.

ALTER TABLE public.ses_docket_review_events
  ADD COLUMN IF NOT EXISTS retire_reason_code text,
  ADD COLUMN IF NOT EXISTS retired_from_state text;

ALTER TABLE public.ses_docket_review_events
  DROP CONSTRAINT IF EXISTS ses_docket_review_events_review_state_check;
ALTER TABLE public.ses_docket_review_events
  ADD CONSTRAINT ses_docket_review_events_review_state_check CHECK (
    review_state IN ('needs_review', 'signed_off', 'retired')
  );

ALTER TABLE public.ses_docket_review_events
  DROP CONSTRAINT IF EXISTS ses_docket_review_events_event_kind_check;
ALTER TABLE public.ses_docket_review_events
  ADD CONSTRAINT ses_docket_review_events_event_kind_check CHECK (
    event_kind IN ('prepared', 'content_changed', 'signed_off', 'revoked', 'retired')
  );

ALTER TABLE public.ses_docket_review_events
  DROP CONSTRAINT IF EXISTS ses_docket_review_event_shape;
ALTER TABLE public.ses_docket_review_events
  ADD CONSTRAINT ses_docket_review_event_shape CHECK (
    (
      event_kind IN ('prepared', 'content_changed', 'revoked')
      AND review_state = 'needs_review'
      AND signed_off_at IS NULL
      AND retire_reason_code IS NULL
      AND retired_from_state IS NULL
    )
    OR (
      event_kind = 'signed_off'
      AND review_state = 'signed_off'
      AND actor_user_id IS NOT NULL
      AND signed_off_at IS NOT NULL
      AND retire_reason_code IS NULL
      AND retired_from_state IS NULL
    )
    OR (
      event_kind = 'retired'
      AND review_state = 'retired'
      AND retire_reason_code IN (
        'already_reported',
        'wrong_family',
        'superseded',
        'captain_ruling'
      )
      AND retired_from_state IN ('needs_review', 'signed_off')
      AND signed_off_at IS NULL
    )
  );

COMMENT ON COLUMN public.ses_docket_review_events.retire_reason_code IS
  'Structured eviction reason (captain ruling R4, 2026-08-03): already_reported, wrong_family, superseded or captain_ruling. Set only on retired events.';
COMMENT ON COLUMN public.ses_docket_review_events.retired_from_state IS
  'The queue state the docket was evicted from (needs_review or signed_off). Set only on retired events; a ticked pack can still be discovered polluted before send.';

CREATE OR REPLACE FUNCTION public.retire_ses_docket_revision_v1(
  p_event jsonb
)
RETURNS public.ses_docket_review_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target public.makesafe_docket_revisions%ROWTYPE;
  current_event public.ses_docket_review_events%ROWTYPE;
  inserted public.ses_docket_review_events%ROWTYPE;
  target_reason_code text := btrim(COALESCE(p_event->>'retire_reason_code', ''));
  target_actor uuid := NULLIF(p_event->>'actor_user_id', '')::uuid;
  target_identity text := btrim(COALESCE(p_event->>'actor_identity', ''));
  target_reason text := NULLIF(btrim(COALESCE(p_event->>'reason', '')), '');
BEGIN
  IF jsonb_typeof(p_event) IS DISTINCT FROM 'object'
     OR NULLIF(p_event->>'docket_revision_id', '') IS NULL
     OR target_reason_code NOT IN (
       'already_reported',
       'wrong_family',
       'superseded',
       'captain_ruling'
     )
     OR target_identity = '' THEN
    RAISE EXCEPTION 'docket revision, retire reason code and actor identity are required'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO target
  FROM public.makesafe_docket_revisions
  WHERE id = (p_event->>'docket_revision_id')::uuid
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the reviewable docket revision no longer exists'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('ses-docs-ready:' || target.job_id::text, 0)
  );

  IF NOT EXISTS (
    SELECT 1
    FROM public.makesafe_docket_revisions_current current_docket
    WHERE current_docket.job_id = target.job_id
      AND current_docket.id = target.id
  ) THEN
    RAISE EXCEPTION 'new docket content exists; review the current exact revision'
      USING ERRCODE = '40001';
  END IF;

  -- Already-sent / already-executed dockets can never be retired. The effect
  -- ledger and the release state machine are the record of execution; a
  -- failed or compensated effect recorded no real-world outcome and does not
  -- block eviction.
  IF target.stage = 'invoice_bound' THEN
    RAISE EXCEPTION 'an AUTHORISED Xero invoice is bound to this exact docket; already-executed dockets can never be retired'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.ses_external_effects effect
    WHERE effect.effect_kind IN ('invoice_create', 'invoice_authorise')
      AND effect.state NOT IN ('failed', 'compensated')
      AND (
        effect.docket_revision_id = target.id
        OR (
          target.invoice_obligation_revision_id IS NOT NULL
          AND effect.invoice_obligation_revision_id =
            target.invoice_obligation_revision_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'an invoice execution is already recorded against this exact docket; already-executed dockets can never be retired'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.makesafe_release_revision_members member
    JOIN public.makesafe_release_revisions release
      ON release.id = member.release_revision_id
    WHERE member.docket_revision_id = target.id
      AND release.state IN ('dispatching', 'released')
  ) THEN
    RAISE EXCEPTION 'a release execution is already recorded against this exact docket; already-sent dockets can never be retired'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.makesafe_release_revision_members member
    JOIN public.ses_external_effects effect
      ON effect.release_revision_id = member.release_revision_id
    WHERE member.docket_revision_id = target.id
      AND effect.effect_kind = 'route_send'
      AND effect.state NOT IN ('failed', 'compensated')
  ) THEN
    RAISE EXCEPTION 'a route send is already recorded against this exact docket; already-sent dockets can never be retired'
      USING ERRCODE = '23514';
  END IF;

  SELECT *
  INTO current_event
  FROM public.ses_docket_review_events
  WHERE docket_revision_id = target.id
  ORDER BY event_sequence DESC
  LIMIT 1
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'the exact docket is not waiting in the review queue'
      USING ERRCODE = '23514';
  END IF;
  IF current_event.review_state = 'retired' THEN
    RAISE EXCEPTION 'the exact docket is already retired'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.ses_docket_review_events (
    org_id,
    job_id,
    docket_revision_id,
    docket_output_content_hash,
    assembler_version,
    family_matrix_version,
    docket_stage,
    review_state,
    event_kind,
    previous_event_id,
    invalidated_signoff_event_id,
    retire_reason_code,
    retired_from_state,
    actor_user_id,
    actor_identity,
    reason,
    signed_off_at
  ) VALUES (
    target.org_id,
    target.job_id,
    target.id,
    target.output_content_hash,
    target.assembler_version,
    target.family_matrix_version,
    target.stage,
    'retired',
    'retired',
    current_event.id,
    CASE
      WHEN current_event.review_state = 'signed_off' THEN current_event.id
      ELSE NULL
    END,
    target_reason_code,
    current_event.review_state,
    target_actor,
    target_identity,
    target_reason,
    NULL
  )
  RETURNING * INTO inserted;
  RETURN inserted;
END;
$$;

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
) event ON true
WHERE event.review_state <> 'retired';

-- Grants are unchanged by CREATE OR REPLACE, but restated so a fresh
-- migration-provisioned database that somehow replays only this file still
-- lands on the same closed boundary as 20260728210000.
REVOKE ALL ON public.ses_docket_review_current
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ses_docket_review_current TO service_role;

REVOKE ALL ON FUNCTION public.retire_ses_docket_revision_v1(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retire_ses_docket_revision_v1(jsonb)
  TO service_role;

COMMENT ON FUNCTION public.retire_ses_docket_revision_v1(jsonb) IS
  'Captain ruling R4 (2026-08-03) queue eviction: appends a terminal retired review event bound to the exact current docket bytes. Refuses non-current, already-retired, never-queued and already-sent/executed dockets.';
COMMENT ON VIEW public.ses_docket_review_current IS
  'Current per-job Docs Ready review state from the latest append-only event. Retired dockets (captain ruling R4, 2026-08-03) are excluded: eviction removes a polluted docket from every queue consumer and from the send signoff wall without touching the append-only ledger.';
