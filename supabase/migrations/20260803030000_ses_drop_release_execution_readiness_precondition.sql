-- SES: drop the unsatisfiable readiness precondition from the SEND path.
--
-- Captain's decision date: 2026-08-03 ("Extend #511 ruling to send path"). This
-- is the SAME ruling as 20260803010000_ses_drop_unsatisfiable_readiness_precondition.sql
-- and 20260803020000_ses_drop_approval_readiness_precondition.sql, extended to
-- the fourth instance of the same unsatisfiable test, in
-- `begin_ses_release_execution_v1` -- the RPC that reserves a human-approved
-- release revision for execution when the operator presses SEND IT.
--
-- Read 20260803010000's header first: it carries the full diagnosis of why
-- `makesafe_readiness_current.ready` can never become true (Phase 1 shipped the
-- compare-only shadow and its invalidator; the Phase 2 producer that would
-- commit the first READY revision was never built), and the production
-- measurement behind it (191 readiness rows, ZERO ready, ZERO rows in
-- `makesafe_readiness_revisions`, ZERO invoice obligations board-wide).
--
-- THE FOURTH GATE
-- ---------------
-- `begin_ses_release_execution_v1` (20260728020000, lines 1158-1261) bundles TWO
-- different tests into one IF per release member:
--
--   1. `NOT current_readiness.ready`
--        -> the unsatisfiable readiness-certification test. `ready` is false on
--           every row on the board and nothing can ever set it, so the send path
--           could never fire. DROPPED here -- for the uncertified case.
--
--   2. `readiness_revision IS DISTINCT FROM binding->>'readiness_revision'`
--      and `dependency_generation IS DISTINCT FROM (...)::bigint`
--        -> a GENUINE optimistic-concurrency check comparing what the cockpit
--           bound into the release revision against what the readiness row says
--           now. This is what the message 'new evidence landed' actually
--           describes, it is satisfiable (dependency_generation is a real,
--           moving, non-null value bumped by every invalidation, and a NULL
--           readiness_revision in the binding compares equal to a NULL current
--           under IS DISTINCT FROM), and it is KEPT VERBATIM. Dropping (1)
--           makes it reachable for the first time.
--
-- The bundled IF is split exactly as the approval-path fix split it:
--
--   * a NULL `makesafe_readiness_current` row still refuses, because NOT FOUND
--     is kept as its own test -- same message, same SQLSTATE 40001;
--   * a CERTIFIED readiness row (readiness_revision IS NOT NULL) is still
--     required to be ready: the original `NOT current_readiness.ready` test
--     runs unchanged inside a certified branch, so a certified-but-blocked
--     member still refuses -- same message, same SQLSTATE 40001;
--   * the concurrency check is unchanged, expression for expression.
--
-- Behaviour is therefore identical for every certified readiness state; the
-- only state whose outcome changes is the uncertified one (NULL readiness
-- revision, ready false), which is every job on this board.
--
-- Readiness is NOT asserted. Nothing here writes `ready`, this function never
-- calls `commit_makesafe_readiness`, and it does not synthesise a readiness
-- identity. Its only write remains the one it always had: the release
-- revision's own state transition to 'dispatching'.
--
-- WHY NO CONSTRAINT CHANGE IS NEEDED
-- ----------------------------------
-- Unlike the approval path, this function INSERTS nothing that carries a
-- readiness identity: the readiness bindings are READ from the immutable
-- `makesafe_release_revisions.readiness_bindings` jsonb and compared, never
-- written to a readiness-identified column. The cockpit already binds the
-- current (NULL) readiness revision into the release at commit time
-- (ses_review_cockpit.ts builds readiness_bindings from the displayed docket
-- state), so the kept freshness check passes exactly when what was displayed
-- is still what the row says. Dropping the RAISE is therefore sufficient here;
-- no column needs to learn to admit NULL.
--
-- NOT TOUCHED by this migration, and not authorised by the ruling:
--   * the money seal (`jobs.ses_money_sealed_at`) and its fence;
--   * the human SEND IT gate in `ses_reporting_actions.ts`
--     (`operatorAuth.mode == 'jwt'` AND `auth.user`) -- an identified human
--     login is still required to reach this RPC at all, and this migration
--     does not weaken it;
--   * the per-member human-approval visibility check in this same function,
--     which consults the `makesafe_revision_approvals_current_v2` view. That
--     view still carries `WHERE readiness.ready = true` (and INNER JOINs the
--     readiness identity, which no NULL-readiness approval row can satisfy),
--     so it still admits no approval recorded under the 2026-08-03 rulings.
--     The consequence is deliberate and stated plainly: after this migration
--     the readiness precondition no longer blocks the send path, but SEND IT
--     execution still refuses at 'human SEND IT approval is missing for a
--     release member' until the view is separately ruled on. The ops-api
--     double-check that reads the same view after this RPC returns
--     (`release_approval_missing`) is likewise untouched;
--   * `begin_ses_invoice_execution_v1`, the Xero invoice-creation gate, which
--     reads the same view and is a separate site from the send path ruled on
--     here;
--   * the release allowlist, the content-hash and state preconditions, the
--     member-set/bindings match, and every other refusal in this function;
--   * the readiness table, its invalidator, or any of its recording behaviour.
--
-- HOW TO RESTORE THE PRECONDITION
-- -------------------------------
-- supabase/rollbacks/20260803030000_..._down.sql restores the exact
-- pre-existing function body. Restore it once, and only once, a Phase-2
-- readiness producer can legitimately commit a READY readiness revision
-- without a caller asserting one -- concretely a SECURITY DEFINER derivation
-- that takes no caller-supplied `ready` flag, so `commit_makesafe_readiness`'s
-- `p_ready boolean` parameter stops being assertable by any service_role
-- caller. Until such a producer exists, `makesafe_readiness_revisions` stays
-- empty and restoring the precondition re-blocks every SEND IT on the board.
--
-- This migration writes ZERO rows. It replaces one function body.

CREATE OR REPLACE FUNCTION public.begin_ses_release_execution_v1(
  p_release_revision_id uuid,
  p_release_content_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_release public.makesafe_release_revisions%ROWTYPE;
  binding jsonb;
  current_readiness public.makesafe_readiness_current%ROWTYPE;
  readiness_certified boolean;
  approved_count integer := 0;
  member_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'ses-release-execute:' || p_release_revision_id::text,
      0
    )
  );

  SELECT * INTO target_release
  FROM public.makesafe_release_revisions
  WHERE id = p_release_revision_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the approved release revision no longer exists'
      USING ERRCODE = 'P0002';
  END IF;
  IF target_release.content_hash IS DISTINCT FROM p_release_content_hash THEN
    RAISE EXCEPTION 'the displayed release content no longer matches the stored revision'
      USING ERRCODE = '23514';
  END IF;
  IF target_release.state NOT IN ('approved', 'dispatching', 'released') THEN
    RAISE EXCEPTION 'human SEND IT approval is missing for this release revision'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO member_count
  FROM public.makesafe_release_revision_members
  WHERE release_revision_id = p_release_revision_id;
  IF member_count <> jsonb_array_length(target_release.readiness_bindings) THEN
    RAISE EXCEPTION 'the release member set does not match its readiness bindings'
      USING ERRCODE = '23514';
  END IF;

  FOR binding IN
    SELECT value
    FROM jsonb_array_elements(target_release.readiness_bindings)
  LOOP
    SELECT * INTO current_readiness
    FROM public.makesafe_readiness_current
    WHERE job_id = (binding->>'job_id')::uuid
    FOR UPDATE;
    -- Split out of the old bundled IF: a missing readiness row is still its own
    -- refusal. Captain's ruling 2026-08-03 dropped only the readiness half of
    -- that IF; every member of a release still has a current readiness row.
    IF NOT FOUND THEN
      RAISE EXCEPTION 'new evidence landed; review the current release revision again'
        USING ERRCODE = '40001';
    END IF;

    readiness_certified := current_readiness.readiness_revision IS NOT NULL;

    -- Certified: the original readiness test in full. Captain ruling 2026-08-03
    -- dropped this test ONLY for the uncertified case, and never asserts
    -- readiness. A certified-but-not-ready member still refuses here, exactly
    -- as before.
    IF readiness_certified
       AND NOT current_readiness.ready THEN
      RAISE EXCEPTION 'new evidence landed; review the current release revision again'
        USING ERRCODE = '40001';
    END IF;

    -- The genuine freshness check, unchanged, and now reachable: what the
    -- cockpit bound into this release revision must still be what the
    -- readiness row says now.
    IF current_readiness.readiness_revision IS DISTINCT FROM
         binding->>'readiness_revision'
       OR current_readiness.dependency_generation IS DISTINCT FROM
         (binding->>'dependency_generation')::bigint THEN
      RAISE EXCEPTION 'new evidence landed; review the current release revision again'
        USING ERRCODE = '40001';
    END IF;

    PERFORM 1
    FROM public.makesafe_revision_approvals_current_v2
    WHERE action = 'release'
      AND release_revision_id = p_release_revision_id
      AND job_id = (binding->>'job_id')::uuid
      AND approval_content_hash = p_release_content_hash;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'human SEND IT approval is missing for a release member'
        USING ERRCODE = '42501';
    END IF;
    approved_count := approved_count + 1;
  END LOOP;

  IF approved_count <> member_count THEN
    RAISE EXCEPTION 'human SEND IT approval does not cover the exact release member set'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.makesafe_release_revisions
  SET state = 'dispatching'
  WHERE id = p_release_revision_id
    AND state = 'approved';

  RETURN jsonb_build_object(
    'release_revision_id',
    p_release_revision_id,
    'content_hash',
    target_release.content_hash,
    'member_count',
    member_count,
    'state',
    CASE
      WHEN target_release.state = 'approved' THEN 'dispatching'
      ELSE target_release.state
    END
  );
END;
$$;

-- Grants are unchanged by CREATE OR REPLACE, but restated so a fresh
-- migration-provisioned database that somehow replays only this file still lands
-- on the same closed boundary as 20260728020000.
REVOKE ALL ON FUNCTION public.begin_ses_release_execution_v1(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_ses_release_execution_v1(uuid, text)
  TO service_role;

COMMENT ON FUNCTION public.begin_ses_release_execution_v1(uuid, text) IS
  'SES U6 release execution reservation (SEND IT). Captain ruling 2026-08-03 '
  '(extend #511 to the send path) removed the unsatisfiable '
  'makesafe_readiness_current.ready precondition; a certified readiness row '
  'must still be ready, readiness is never asserted, and the '
  'optimistic-concurrency check on readiness_revision and '
  'dependency_generation is unchanged. The per-member human SEND IT approval '
  'visibility check via makesafe_revision_approvals_current_v2 is unchanged.';
