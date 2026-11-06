BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.job_client_signoffs WHERE method='office_on_behalf')
    OR EXISTS(SELECT 1 FROM public.group_work_orders WHERE signoff_required_after IS NOT NULL)
    OR EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='client-signoff-copies') THEN
   RAISE EXCEPTION 'client confirmation evidence exists; preserve it and review rollback';
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.group_client_signoff_counts(p_job uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_method text;
  v_reason text;
  v_actor text;
  v_happy boolean;
  v_rating smallint;
  v_min smallint;
  v_media uuid;
  v_signed_at timestamptz;
  v_latest_hours timestamptz;
BEGIN
  -- Owner approved office overrides on 27 October 2026. Keep the real
  -- method, reason and actor; never manufacture a client drawing. Both
  -- drawn and office sign-offs must be newer than the latest hours change.
  SELECT s.method, s.happy, s.satisfaction_rating, s.signature_media_id, s.created_at, s.waiver_reason, s.captured_by_actor
    INTO v_method, v_happy, v_rating, v_media, v_signed_at, v_reason, v_actor
  FROM public.job_client_signoffs s
  WHERE s.job_id = p_job
  ORDER BY s.created_at DESC, s.id::text COLLATE "C" DESC
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_method = 'revoked' THEN RETURN false; END IF;
  IF v_method = 'office_waiver' THEN
    IF length(btrim(coalesce(v_reason, ''))) < 3 OR btrim(coalesce(v_actor, '')) = '' THEN
      RETURN false;
    END IF;
  ELSE
    IF v_method NOT IN ('on_site', 'share_link') OR v_media IS NULL THEN RETURN false; END IF;
    SELECT c.min_happy_rating INTO v_min FROM public.client_signoff_settings c WHERE c.id = 1;
    IF v_min IS NULL THEN v_min := 4; END IF;
    IF v_happy IS FALSE THEN RETURN false; END IF;
    IF v_rating IS NOT NULL AND v_rating < v_min THEN RETURN false; END IF;
  END IF;
  SELECT max(stamp) INTO v_latest_hours
  FROM (
    SELECT max(GREATEST(e.created_at, COALESCE(e.updated_at, e.created_at))) AS stamp
    FROM public.group_work_order_time_entries e
    JOIN public.group_work_orders g ON g.id = e.group_id
    WHERE g.job_id = p_job
      AND g.status <> 'void'
    UNION ALL
    SELECT max(g.hours_changed_at)
    FROM public.group_work_orders g
    WHERE g.job_id = p_job
      AND g.status <> 'void'
  ) stamps;
  IF v_latest_hours IS NOT NULL AND NOT (v_signed_at > v_latest_hours) THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$function$;

DO $$ DECLARE body text; BEGIN
 body:=pg_get_functiondef('public.group_work_order_release_state(uuid)'::regprocedure);
 EXECUTE replace(body,$new$WHEN s2.method IN ('on_site', 'share_link', 'office_on_behalf') THEN 'client'$new$,
  $old$WHEN s2.method IN ('on_site', 'share_link') THEN 'client'$old$);
END $$;
DROP TRIGGER IF EXISTS trg_office_client_confirmation_group_guard ON public.job_client_signoffs;
DROP FUNCTION IF EXISTS public.office_client_confirmation_group_guard();
DROP TRIGGER IF EXISTS trg_group_reopen_client_confirmation ON public.group_work_orders;
DROP FUNCTION IF EXISTS public.group_reopen_requires_client_confirmation();
ALTER TABLE public.group_work_orders DROP COLUMN IF EXISTS signoff_required_after;
ALTER TABLE public.job_client_signoffs DROP CONSTRAINT IF EXISTS job_client_signoffs_office_confirmation_check;
ALTER TABLE public.job_client_signoffs DROP CONSTRAINT IF EXISTS job_client_signoffs_method_check;
ALTER TABLE public.job_client_signoffs ADD CONSTRAINT job_client_signoffs_method_check
 CHECK(method IN ('on_site','share_link','office_waiver','revoked'));
DROP INDEX IF EXISTS public.job_client_signoffs_capture_request_key;
ALTER TABLE public.job_client_signoffs
 DROP COLUMN IF EXISTS capture_auth_source,DROP COLUMN IF EXISTS capture_request_id,
 DROP COLUMN IF EXISTS capture_payload_hash,DROP COLUMN IF EXISTS confirmation_kind,
 DROP COLUMN IF EXISTS confirmation_reference,DROP COLUMN IF EXISTS signed_copy_path,
 DROP COLUMN IF EXISTS signed_copy_sha256,DROP COLUMN IF EXISTS signed_copy_type,
 DROP COLUMN IF EXISTS signed_copy_name,DROP COLUMN IF EXISTS client_confirmed_on,
 DROP COLUMN IF EXISTS work_done,DROP COLUMN IF EXISTS outstanding_items;
DROP TABLE IF EXISTS public.group_client_signoff_policy;
-- The empty private bucket is harmless and is retained, never made public.
COMMIT;
