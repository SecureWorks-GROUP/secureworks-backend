-- An office removal from a group wins over that person's bookings on the job.
--
-- Before: the office could remove someone from a group, and the patio sweep
-- kept them off, but the one crew population (group_work_order_crew, which
-- readiness and the split both read) still required anyone with a live
-- booking. Removal also deletes their hours, so the group could never be
-- made ready or frozen while they stayed booked. Live case: the owner named
-- the crew for a job, and two others with bookings on it held the split.
--
-- Now:
-- 1. Every office removal is recorded in group_work_order_crew_removals with
--    who removed the person and when.
-- 2. While that record stands, the person's bookings on the job do not make
--    them group crew for that group. Being a member again (they join, or the
--    office restores them) always counts.
-- 3. The office can reverse it with restore_group_work_order_participant,
--    which records who restored and when, and puts them back on the group.
-- Both refuse once the split is frozen, like removal. No hours, shares,
-- invoices or bookings are written by this file, and nothing sends. The
-- runner supplies the transaction.

CREATE TABLE IF NOT EXISTS public.group_work_order_crew_removals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.group_work_orders(id) ON DELETE CASCADE,
  job_id uuid NOT NULL,
  user_id uuid NOT NULL,
  removed_by uuid NOT NULL,
  removed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  restored_by uuid,
  restored_at timestamptz,
  CONSTRAINT group_work_order_crew_removals_restore_pair
    CHECK ((restored_by IS NULL) = (restored_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_group_work_order_crew_removals_standing
  ON public.group_work_order_crew_removals(group_id, user_id) WHERE restored_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_group_work_order_crew_removals_job_user
  ON public.group_work_order_crew_removals(job_id, user_id) WHERE restored_at IS NULL;
ALTER TABLE public.group_work_order_crew_removals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.group_work_order_crew_removals FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.group_work_order_crew_removals TO service_role;
COMMENT ON TABLE public.group_work_order_crew_removals IS
  '20261106170000: office removals from a group. While restored_at is null the person''s bookings on the job do not make them crew for that group. Written only by remove_ and restore_group_work_order_participant.';

-- The event log accepts the restore.
DO $$
DECLARE
  v_def text;
  v_expected text := $e$CHECK ((action = ANY (ARRAY['freeze'::text, 'unfreeze'::text, 'revoke_signoff'::text, 'void_group'::text, 'rekey'::text, 'remove_participant'::text, 'approve_budget'::text, 'amend_pay_basis'::text, 'release'::text, 'office_issue_invoices'::text, 'office_approve_hours'::text])))$e$;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def FROM pg_constraint c
  WHERE c.conrelid = 'public.group_work_order_events'::regclass
    AND c.conname = 'group_work_order_events_action_check';
  IF v_def IS NOT NULL AND strpos(v_def, 'restore_participant') > 0 THEN RETURN; END IF;
  IF v_def IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'group_work_order_events_action_check changed; review before applying 20261106170000';
  END IF;
  ALTER TABLE public.group_work_order_events DROP CONSTRAINT group_work_order_events_action_check;
  ALTER TABLE public.group_work_order_events ADD CONSTRAINT group_work_order_events_action_check
    CHECK (action = ANY (ARRAY['freeze', 'unfreeze', 'revoke_signoff', 'void_group', 'rekey',
      'remove_participant', 'approve_budget', 'amend_pay_basis', 'release',
      'office_issue_invoices', 'office_approve_hours', 'restore_participant']));
END $$;

-- 1. A removal records who and when.
DO $$
DECLARE
  body text;
  before_text text := $old$  INSERT INTO public.group_work_order_events (group_id, job_id, action, actor_user_id, detail)
  VALUES (
    p_group_id, v_job, 'remove_participant', p_actor,
    jsonb_build_object('user_id', p_user)
  );$old$;
  after_text text := $new$  INSERT INTO public.group_work_order_events (group_id, job_id, action, actor_user_id, detail)
  VALUES (
    p_group_id, v_job, 'remove_participant', p_actor,
    jsonb_build_object('user_id', p_user)
  );
  -- The office removal wins over their bookings for this group (20261106170000).
  INSERT INTO public.group_work_order_crew_removals (group_id, job_id, user_id, removed_by)
  VALUES (p_group_id, v_job, p_user, p_actor)
  ON CONFLICT (group_id, user_id) WHERE restored_at IS NULL DO NOTHING;$new$;
BEGIN
  body := pg_get_functiondef('public.remove_group_work_order_participant(uuid,uuid,uuid)'::regprocedure);
  IF strpos(body, '(20261106170000)') > 0 THEN RETURN; END IF;
  IF strpos(body, before_text) = 0
     OR length(body) - length(replace(body, before_text, '')) <> length(before_text) THEN
    RAISE EXCEPTION 'remove_group_work_order_participant changed; review before applying 20261106170000';
  END IF;
  EXECUTE replace(body, before_text, after_text);
END $$;

-- 3. The office reverses a removal.
CREATE OR REPLACE FUNCTION public.restore_group_work_order_participant(p_group_id uuid, p_user uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job uuid;
  v_frozen timestamptz;
  v_status text;
  v_removal uuid;
BEGIN
  IF p_actor IS NULL OR p_user IS NULL THEN
    RAISE EXCEPTION 'group_actor_required' USING ERRCODE = '23514';
  END IF;
  SELECT g.job_id INTO v_job FROM public.group_work_orders g WHERE g.id = p_group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'group_work_order_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.group_work_order_lock_job(v_job);
  SELECT g.job_id, g.split_frozen_at, g.status INTO v_job, v_frozen, v_status
  FROM public.group_work_orders g WHERE g.id = p_group_id FOR UPDATE;
  IF v_status = 'void' THEN
    RAISE EXCEPTION 'group_work_order_void' USING ERRCODE = '23514';
  END IF;
  IF v_frozen IS NOT NULL THEN
    RAISE EXCEPTION 'group_split_frozen' USING ERRCODE = '23514';
  END IF;
  UPDATE public.group_work_order_crew_removals r
  SET restored_by = p_actor, restored_at = clock_timestamp()
  WHERE r.group_id = p_group_id AND r.user_id = p_user AND r.restored_at IS NULL
  RETURNING r.id INTO v_removal;
  IF v_removal IS NULL THEN
    RAISE EXCEPTION 'group_removal_not_found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.group_work_order_participants (group_id, user_id)
  VALUES (p_group_id, p_user)
  ON CONFLICT (group_id, user_id) DO NOTHING;
  -- A drawing signed before they were back on the group no longer counts.
  UPDATE public.group_work_orders SET hours_changed_at = clock_timestamp() WHERE id = p_group_id;
  INSERT INTO public.group_work_order_events (group_id, job_id, action, actor_user_id, detail)
  VALUES (p_group_id, v_job, 'restore_participant', p_actor, jsonb_build_object('user_id', p_user));
  RETURN jsonb_build_object('restored', true, 'user_id', p_user);
END;
$$;
REVOKE ALL ON FUNCTION public.restore_group_work_order_participant(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_group_work_order_participant(uuid, uuid, uuid) TO service_role;

-- 2. The one crew population leaves out a booking the office removal beat.
DO $$
DECLARE
  body text := pg_get_functiondef('public.group_work_order_crew(uuid[])'::regprocedure);
  before_text text := $old$    -- Paid by the hour on this job: not group crew (20261106160000).
    AND NOT public.group_work_order_paid_by_hours(j.id, a.user_id)
  UNION$old$;
  after_text text := $new$    -- Paid by the hour on this job: not group crew (20261106160000).
    AND NOT public.group_work_order_paid_by_hours(j.id, a.user_id)
    -- The office removed them from the job's live group (20261106170000).
    AND NOT EXISTS (
      SELECT 1
      FROM public.group_work_order_crew_removals r
      JOIN public.group_work_orders rg ON rg.id = r.group_id
      WHERE r.job_id = j.id
        AND r.user_id = a.user_id
        AND r.restored_at IS NULL
        AND rg.status IS DISTINCT FROM 'void'
    )
  UNION$new$;
BEGIN
  IF strpos(body, '(20261106170000)') > 0 THEN RETURN; END IF;
  IF strpos(body, before_text) = 0
     OR length(body) - length(replace(body, before_text, '')) <> length(before_text) THEN
    RAISE EXCEPTION 'group_work_order_crew changed; review before applying 20261106170000';
  END IF;
  EXECUTE replace(body, before_text, after_text);
END $$;
