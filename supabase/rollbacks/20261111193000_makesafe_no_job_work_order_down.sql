-- Undo 20261111193000: a make-safe job is again treated like every other
-- job type, so while job_work_order_all_types_v1 is on it gets a blank job
-- work order on its next open status change, from the office, or from the
-- 30-day backfill. The four functions go back to their 20261021143000
-- bodies.
--
-- Does not put back the blank drafts the migration removed, and keeps
-- job_work_order_retired_drafts and every row in it: each holds the whole
-- work order as it stood. A removed draft was blank, so the doors above
-- reopen an equal one. Writes no work order and no job. No flag changes
-- state; job_work_order_all_types_v1 gets its earlier description back.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ensure_job_work_order_draft(p_job_id uuid, p_origin text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job record;
  v_id uuid;
BEGIN
  SELECT j.id, j.org_id, j.type, j.job_number, j.site_address, j.site_suburb, j.work_order_id
    INTO v_job FROM public.jobs j WHERE j.id = p_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job % not found', p_job_id USING ERRCODE = 'P0002';
  END IF;
  IF COALESCE(v_job.type, '') NOT IN ('fencing', 'patio') THEN
    IF NOT (
      COALESCE((SELECT enabled FROM public.feature_flags
                WHERE flag_name = 'job_work_order_all_types_v1'), false)
      AND COALESCE(btrim(v_job.type), '') <> ''
    ) THEN
      RAISE EXCEPTION 'job work orders are for fencing and patio jobs' USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT wo.id INTO v_id FROM public.work_orders wo
  WHERE wo.job_id = p_job_id AND wo.kind = 'job' AND wo.status IN ('draft', 'approved') LIMIT 1;

  IF v_id IS NULL THEN
    BEGIN
      INSERT INTO public.work_orders (
        org_id, job_id, wo_number, kind, status, scope_items, site_address, origin
      ) VALUES (
        v_job.org_id, p_job_id,
        'WO-' || COALESCE(NULLIF(v_job.job_number, ''), left(p_job_id::text, 8)),
        'job', 'draft', '[]'::jsonb,
        NULLIF(concat_ws(', ', NULLIF(v_job.site_address, ''), NULLIF(v_job.site_suburb, '')), ''),
        p_origin
      ) RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
      SELECT wo.id INTO v_id FROM public.work_orders wo
      WHERE wo.job_id = p_job_id AND wo.kind = 'job' AND wo.status IN ('draft', 'approved') LIMIT 1;
    END;
  END IF;

  IF v_id IS NOT NULL AND v_job.work_order_id IS DISTINCT FROM v_id THEN
    UPDATE public.jobs SET work_order_id = v_id WHERE id = p_job_id;
  END IF;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.jobs_open_job_work_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = ANY (public.job_work_order_open_statuses())
     AND (TG_OP = 'INSERT'
          OR OLD.status IS DISTINCT FROM NEW.status
          OR OLD.type IS DISTINCT FROM NEW.type)
     AND NOT EXISTS (
       SELECT 1 FROM public.work_orders wo
       WHERE wo.job_id = NEW.id AND wo.kind = 'job' AND wo.status IN ('draft', 'approved')
     ) THEN
    BEGIN
      IF NEW.type IN ('fencing', 'patio')
         OR (
           COALESCE((SELECT enabled FROM public.feature_flags
                     WHERE flag_name = 'job_work_order_all_types_v1'), false)
           AND COALESCE(btrim(NEW.type), '') <> ''
         ) THEN
        PERFORM public.ensure_job_work_order_draft(NEW.id, 'job_approved');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'job work order draft not opened for job %: SQLSTATE %', NEW.id, SQLSTATE;
    END;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.preview_active_job_work_orders()
RETURNS TABLE (
  job_id uuid,
  job_number text,
  job_type text,
  status text,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT j.id, j.job_number, j.type, j.status, j.updated_at
  FROM public.jobs j
  WHERE j.status = ANY (public.job_work_order_open_statuses())
    AND NOT EXISTS (
      SELECT 1 FROM public.work_orders wo
      WHERE wo.job_id = j.id AND wo.kind = 'job' AND wo.status IN ('draft', 'approved')
    )
    AND public.job_work_order_recent_activity(j.id)
  ORDER BY j.type, j.job_number;
$$;
REVOKE ALL ON FUNCTION public.preview_active_job_work_orders() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.preview_active_job_work_orders() TO service_role;

CREATE OR REPLACE FUNCTION public.apply_active_job_work_orders(p_job_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_job record;
  v_reason text;
  v_opened int := 0;
  v_skipped int := 0;
  v_opened_ids uuid[] := ARRAY[]::uuid[];
  v_skipped_jobs jsonb := '[]'::jsonb;
BEGIN
  IF NOT COALESCE((SELECT f.enabled FROM public.feature_flags f
                   WHERE f.flag_name = 'job_work_order_all_types_v1' LIMIT 1), false)
     OR NOT COALESCE((SELECT f.enabled FROM public.feature_flags f
                      WHERE f.flag_name = 'job_work_order_active_backfill_v1' LIMIT 1), false) THEN
    RAISE EXCEPTION 'active job work order backfill needs job_work_order_all_types_v1 and job_work_order_active_backfill_v1 on'
      USING ERRCODE = '42501';
  END IF;
  IF p_job_ids IS NULL THEN
    RETURN jsonb_build_object(
      'opened', 0, 'opened_ids', '[]'::jsonb, 'skipped', 0,
      'skipped_jobs', '[]'::jsonb, 'as_of', now()
    );
  END IF;
  -- Re-check every reviewed id. A job that lost its 30-day activity, closed,
  -- or has a blank type is skipped and named. It does not open a blank draft.
  FOREACH v_id IN ARRAY p_job_ids LOOP
    SELECT j.id, j.status, j.type INTO v_job FROM public.jobs j WHERE j.id = v_id;
    IF NOT FOUND THEN
      v_reason := 'not_found';
    ELSIF COALESCE(btrim(v_job.type), '') = '' THEN
      v_reason := 'blank_type';
    ELSIF NOT (v_job.status = ANY (public.job_work_order_open_statuses())) THEN
      v_reason := 'not_open';
    ELSIF EXISTS (
      SELECT 1 FROM public.work_orders wo
      WHERE wo.job_id = v_id AND wo.kind = 'job' AND wo.status IN ('draft', 'approved')
    ) THEN
      v_reason := 'already_has_work_order';
    ELSIF NOT public.job_work_order_recent_activity(v_id) THEN
      v_reason := 'no_recent_activity';
    ELSE
      v_reason := NULL;
    END IF;
    IF v_reason IS NULL THEN
      PERFORM public.ensure_job_work_order_draft(v_id, 'backfill');
      v_opened := v_opened + 1;
      v_opened_ids := v_opened_ids || v_id;
    ELSE
      v_skipped := v_skipped + 1;
      v_skipped_jobs := v_skipped_jobs || jsonb_build_array(
        jsonb_build_object('job_id', v_id, 'reason', v_reason)
      );
    END IF;
  END LOOP;
  RETURN jsonb_build_object(
    'opened', v_opened,
    'opened_ids', to_jsonb(v_opened_ids),
    'skipped', v_skipped,
    'skipped_jobs', v_skipped_jobs,
    'as_of', now()
  );
END;
$$;
REVOKE ALL ON FUNCTION public.apply_active_job_work_orders(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_active_job_work_orders(uuid[]) TO service_role;

DROP FUNCTION IF EXISTS public.retire_blank_makesafe_job_work_orders();
DROP FUNCTION IF EXISTS public.job_type_never_gets_job_work_order(text);

UPDATE public.feature_flags
SET description = 'Open a blank job work order for every job type when the job enters an open status. Fencing and patio are unchanged either way. Off: other types still raise.'
WHERE flag_name = 'job_work_order_all_types_v1';
