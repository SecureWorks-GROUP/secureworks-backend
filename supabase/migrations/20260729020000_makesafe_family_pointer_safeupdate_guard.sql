-- Keep the intentionally board-wide family-pointer invalidation compatible
-- with production safeupdate enforcement.
--
-- `makesafe_readiness_current.job_id` is the non-null primary key, so the
-- predicate below still selects every row. It only makes that intended scope
-- explicit to the database safety guard. This migration does not seed state,
-- change a displayed status, or send a communication.

CREATE OR REPLACE FUNCTION public.invalidate_makesafe_family_pointer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_family_code text;
  v_revision_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_family_code := OLD.family_code;
    v_revision_id := OLD.revision_id;
  ELSE
    v_family_code := NEW.family_code;
    v_revision_id := NEW.revision_id;
  END IF;

  -- Family coding is not yet a stable relational job key. Invalidation is
  -- deliberately broad rather than risking a partial family match: every
  -- existing readiness pointer loses authority in the same transaction.
  PERFORM 1
  FROM public.makesafe_readiness_current
  FOR UPDATE;

  INSERT INTO public.makesafe_readiness_invalidations (
    org_id, job_id, generation_before, generation_after,
    dependency_kind, dependency_identity, reason, actor
  )
  SELECT
    c.org_id,
    c.job_id,
    c.dependency_generation,
    c.dependency_generation + 1,
    'makesafe_family_rule_current',
    v_family_code || ':' || v_revision_id::text,
    'family matrix current pointer changed',
    'db-trigger'
  FROM public.makesafe_readiness_current c;

  UPDATE public.makesafe_readiness_current
  SET dependency_generation = dependency_generation + 1,
      readiness_revision = NULL,
      attendance_cycle_set_hash = NULL,
      family_matrix_revision = NULL,
      ready = false,
      invalidated_at = transaction_timestamp(),
      invalidation_reason = 'family matrix current pointer changed',
      updated_at = transaction_timestamp()
  WHERE job_id IS NOT NULL;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
