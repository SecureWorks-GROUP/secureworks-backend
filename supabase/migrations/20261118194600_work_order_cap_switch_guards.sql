-- Follow-up 49 item 9(b), before the switch, after 20261118194400: two guards on the cap's
-- start date for when trade_line_hold_v1 goes on.
-- Placeholder version: the keeper stamps the real one.
--
-- * set_work_order_cap_start (replaced, built from 20261118194100's body, md5-guarded):
--   refuses to clear the start date while trade_line_hold_v1 is on (55000
--   work_order_cap_start_clear_while_on), because no start date then caps no job at all.
--   Its answer also names the switch state, so the screen's words are true for it.
-- * work_order_cap_start_preview(actor): checks owner_approval_authority BEFORE it reads
--   the settings, then answers the saved date and the switch state, for the screen to word
--   a change before the approver confirms. Writes nothing. Service role only.
-- Definitions only: no table, trigger, timer, schedule or switch; no existing table is
-- altered or locked.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $pre$ BEGIN
  IF to_regclass('public.work_order_cap_settings') IS NULL
     OR to_regprocedure('public.owner_approval_authority(uuid)') IS NULL THEN
    RAISE EXCEPTION 'work_order_cap_switch_guards_pre_image' USING DETAIL = 'settings or authority';
  END IF;
  -- The door as 20261118194100 left it, or as this migration leaves it (a re-apply).
  IF (SELECT md5(prosrc) FROM pg_proc
       WHERE oid = to_regprocedure('public.set_work_order_cap_start(uuid,text,date,date,text)'))
     IS DISTINCT FROM 'a0eb696a643be747aaa51a404a861b82'
     AND (SELECT md5(prosrc) FROM pg_proc
       WHERE oid = to_regprocedure('public.set_work_order_cap_start(uuid,text,date,date,text)'))
     IS DISTINCT FROM 'a533db4bea9a4ccfcbeb964420131d9e' THEN
    RAISE EXCEPTION 'work_order_cap_switch_guards_pre_image' USING DETAIL = 'set_work_order_cap_start';
  END IF;
END $pre$;

-- The approver's door. Who may set it is checked before anything is read.
CREATE OR REPLACE FUNCTION public.set_work_order_cap_start(
  p_actor uuid,
  p_actor_email text,
  p_shown_start date,
  p_start date,
  p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_authority text; v_current date; v_change bigint; v_hold_on boolean;
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
    RETURN jsonb_build_object('changed', false, 'cap_start_on', v_current, 'authority', v_authority,
      'hold_switch_on', COALESCE((SELECT f.enabled FROM public.feature_flags f
                                  WHERE f.flag_name = 'trade_line_hold_v1' LIMIT 1), false));
  END IF;
  IF v_current IS DISTINCT FROM p_shown_start THEN
    RAISE EXCEPTION 'work_order_cap_start_changed' USING ERRCODE = '40001';
  END IF;
  -- With held lines on, no start date would cap no job at all: refused. Clear it only with
  -- the switch off. A missing switch row reads as off, as every reader of the switch does.
  v_hold_on := COALESCE((SELECT f.enabled FROM public.feature_flags f
                         WHERE f.flag_name = 'trade_line_hold_v1' LIMIT 1), false);
  IF p_start IS NULL AND v_hold_on THEN
    RAISE EXCEPTION 'work_order_cap_start_clear_while_on' USING ERRCODE = '55000';
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
                            'previous_start', v_current, 'authority', v_authority, 'change_id', v_change,
                            'hold_switch_on', v_hold_on);
END $fn$;
REVOKE ALL ON FUNCTION public.set_work_order_cap_start(uuid, text, date, date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_work_order_cap_start(uuid, text, date, date, text) TO service_role;

-- What the screen shows before a change: for an approver only, checked first.
CREATE OR REPLACE FUNCTION public.work_order_cap_start_preview(p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_authority text; v_row public.work_order_cap_settings%ROWTYPE; v_found boolean;
BEGIN
  v_authority := public.owner_approval_authority(p_actor);
  IF v_authority IS NULL THEN
    RAISE EXCEPTION 'work_order_cap_start_not_approver' USING ERRCODE = '42501';
  END IF;
  -- work_order_cap_settings_pkey.
  SELECT * INTO v_row FROM public.work_order_cap_settings s WHERE s.id = 1;
  v_found := FOUND;
  RETURN jsonb_build_object(
    'authority', v_authority,
    'settings_row', v_found,
    'cap_start_on', CASE WHEN v_found THEN v_row.cap_start_on END,
    'hold_switch_on', COALESCE((SELECT f.enabled FROM public.feature_flags f
                                WHERE f.flag_name = 'trade_line_hold_v1' LIMIT 1), false));
END $fn$;
REVOKE ALL ON FUNCTION public.work_order_cap_start_preview(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.work_order_cap_start_preview(uuid) TO service_role;
