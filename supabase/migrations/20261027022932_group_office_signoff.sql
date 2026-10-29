-- Office sign-off is an audited alternative to a client drawing. No data backfill.
CREATE OR REPLACE FUNCTION public.group_client_signoff_counts(p_job uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
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
$$;

