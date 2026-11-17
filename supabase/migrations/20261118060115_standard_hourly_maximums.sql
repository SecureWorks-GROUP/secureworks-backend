-- P1-05.17: empty standard hourly settings, written only by a pay run approver.
-- Hours are issue-time wording; agreed_labour_ex remains the work order cap.
CREATE TABLE IF NOT EXISTS public.standard_hourly_maximums (
  org_id uuid NOT NULL,
  job_type text NOT NULL CHECK (char_length(btrim(job_type)) BETWEEN 1 AND 60),
  max_hours numeric(6,2) NOT NULL CHECK (max_hours > 0 AND max_hours <= 500),
  rate_ex numeric(8,2) NOT NULL CHECK (rate_ex > 0),
  set_by uuid NOT NULL REFERENCES public.users(id),
  set_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, job_type)
);
CREATE TABLE IF NOT EXISTS public.standard_hourly_maximum_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  job_type text NOT NULL,
  from_hours numeric(6,2),
  to_hours numeric(6,2),
  from_rate_ex numeric(8,2),
  to_rate_ex numeric(8,2),
  changed_by uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.standard_hourly_maximums ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.standard_hourly_maximum_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.standard_hourly_maximums, public.standard_hourly_maximum_changes
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.standard_hourly_maximums, public.standard_hourly_maximum_changes TO service_role;
DROP POLICY IF EXISTS standard_hourly_maximums_service_read ON public.standard_hourly_maximums;
CREATE POLICY standard_hourly_maximums_service_read ON public.standard_hourly_maximums
  FOR SELECT TO service_role USING (true);
DROP POLICY IF EXISTS standard_hourly_maximum_changes_service_read ON public.standard_hourly_maximum_changes;
CREATE POLICY standard_hourly_maximum_changes_service_read ON public.standard_hourly_maximum_changes
  FOR SELECT TO service_role USING (true);

CREATE OR REPLACE FUNCTION public.standard_hourly_maximum_changes_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$ BEGIN
  RAISE EXCEPTION 'standard_maximum_changes_append_only' USING ERRCODE = '23514';
END $fn$;
REVOKE ALL ON FUNCTION public.standard_hourly_maximum_changes_append_only()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS standard_hourly_maximum_changes_append_only ON public.standard_hourly_maximum_changes;
CREATE TRIGGER standard_hourly_maximum_changes_append_only
  BEFORE UPDATE OR DELETE ON public.standard_hourly_maximum_changes
  FOR EACH ROW EXECUTE FUNCTION public.standard_hourly_maximum_changes_append_only();

CREATE OR REPLACE FUNCTION public.set_standard_hourly_maximum(
  p_org_id uuid, p_job_type text, p_max_hours numeric, p_rate_ex numeric, p_actor uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_approvers uuid[];
  v_before public.standard_hourly_maximums%ROWTYPE;
  v_after public.standard_hourly_maximums%ROWTYPE;
  v_at timestamptz := clock_timestamp(); BEGIN
  -- The singleton primary key serialises edits and approval-list changes,
  -- including the first insert when this org/type has no settings row yet.
  SELECT pay_run_approver_user_ids INTO v_approvers
    FROM public.trade_pay_settings WHERE id = 1 FOR UPDATE;
  IF p_actor IS NULL OR NOT COALESCE(p_actor = ANY(v_approvers), false) THEN
    RAISE EXCEPTION 'pay_setting_not_approver' USING ERRCODE = '23514';
  END IF;
  IF (p_max_hours IS NULL) <> (p_rate_ex IS NULL) THEN
    RAISE EXCEPTION 'standard_maximum_needs_both' USING ERRCODE = '23514';
  END IF;
  -- Composite primary key bounds both the previous-row read and the write.
  SELECT * INTO v_before FROM public.standard_hourly_maximums
    WHERE org_id = p_org_id AND job_type = p_job_type;
  IF p_max_hours IS NULL THEN
    DELETE FROM public.standard_hourly_maximums
      WHERE org_id = p_org_id AND job_type = p_job_type;
  ELSE
    INSERT INTO public.standard_hourly_maximums(org_id, job_type, max_hours, rate_ex, set_by, set_at)
      VALUES (p_org_id, p_job_type, p_max_hours, p_rate_ex, p_actor, v_at)
      ON CONFLICT (org_id, job_type) DO UPDATE
        SET max_hours = EXCLUDED.max_hours, rate_ex = EXCLUDED.rate_ex,
            set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at
      RETURNING * INTO v_after;
  END IF;
  INSERT INTO public.standard_hourly_maximum_changes(
    org_id, job_type, from_hours, to_hours, from_rate_ex, to_rate_ex, changed_by, changed_at
  ) VALUES (
    p_org_id, p_job_type, v_before.max_hours, v_after.max_hours,
    v_before.rate_ex, v_after.rate_ex, p_actor, v_at
  );
  IF p_max_hours IS NULL THEN RETURN jsonb_build_object('cleared', true); END IF;
  RETURN to_jsonb(v_after);
END $fn$;
REVOKE ALL ON FUNCTION public.set_standard_hourly_maximum(uuid, text, numeric, numeric, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_standard_hourly_maximum(uuid, text, numeric, numeric, uuid) TO service_role;

ALTER TABLE public.work_orders ADD COLUMN IF NOT EXISTS standard_max_hours numeric(6,2);
