-- Undo 20261118999910 (placeholder version): drop the preview and put the door back as
-- 20261118194100 left it (clearing allowed whatever the switch).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DROP FUNCTION IF EXISTS public.work_order_cap_start_preview(uuid);
CREATE OR REPLACE FUNCTION public.set_work_order_cap_start(
  p_actor uuid,
  p_actor_email text,
  p_shown_start date,
  p_start date,
  p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_authority text; v_current date; v_change bigint;
BEGIN
  v_authority := public.owner_approval_authority(p_actor);
  IF v_authority IS NULL THEN
    RAISE EXCEPTION 'work_order_cap_start_not_approver' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'work_order_cap_start_reason_invalid' USING ERRCODE = '22023';
  END IF;
  -- work_order_cap_settings_pkey, locked so two approvers queue.
  SELECT s.cap_start_on INTO v_current FROM public.work_order_cap_settings s WHERE s.id = 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work_order_cap_settings_missing' USING ERRCODE = 'P0002';
  END IF;
  IF v_current IS NOT DISTINCT FROM p_start THEN
    RETURN jsonb_build_object('changed', false, 'cap_start_on', v_current, 'authority', v_authority);
  END IF;
  IF v_current IS DISTINCT FROM p_shown_start THEN
    RAISE EXCEPTION 'work_order_cap_start_changed' USING ERRCODE = '40001';
  END IF;
  INSERT INTO public.work_order_cap_start_changes
    (previous_start, new_start, via, set_by, set_by_email, authority, reason, db_role)
  VALUES (v_current, p_start, 'approver', p_actor, nullif(btrim(p_actor_email), ''), v_authority,
          btrim(p_reason), coalesce(nullif(current_setting('role', true), 'none'), session_user::text))
  RETURNING id INTO v_change;
  -- No record, no change (a missing record row is never a silent success).
  IF v_change IS NULL THEN
    RAISE EXCEPTION 'work_order_cap_start_not_recorded' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('sw.work_order_cap_start_change', v_change::text, true);
  UPDATE public.work_order_cap_settings SET cap_start_on = p_start, updated_at = now() WHERE id = 1;
  PERFORM set_config('sw.work_order_cap_start_change', '', true);
  RETURN jsonb_build_object('changed', true, 'cap_start_on', p_start,
                            'previous_start', v_current, 'authority', v_authority, 'change_id', v_change);
END $fn$;
REVOKE ALL ON FUNCTION public.set_work_order_cap_start(uuid, text, date, date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_work_order_cap_start(uuid, text, date, date, text) TO service_role;
