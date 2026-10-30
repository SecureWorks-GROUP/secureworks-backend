-- Let a crew member approve their own group: the contract must catch it.
CREATE OR REPLACE FUNCTION public.office_approve_group_hours(p_group_id uuid, p_actor_user_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF length(btrim(coalesce(p_reason,''))) < 3 THEN RAISE EXCEPTION 'group_office_approval_reason_required' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.group_work_order_time_entries WHERE group_id = p_group_id) THEN
    RAISE EXCEPTION 'group_office_approval_no_hours' USING ERRCODE = '23514';
  END IF;
  UPDATE public.group_work_orders SET hours_office_approved_at = clock_timestamp(), hours_office_approved_by = p_actor_user_id,
    hours_office_approval_reason = p_reason WHERE id = p_group_id;
  RETURN '{}'::jsonb;
END; $$;
