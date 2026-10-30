-- Group work orders: the office can approve the crew's hours on their behalf.
--
-- Owner, 30 Oct 2026: a group goes through when the client signs off and the
-- crew approve each other's hours, "or me or Sean or anyone in the office can
-- approve it acting on behalf of the office". Until now only each crew member
-- could approve hours, so a full employer-super group stalled when one of them
-- never tapped approve.
--
-- The office approval is recorded on the group, never as a crew signature.
-- Like a crew approval it counts only while it is newer than every hours
-- change. Someone on the crew cannot give it for their own group.

ALTER TABLE public.group_work_orders
  ADD COLUMN IF NOT EXISTS hours_office_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS hours_office_approved_by uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS hours_office_approval_reason text;

ALTER TABLE public.group_work_order_events DROP CONSTRAINT group_work_order_events_action_check;
ALTER TABLE public.group_work_order_events ADD CONSTRAINT group_work_order_events_action_check
  CHECK (action IN ('freeze', 'unfreeze', 'revoke_signoff', 'void_group', 'rekey', 'remove_participant',
    'approve_budget', 'amend_pay_basis', 'release', 'office_issue_invoices', 'office_approve_hours'));

CREATE OR REPLACE FUNCTION public.office_approve_group_hours(
  p_group_id uuid, p_actor_user_id uuid, p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  g record;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_at timestamptz := clock_timestamp();
  v_hours jsonb;
BEGIN
  IF p_actor_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_actor_user_id) THEN
    RAISE EXCEPTION 'group_office_approver_required' USING ERRCODE = '22023';
  END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'group_office_approval_reason_required' USING ERRCODE = '22023'; END IF;
  SELECT * INTO g FROM public.group_work_orders WHERE id = p_group_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'group_work_order_not_found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.group_work_order_lock_job(g.job_id);
  SELECT * INTO g FROM public.group_work_orders WHERE id = p_group_id FOR UPDATE;
  IF g.status = 'void' THEN RAISE EXCEPTION 'group_work_order_void' USING ERRCODE = '23514'; END IF;
  IF g.split_frozen_at IS NOT NULL THEN RAISE EXCEPTION 'group_split_frozen' USING ERRCODE = '23514'; END IF;
  IF EXISTS (SELECT 1 FROM public.group_work_order_participants p WHERE p.group_id = g.id AND p.user_id = p_actor_user_id) THEN
    RAISE EXCEPTION 'group_office_approver_on_crew' USING ERRCODE = '42501';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('user_id', t.user_id, 'hours', t.hours) ORDER BY t.user_id), '[]'::jsonb)
    INTO v_hours
  FROM (SELECT user_id, sum(hours) AS hours FROM public.group_work_order_time_entries WHERE group_id = g.id GROUP BY user_id) t;
  IF v_hours = '[]'::jsonb THEN RAISE EXCEPTION 'group_office_approval_no_hours' USING ERRCODE = '23514'; END IF;

  UPDATE public.group_work_orders
     SET hours_office_approved_at = v_at, hours_office_approved_by = p_actor_user_id,
         hours_office_approval_reason = v_reason
   WHERE id = g.id;
  INSERT INTO public.group_work_order_events (group_id, job_id, action, actor_user_id, detail)
  VALUES (g.id, g.job_id, 'office_approve_hours', p_actor_user_id,
          jsonb_build_object('reason', v_reason, 'hours', v_hours, 'approved_at', v_at));
  RETURN jsonb_build_object('group_id', g.id, 'approved_at', v_at, 'approved_by', p_actor_user_id, 'hours', v_hours);
END; $$;
REVOKE ALL ON FUNCTION public.office_approve_group_hours(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.office_approve_group_hours(uuid, uuid, text) TO service_role;

COMMENT ON FUNCTION public.office_approve_group_hours(uuid, uuid, text) IS
  'Owner 30 Oct 2026: the office approves a group''s hours on the crew''s behalf, with a reason. Counts only while newer than every hours change. Refused for someone on the crew, a frozen split or a void group.';
