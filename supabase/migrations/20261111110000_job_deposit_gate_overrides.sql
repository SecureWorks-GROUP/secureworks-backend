-- RQ-19.e: no materials are ordered and no crew starts on a fencing or patio
-- job until every paying party has accepted and paid its deposit (owner,
-- 10 Nov 2026). The override is the owner and the office, with a reason
-- recorded. This table is that record and nothing else: the gate itself is
-- ops-api/job_start_deposits.ts. One live override per job; a revoke is the
-- only change a row ever takes, and it is one way.
BEGIN;

CREATE TABLE IF NOT EXISTS public.job_deposit_gate_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id),
  reason text NOT NULL,
  unpaid_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  granted_by uuid NOT NULL REFERENCES public.users(id),
  granted_by_email text,
  granted_by_role text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES public.users(id),
  revoke_reason text,
  CONSTRAINT job_deposit_gate_overrides_reason_check
    CHECK (length(btrim(reason)) >= 10),
  CONSTRAINT job_deposit_gate_overrides_unpaid_reasons_check
    CHECK (jsonb_typeof(unpaid_reasons) = 'array'),
  CONSTRAINT job_deposit_gate_overrides_role_check
    CHECK (granted_by_role IN ('admin', 'owner', 'ops_manager')),
  CONSTRAINT job_deposit_gate_overrides_revoke_check CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL
        AND length(btrim(coalesce(revoke_reason, ''))) >= 3)
  )
);
COMMENT ON TABLE public.job_deposit_gate_overrides IS
  'Deposit gate overrides (20261111110000, RQ-19.e): the owner or the office lets materials be ordered and crew start before every paying party has accepted and paid, with a reason. Written only by grant_job_deposit_gate_override and revoke_job_deposit_gate_override.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_job_deposit_gate_overrides_live
  ON public.job_deposit_gate_overrides (job_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_job_deposit_gate_overrides_job
  ON public.job_deposit_gate_overrides (job_id, granted_at DESC);

ALTER TABLE public.job_deposit_gate_overrides ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_deposit_gate_overrides FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.job_deposit_gate_overrides TO service_role;
DROP POLICY IF EXISTS job_deposit_gate_overrides_service_role_read ON public.job_deposit_gate_overrides;
CREATE POLICY job_deposit_gate_overrides_service_role_read ON public.job_deposit_gate_overrides
  FOR SELECT TO service_role USING (true);

-- A row is never deleted and never edited, except a live row being revoked
-- once (only the three revoke columns move).
CREATE OR REPLACE FUNCTION public.job_deposit_gate_overrides_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
     AND NEW.id = OLD.id AND NEW.org_id = OLD.org_id AND NEW.job_id = OLD.job_id
     AND NEW.reason = OLD.reason AND NEW.unpaid_reasons = OLD.unpaid_reasons
     AND NEW.granted_by = OLD.granted_by
     AND NEW.granted_by_email IS NOT DISTINCT FROM OLD.granted_by_email
     AND NEW.granted_by_role = OLD.granted_by_role AND NEW.granted_at = OLD.granted_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'deposit gate overrides are append only; a live one may only be revoked'
    USING ERRCODE = '23514';
END $$;
DROP TRIGGER IF EXISTS trg_job_deposit_gate_overrides_guard ON public.job_deposit_gate_overrides;
CREATE TRIGGER trg_job_deposit_gate_overrides_guard
  BEFORE UPDATE OR DELETE ON public.job_deposit_gate_overrides
  FOR EACH ROW EXECUTE FUNCTION public.job_deposit_gate_overrides_guard();
DROP TRIGGER IF EXISTS trg_job_deposit_gate_overrides_no_truncate ON public.job_deposit_gate_overrides;
CREATE TRIGGER trg_job_deposit_gate_overrides_no_truncate
  BEFORE TRUNCATE ON public.job_deposit_gate_overrides
  FOR EACH STATEMENT EXECUTE FUNCTION public.job_deposit_gate_overrides_guard();

-- The database checks who is asking, not only the caller: the person must be
-- an admin, owner or ops manager of the job's own company.
CREATE OR REPLACE FUNCTION public.grant_job_deposit_gate_override(
  p_job_id uuid, p_user_id uuid, p_reason text, p_unpaid_reasons jsonb DEFAULT '[]'::jsonb)
RETURNS public.job_deposit_gate_overrides
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_job record; v_user record; v_row public.job_deposit_gate_overrides;
BEGIN
  SELECT id, org_id INTO v_job FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DG404 deposit_gate_job_not_found' USING ERRCODE = 'P0001';
  END IF;
  SELECT id, org_id, role, email INTO v_user FROM public.users WHERE id = p_user_id;
  IF NOT FOUND OR v_user.role IS NULL OR v_user.role NOT IN ('admin', 'owner', 'ops_manager')
     OR v_user.org_id IS DISTINCT FROM v_job.org_id THEN
    RAISE EXCEPTION 'DG403 deposit_gate_override_not_allowed' USING ERRCODE = 'P0001';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'DG400 deposit_gate_override_reason_required' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.job_deposit_gate_overrides
             WHERE job_id = p_job_id AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'DG409 deposit_gate_override_exists' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.job_deposit_gate_overrides(
      org_id, job_id, reason, unpaid_reasons, granted_by, granted_by_email, granted_by_role)
    VALUES (v_job.org_id, p_job_id, btrim(p_reason),
      CASE WHEN jsonb_typeof(p_unpaid_reasons) = 'array' THEN p_unpaid_reasons ELSE '[]'::jsonb END,
      v_user.id, v_user.email, v_user.role)
    RETURNING * INTO v_row;
  INSERT INTO public.job_events(job_id, event_type, user_id, detail_json)
    VALUES (p_job_id, 'deposit_gate_overridden', v_user.id, jsonb_build_object(
      'override_id', v_row.id, 'reason', v_row.reason,
      'unpaid_reasons', v_row.unpaid_reasons, 'granted_by_role', v_row.granted_by_role));
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.revoke_job_deposit_gate_override(
  p_job_id uuid, p_user_id uuid, p_reason text)
RETURNS public.job_deposit_gate_overrides
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_job record; v_user record; v_row public.job_deposit_gate_overrides;
BEGIN
  SELECT id, org_id INTO v_job FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DG404 deposit_gate_job_not_found' USING ERRCODE = 'P0001';
  END IF;
  SELECT id, org_id, role INTO v_user FROM public.users WHERE id = p_user_id;
  IF NOT FOUND OR v_user.role IS NULL OR v_user.role NOT IN ('admin', 'owner', 'ops_manager')
     OR v_user.org_id IS DISTINCT FROM v_job.org_id THEN
    RAISE EXCEPTION 'DG403 deposit_gate_override_not_allowed' USING ERRCODE = 'P0001';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'DG400 deposit_gate_revoke_reason_required' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.job_deposit_gate_overrides
    SET revoked_at = clock_timestamp(), revoked_by = v_user.id, revoke_reason = btrim(p_reason)
    WHERE job_id = p_job_id AND revoked_at IS NULL
    RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DG409 deposit_gate_override_not_live' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.job_events(job_id, event_type, user_id, detail_json)
    VALUES (p_job_id, 'deposit_gate_override_revoked', v_user.id, jsonb_build_object(
      'override_id', v_row.id, 'reason', v_row.revoke_reason));
  RETURN v_row;
END $$;

REVOKE ALL ON FUNCTION public.grant_job_deposit_gate_override(uuid, uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_job_deposit_gate_override(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_job_deposit_gate_override(uuid, uuid, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_job_deposit_gate_override(uuid, uuid, text) TO service_role;

COMMIT;
