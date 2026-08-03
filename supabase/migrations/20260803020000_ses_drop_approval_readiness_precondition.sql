-- SES: drop the unsatisfiable readiness precondition from the APPROVAL path.
--
-- Captain's decision date: 2026-08-03. This is the SAME ruling as
-- 20260803010000_ses_drop_unsatisfiable_readiness_precondition.sql, extended to
-- the third and last instance on the approval path after the captain was shown
-- that clearing the first two still left him unable to approve anything.
--
-- Read 20260803010000's header first: it carries the full diagnosis of why
-- `makesafe_readiness_current.ready` can never become true (Phase 1 shipped the
-- compare-only shadow and its invalidator; the Phase 2 producer that would
-- commit the first READY revision was never built), and the production
-- measurement behind it.
--
-- WHY THIS FILE EXISTS SEPARATELY
-- ------------------------------
-- 20260803010000 replaces two function bodies and writes zero rows. This one
-- additionally relaxes a table constraint, which is a different risk class and
-- deserves its own rollback twin. It was also authorised later on the same day.
--
-- THE THIRD GATE
-- --------------
-- `record_ses_revision_approval_v1` (20260728020000, lines 979-997) bundles TWO
-- different tests into one IF:
--
--   1. `NOT FOUND` (from an INNER JOIN onto makesafe_readiness_revisions, a table
--      with zero rows in production) plus `NOT current_readiness.ready` plus
--      `NOT current_readiness.revision_ready`
--        -> the unsatisfiable readiness-certification test. DROPPED here.
--
--   2. `readiness_revision IS DISTINCT FROM p_approval->>'readiness_revision'`
--      and `dependency_generation IS DISTINCT FROM (...)::bigint`
--        -> a GENUINE optimistic-concurrency check comparing what the cockpit
--           displayed to the operator against what the row says now. This is what
--           the message 'new evidence landed' actually describes, it is
--           satisfiable (dependency_generation is a real, moving, non-null value
--           bumped by every invalidation), and it is KEPT VERBATIM. Dropping (1)
--           makes it reachable for the first time.
--
-- The INNER JOIN becomes a LEFT JOIN so the current readiness row is found even
-- when no revision has ever been certified, and the ready/revision_ready tests
-- move inside a certified branch. Two equivalences hold:
--
--   * a NULL `makesafe_readiness_current` row still refuses, because NOT FOUND is
--     kept as its own test;
--   * a NON-NULL readiness_revision with no matching row in
--     makesafe_readiness_revisions used to refuse via NOT FOUND, and now refuses
--     via `NOT COALESCE(revision_ready, false)` inside the certified branch --
--     same message, same SQLSTATE 40001.
--
-- Readiness is NOT asserted. Nothing here writes `ready`, and this function never
-- calls `commit_makesafe_readiness`.
--
-- WHY A CONSTRAINT CHANGE IS UNAVOIDABLE
-- --------------------------------------
-- Dropping the RAISE is necessary but not sufficient. This function inserts into
-- `makesafe_revision_approvals`, whose readiness identity column was declared
-- (20260728000001_makesafe_state_authority_u2.sql):
--
--     readiness_revision text NOT NULL CHECK (readiness_revision ~ '^sha256:[0-9a-f]{64}$')
--
-- Production's `makesafe_readiness_current.readiness_revision` is NULL on all 191
-- rows, so the cockpit passes null and the INSERT would fail 23502 four
-- statements after the gate -- swapping a 40001 for a 23502 and leaving the
-- captain exactly as unable to approve. The only alternative would be to
-- synthesise a `sha256:...` value, which is fabricating a readiness identity on
-- the money path and is precisely what the ruling forbids.
--
-- So the column is relaxed to allow NULL while keeping the format CHECK for every
-- non-null value. This is not an invented pattern: it is the shape its own
-- neighbour `approval_content_hash` already uses in this table
-- (20260728020000, lines 383-389).
--
-- NULL is the truthful record, and it is the audit trail the ruling asked for: a
-- NULL readiness_revision on an approval row can only arise from this path, so
-- "which approvals were recorded without certified readiness" is a single
-- predicate on the table itself.
--
-- Safe because: the table has ZERO rows in production, so there is nothing to
-- backfill; no index or unique constraint references the column; and the
-- append-only trigger fires BEFORE UPDATE OR DELETE only, so inserts and DDL do
-- not disturb it and the table stays append-only.
--
-- NOT TOUCHED, and NOT authorised by this ruling:
--   * the money seal (`jobs.ses_money_sealed_at`) and its fence;
--   * the human APPROVE INVOICE gate in `ses_reporting_actions.ts`
--     (`operatorAuth.mode == 'jwt'` AND `auth.user`) -- an identified human login
--     is still required to reach this RPC at all, and this migration does not
--     weaken it;
--   * the SES release allowlist, the mechanically-clean requirement, and the
--     Captain-override authority test in this same function;
--   * the two EXECUTION sites that also test the same unsatisfiable readiness:
--     the `makesafe_revision_approvals_current_v2` view
--     (`WHERE readiness.ready = true`) and
--     `begin_ses_invoice_execution_v1` / `begin_ses_release_execution_v1`.
--     Those guard the step that actually calls Xero. The consequence is
--     deliberate and stated plainly: after this migration the captain can press
--     APPROVE INVOICE and have the decision durably recorded; creating the Xero
--     invoice still refuses until those sites are separately ruled on.
--
-- HOW TO RESTORE THE PRECONDITION
-- -------------------------------
-- supabase/rollbacks/20260803020000_..._down.sql restores the exact pre-existing
-- function body and re-imposes NOT NULL. Note it can only re-impose NOT NULL if
-- no approval row carries a NULL readiness_revision, which is the honest
-- consequence of having recorded them truthfully.
--
-- Restore it once, and only once, a Phase-2 readiness producer can legitimately
-- commit a READY readiness revision without a caller asserting it -- concretely a
-- SECURITY DEFINER derivation that takes no caller-supplied `ready` flag, so
-- `commit_makesafe_readiness`'s `p_ready boolean` parameter stops being assertable
-- by any service_role caller. Until such a producer exists,
-- `makesafe_readiness_revisions` stays empty and restoring the precondition
-- re-blocks every approval on the board.
--
-- This migration writes ZERO rows. It relaxes one column constraint and replaces
-- one function body.

-- Drop whichever CHECK constraint currently governs readiness_revision. Looked up
-- by definition rather than by name because this repo's migrations and the live
-- schema are known to drift, and a name guess that misses would leave the old
-- NOT NULL-era CHECK in force.
DO $$
DECLARE
  doomed_constraint text;
BEGIN
  FOR doomed_constraint IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'makesafe_revision_approvals'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) LIKE '%readiness_revision%'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.makesafe_revision_approvals DROP CONSTRAINT %I',
      doomed_constraint
    );
  END LOOP;
END;
$$;

ALTER TABLE public.makesafe_revision_approvals
  ALTER COLUMN readiness_revision DROP NOT NULL;

ALTER TABLE public.makesafe_revision_approvals
  ADD CONSTRAINT makesafe_revision_approvals_readiness_revision_check CHECK (
    readiness_revision IS NULL
    OR readiness_revision ~ '^sha256:[0-9a-f]{64}$'
  );

COMMENT ON COLUMN public.makesafe_revision_approvals.readiness_revision IS
  'The certified readiness revision this decision was taken against. NULL means '
  'the decision was recorded while no readiness revision had ever been certified '
  'for the job -- the state of every job on this board, because the Phase 2 '
  'readiness producer was never built. Captain ruling 2026-08-03 dropped the '
  'unsatisfiable precondition rather than asserting readiness, so NULL here is '
  'the honest record of that, and is the predicate for "approved without '
  'certified readiness".';

-- Fail the migration loudly rather than half-applying if the relaxation did not
-- take, so a drifted production schema surfaces here instead of as a 23502 the
-- first time the captain presses the button.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'makesafe_revision_approvals'
      AND column_name = 'readiness_revision'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION
      'makesafe_revision_approvals.readiness_revision is still NOT NULL';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_ses_revision_approval_v1(
  p_approval jsonb
)
RETURNS public.makesafe_revision_approvals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_readiness record;
  readiness_certified boolean;
  operator_row public.ses_release_operators%ROWTYPE;
  inserted public.makesafe_revision_approvals%ROWTYPE;
  target_action text := p_approval->>'action';
  target_operator uuid := (p_approval->>'operator_id')::uuid;
  target_admin_owner boolean := COALESCE((p_approval->>'is_admin_owner')::boolean, false);
  target_clean boolean := COALESCE((p_approval->>'clean')::boolean, false);
  target_captain_override boolean :=
    COALESCE((p_approval->>'captain_override')::boolean, false);
BEGIN
  IF target_action NOT IN ('invoice', 'release') THEN
    RAISE EXCEPTION 'SES approval action must be invoice or release'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO operator_row
  FROM public.ses_release_operators
  WHERE user_id = target_operator AND active = true;
  IF NOT FOUND AND NOT target_admin_owner THEN
    RAISE EXCEPTION 'operator is not on the SES release allowlist'
      USING ERRCODE = '42501';
  END IF;
  IF NOT target_clean
     AND NOT target_admin_owner
     AND COALESCE(operator_row.operator_class, '') NOT IN ('captain', 'admin_owner') THEN
    RAISE EXCEPTION 'this docket is not mechanically clean; Captain approval is required'
      USING ERRCODE = '42501';
  END IF;
  IF target_captain_override
     AND NOT target_admin_owner
     AND COALESCE(operator_row.operator_class, '') NOT IN ('captain', 'admin_owner') THEN
    RAISE EXCEPTION 'Captain override requires Captain or admin-owner authority'
      USING ERRCODE = '42501';
  END IF;

  -- LEFT JOIN, not INNER JOIN: makesafe_readiness_revisions is empty until a
  -- Phase 2 producer exists, and an INNER JOIN made every approval unreachable.
  SELECT
    current_row.*,
    revision.ready AS revision_ready
  INTO current_readiness
  FROM public.makesafe_readiness_current current_row
  LEFT JOIN public.makesafe_readiness_revisions revision
    ON revision.job_id = current_row.job_id
   AND revision.readiness_revision = current_row.readiness_revision
  WHERE current_row.job_id = (p_approval->>'job_id')::uuid
  FOR UPDATE OF current_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'new evidence landed; review the current docket revision again'
      USING ERRCODE = '40001';
  END IF;

  readiness_certified := current_readiness.readiness_revision IS NOT NULL;

  -- Certified: the original readiness test in full. Captain ruling 2026-08-03
  -- dropped this test ONLY for the uncertified case, and never asserts readiness.
  IF readiness_certified
     AND (
       NOT current_readiness.ready
       OR NOT COALESCE(current_readiness.revision_ready, false)
     ) THEN
    RAISE EXCEPTION 'new evidence landed; review the current docket revision again'
      USING ERRCODE = '40001';
  END IF;

  -- The genuine freshness check, unchanged, and now reachable: what the cockpit
  -- displayed to this operator must still be what the row says.
  IF current_readiness.readiness_revision IS DISTINCT FROM
       p_approval->>'readiness_revision'
     OR current_readiness.dependency_generation IS DISTINCT FROM
       (p_approval->>'dependency_generation')::bigint THEN
    RAISE EXCEPTION 'new evidence landed; review the current docket revision again'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.makesafe_revision_approvals (
    org_id,
    job_id,
    action,
    decision,
    readiness_revision,
    dependency_generation,
    docket_revision_id,
    release_revision_id,
    invoice_obligation_revision_id,
    approval_content_hash,
    includes_authorise,
    clean_at_decision,
    captain_override,
    operator_id,
    decided_by,
    evidence_refs
  ) VALUES (
    (p_approval->>'org_id')::uuid,
    (p_approval->>'job_id')::uuid,
    target_action,
    'approved',
    p_approval->>'readiness_revision',
    (p_approval->>'dependency_generation')::bigint,
    NULLIF(p_approval->>'docket_revision_id', '')::uuid,
    NULLIF(p_approval->>'release_revision_id', '')::uuid,
    NULLIF(p_approval->>'invoice_obligation_revision_id', '')::uuid,
    p_approval->>'approval_content_hash',
    COALESCE((p_approval->>'includes_authorise')::boolean, false),
    target_clean,
    target_captain_override,
    target_operator,
    p_approval->>'decided_by',
    COALESCE(p_approval->'evidence_refs', '[]'::jsonb)
  )
  RETURNING * INTO inserted;

  INSERT INTO public.ses_review_feedback_events (
    docket_revision_id,
    job_id,
    change_type,
    before_value,
    after_value,
    operator_id,
    operator
  ) VALUES (
    (p_approval->>'docket_revision_id')::uuid,
    (p_approval->>'job_id')::uuid,
    target_action || '_approval',
    'null'::jsonb,
    jsonb_build_object(
      'approval_id', inserted.id,
      'approval_content_hash', p_approval->>'approval_content_hash',
      'readiness_revision', p_approval->>'readiness_revision',
      'dependency_generation', (p_approval->>'dependency_generation')::bigint
    ),
    target_operator,
    p_approval->>'decided_by'
  );
  RETURN inserted;
END;
$$;

-- Grants are unchanged by CREATE OR REPLACE, but restated so a fresh
-- migration-provisioned database that somehow replays only this file still lands
-- on the same closed boundary as 20260728020000.
REVOKE ALL ON FUNCTION public.record_ses_revision_approval_v1(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_ses_revision_approval_v1(jsonb)
  TO service_role;

COMMENT ON FUNCTION public.record_ses_revision_approval_v1(jsonb) IS
  'SES U5/U6 approval record. Captain ruling 2026-08-03 removed the unsatisfiable '
  'makesafe_readiness_current.ready precondition; readiness is verified when '
  'certified and never asserted. The optimistic-concurrency check on '
  'readiness_revision and dependency_generation is unchanged, as are the release '
  'allowlist, mechanically-clean and Captain-override authority tests. An approval '
  'recorded without a certified readiness revision carries a NULL '
  'readiness_revision.';
