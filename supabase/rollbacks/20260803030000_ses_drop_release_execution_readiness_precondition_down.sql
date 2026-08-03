-- ROLLBACK of 20260803030000_ses_drop_release_execution_readiness_precondition.sql
--
-- Restores `begin_ses_release_execution_v1` EXACTLY as 20260728020000 defined
-- it, including the bundled `NOT FOUND OR NOT current_readiness.ready OR ...`
-- precondition in the per-member readiness loop.
--
-- READ THIS BEFORE RUNNING IT. As of the captain's ruling on 2026-08-03
-- ("Extend #511 ruling to send path") that readiness test is UNSATISFIABLE:
-- `makesafe_readiness_current.ready` is false on every row on the board and no
-- Phase-2 producer exists to set it, so restoring it re-blocks every SEND IT
-- execution on the board. Only run this once a Phase-2 readiness producer can
-- legitimately commit a READY readiness revision without a caller asserting
-- one.
--
-- The function body below is byte-identical to lines 1158-1261 of
-- supabase/migrations/20260728020000_makesafe_ses_invoice_release_u5_u6.sql.

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
    IF NOT FOUND
       OR NOT current_readiness.ready
       OR current_readiness.readiness_revision IS DISTINCT FROM
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

REVOKE ALL ON FUNCTION public.begin_ses_release_execution_v1(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_ses_release_execution_v1(uuid, text)
  TO service_role;

COMMENT ON FUNCTION public.begin_ses_release_execution_v1(uuid, text) IS NULL;
