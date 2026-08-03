-- ROLLBACK of 20260803020000_ses_drop_approval_readiness_precondition.sql
--
-- Restores `record_ses_revision_approval_v1` EXACTLY as 20260728020000 defined
-- it, including the `NOT FOUND OR NOT current_readiness.ready OR NOT
-- current_readiness.revision_ready` precondition, and re-imposes NOT NULL on
-- `makesafe_revision_approvals.readiness_revision`.
--
-- READ THIS BEFORE RUNNING IT. As of the captain's ruling on 2026-08-03 that
-- precondition is UNSATISFIABLE: `makesafe_readiness_revisions` is empty in
-- production, the INNER JOIN below therefore finds nothing for every job, and
-- restoring it re-blocks every APPROVE INVOICE press on the board. Only run this
-- once a Phase-2 readiness producer can legitimately commit a READY readiness
-- revision without a caller asserting one.
--
-- Note the NOT NULL restoration is NOT unconditionally possible, and that is the
-- honest consequence of having recorded uncertified approvals truthfully: it
-- fails if any approval row carries a NULL readiness_revision. Those rows are the
-- decisions the captain took under the 2026-08-03 ruling. Do not delete or
-- backfill them to make this run -- decide what they should say first.
--
-- The function body below is byte-identical to lines 935-1060 of
-- supabase/migrations/20260728020000_makesafe_ses_invoice_release_u5_u6.sql.

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

  SELECT
    current_row.*,
    revision.ready AS revision_ready
  INTO current_readiness
  FROM public.makesafe_readiness_current current_row
  JOIN public.makesafe_readiness_revisions revision
    ON revision.job_id = current_row.job_id
   AND revision.readiness_revision = current_row.readiness_revision
  WHERE current_row.job_id = (p_approval->>'job_id')::uuid
  FOR UPDATE OF current_row;
  IF NOT FOUND
     OR NOT current_readiness.ready
     OR NOT current_readiness.revision_ready
     OR current_readiness.readiness_revision IS DISTINCT FROM p_approval->>'readiness_revision'
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

REVOKE ALL ON FUNCTION public.record_ses_revision_approval_v1(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_ses_revision_approval_v1(jsonb)
  TO service_role;

COMMENT ON FUNCTION public.record_ses_revision_approval_v1(jsonb) IS NULL;

-- Re-impose the pre-ruling column contract. This RAISEs rather than silently
-- succeeding if any approval was recorded without a certified readiness revision.
DO $$
DECLARE
  uncertified_approvals bigint;
BEGIN
  SELECT count(*) INTO uncertified_approvals
  FROM public.makesafe_revision_approvals
  WHERE readiness_revision IS NULL;
  IF uncertified_approvals > 0 THEN
    RAISE EXCEPTION
      'cannot restore NOT NULL: % approval row(s) were recorded without a certified readiness revision under the 2026-08-03 ruling',
      uncertified_approvals;
  END IF;
END;
$$;

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
  ALTER COLUMN readiness_revision SET NOT NULL;

ALTER TABLE public.makesafe_revision_approvals
  ADD CONSTRAINT makesafe_revision_approvals_readiness_revision_check CHECK (
    readiness_revision ~ '^sha256:[0-9a-f]{64}$'
  );

COMMENT ON COLUMN public.makesafe_revision_approvals.readiness_revision IS NULL;
