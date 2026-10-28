-- Job bookings (Ops Dash calendar, owner's go 28 Oct 2026): move or stretch
-- every booking of one job in one step.
--
-- A job on the calendar is a set of job_assignments rows, often one per crew
-- member per day. ops-api reschedule_job_bookings plans a whole-job move or
-- stretch (job_bookings.ts) and hands every write to this one function, so
-- every row changes or none does: no job is ever left half moved.
--
-- The caller passes the plan as three lists and this function re-checks it
-- under a lock before writing anything:
--   p_deletes  [{id, expected_user_id, expected_scheduled_date, expected_scheduled_end}]
--   p_updates  [{id, expected_user_id, expected_scheduled_date, expected_scheduled_end,
--                scheduled_date, scheduled_end, duration_days,
--                attendance_cycle_id?, cycle_attribution?}]   (in write order)
--   p_creates  [{user_id, scheduled_date, scheduled_end, duration_days, start_time,
--                end_time, role, assignment_type, crew_name, confirmation_status,
--                visible_to_trades?, attendance_cycle_id?, cycle_attribution?}]
-- Every named row must still belong to the job, be a live crew booking (not a
-- ghost, not cancelled or completed) and sit on the user and dates the plan
-- was made from; otherwise nothing is written (JB409 booking_changed). A row
-- held by a live trade invoice is never deleted (JB409 booking_invoiced), as
-- delete_assignment refuses it. A watcher's own ghost on a key a real row of
-- theirs is written onto is removed first, as
-- releaseGhostObserverMirrorForRealAssignee does; any other holder of
-- job_assignments_job_user_date_key refuses the whole write (JB409
-- booking_date_taken). Writes go deletes, then updates in the order given
-- (the caller orders them so no write lands on a key a later one frees), then
-- creates, each with the job_events row create_assignment / delete_assignment
-- write. Refusals carry SQLSTATE JB409 (or JB404 for an unknown job), the
-- reason code as DETAIL and a JSON object as HINT.
--
-- Nothing here sends a message. What cannot run in the transaction (GHL push,
-- ghost watcher sync, make-safe report binding, business_events) runs once in
-- ops-api after this commits.

CREATE OR REPLACE FUNCTION public.reschedule_job_assignments_refuse(
  p_reason text,
  p_message text,
  p_context jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '%', p_message
    USING ERRCODE = CASE WHEN p_reason = 'job_not_found' THEN 'JB404' ELSE 'JB409' END,
          DETAIL = p_reason,
          HINT = coalesce(p_context, '{}'::jsonb)::text;
END;
$$;

CREATE OR REPLACE FUNCTION public.reschedule_job_assignments_v1(
  p_job_id uuid,
  p_updates jsonb,
  p_deletes jsonb,
  p_creates jsonb,
  p_release_ghost_user_ids uuid[],
  p_released_invoice_statuses text[],
  p_operator text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updates jsonb := coalesce(p_updates, '[]'::jsonb);
  v_deletes jsonb := coalesce(p_deletes, '[]'::jsonb);
  v_creates jsonb := coalesce(p_creates, '[]'::jsonb);
  v_release uuid[] := coalesce(p_release_ghost_user_ids, ARRAY[]::uuid[]);
  v_released text[] := coalesce(p_released_invoice_statuses, ARRAY[]::text[]);
  v_ids uuid[];
  v_item jsonb;
  v_row public.job_assignments%ROWTYPE;
  v_want public.job_assignments%ROWTYPE;
  v_new public.job_assignments%ROWTYPE;
  v_invoice record;
  v_constraint text;
  v_updated jsonb := '[]'::jsonb;
  v_created jsonb := '[]'::jsonb;
  v_deleted jsonb := '[]'::jsonb;
BEGIN
  IF jsonb_typeof(v_updates) <> 'array' OR jsonb_typeof(v_deletes) <> 'array'
     OR jsonb_typeof(v_creates) <> 'array' THEN
    RAISE EXCEPTION 'p_updates, p_deletes and p_creates must be JSON arrays'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.jobs WHERE id = p_job_id;
  IF NOT FOUND THEN
    PERFORM public.reschedule_job_assignments_refuse(
      'job_not_found', 'Job not found', jsonb_build_object('job_id', p_job_id));
  END IF;

  -- One reschedule of a job at a time, then every named row locked.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('reschedule_job_assignments:' || p_job_id::text, 0));
  v_ids := ARRAY(
    SELECT (e->>'id')::uuid
    FROM jsonb_array_elements(v_updates || v_deletes) AS e
  );
  IF cardinality(v_ids) <> (SELECT count(DISTINCT x) FROM unnest(v_ids) AS x) THEN
    RAISE EXCEPTION 'a booking is named more than once in the plan' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.job_assignments WHERE id = ANY (v_ids) ORDER BY id FOR UPDATE;

  -- Every named row is checked before anything is written.
  FOR v_item IN SELECT e FROM jsonb_array_elements(v_updates || v_deletes) AS e LOOP
    SELECT * INTO v_row FROM public.job_assignments WHERE id = (v_item->>'id')::uuid;
    IF NOT FOUND THEN
      PERFORM public.reschedule_job_assignments_refuse(
        'booking_changed', 'Not changed: a booking on this job was removed since it was read',
        jsonb_build_object('assignment_id', v_item->>'id'));
    END IF;
    IF v_row.job_id IS DISTINCT FROM p_job_id
       OR v_row.is_ghost IS TRUE
       OR lower(coalesce(v_row.status, '')) IN ('cancelled', 'complete', 'completed')
       OR v_row.user_id IS DISTINCT FROM (v_item->>'expected_user_id')::uuid
       OR v_row.scheduled_date IS DISTINCT FROM (v_item->>'expected_scheduled_date')::date
       OR v_row.scheduled_end IS DISTINCT FROM (v_item->>'expected_scheduled_end')::date THEN
      PERFORM public.reschedule_job_assignments_refuse(
        'booking_changed', 'Not changed: a booking on this job changed since it was read',
        jsonb_build_object('assignment_id', v_row.id));
    END IF;
  END LOOP;

  FOR v_item IN SELECT e FROM jsonb_array_elements(v_deletes) AS e LOOP
    SELECT * INTO v_row FROM public.job_assignments WHERE id = (v_item->>'id')::uuid;
    IF v_row.invoiced_in IS NOT NULL THEN
      SELECT id, status, invoice_number INTO v_invoice
      FROM public.trade_invoices WHERE id = v_row.invoiced_in;
      IF FOUND THEN
        IF NOT (coalesce(v_invoice.status, '') = ANY (v_released)) THEN
          PERFORM public.reschedule_job_assignments_refuse(
            'booking_invoiced',
            'This crew member has already invoiced this job'
              || coalesce(' (' || v_invoice.invoice_number || ')', '')
              || '. The office must adjust the invoice before the allocation can be removed.',
            jsonb_build_object('assignment_id', v_row.id, 'trade_invoice_id', v_invoice.id));
        END IF;
      END IF;
    END IF;
    DELETE FROM public.job_assignments WHERE id = v_row.id;
    INSERT INTO public.job_events (job_id, event_type, detail_json)
    VALUES (p_job_id, 'assignment_deleted', jsonb_build_object(
      'user_id', v_row.user_id, 'date', v_row.scheduled_date,
      'operator', p_operator, 'via', 'reschedule_job_bookings'));
    v_deleted := v_deleted || jsonb_build_array(to_jsonb(v_row));
  END LOOP;

  FOR v_item IN
    SELECT e FROM jsonb_array_elements(v_updates) WITH ORDINALITY AS t(e, n) ORDER BY n
  LOOP
    SELECT * INTO v_row FROM public.job_assignments WHERE id = (v_item->>'id')::uuid;
    v_want := jsonb_populate_record(v_row, v_item
      - 'id' - 'expected_user_id' - 'expected_scheduled_date' - 'expected_scheduled_end');
    IF v_row.user_id IS NOT NULL AND v_row.user_id = ANY (v_release) THEN
      DELETE FROM public.job_assignments
      WHERE job_id = p_job_id AND user_id = v_row.user_id
        AND scheduled_date = v_want.scheduled_date
        AND is_ghost IS TRUE AND id <> v_row.id;
    END IF;
    BEGIN
      UPDATE public.job_assignments
         SET scheduled_date = v_want.scheduled_date,
             scheduled_end = v_want.scheduled_end,
             duration_days = v_want.duration_days,
             attendance_cycle_id = v_want.attendance_cycle_id,
             cycle_attribution = v_want.cycle_attribution
       WHERE id = v_row.id
      RETURNING * INTO v_new;
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint IS DISTINCT FROM 'job_assignments_job_user_date_key' THEN RAISE; END IF;
      PERFORM public.reschedule_job_assignments_refuse(
        'booking_date_taken',
        'Not changed: that crew member already has a booking on this job on '
          || v_want.scheduled_date::text,
        jsonb_build_object('assignment_id', v_row.id, 'user_id', v_row.user_id,
          'scheduled_date', v_want.scheduled_date,
          'constraint', 'job_assignments_job_user_date_key'));
    END;
    v_updated := v_updated || jsonb_build_array(to_jsonb(v_new));
  END LOOP;

  FOR v_item IN
    SELECT e FROM jsonb_array_elements(v_creates) WITH ORDINALITY AS t(e, n) ORDER BY n
  LOOP
    v_want := jsonb_populate_record(NULL::public.job_assignments, v_item);
    IF v_want.user_id IS NULL OR v_want.scheduled_date IS NULL THEN
      RAISE EXCEPTION 'a new booking needs user_id and scheduled_date' USING ERRCODE = '22023';
    END IF;
    IF v_want.user_id = ANY (v_release) THEN
      DELETE FROM public.job_assignments
      WHERE job_id = p_job_id AND user_id = v_want.user_id
        AND scheduled_date = v_want.scheduled_date AND is_ghost IS TRUE;
    END IF;
    BEGIN
      IF v_want.visible_to_trades IS TRUE THEN
        INSERT INTO public.job_assignments (
          job_id, user_id, scheduled_date, scheduled_end, duration_days, start_time, end_time,
          role, assignment_type, crew_name, status, confirmation_status,
          attendance_cycle_id, cycle_attribution, visible_to_trades)
        VALUES (
          p_job_id, v_want.user_id, v_want.scheduled_date, v_want.scheduled_end,
          coalesce(v_want.duration_days, 1), v_want.start_time, v_want.end_time,
          coalesce(v_want.role, 'lead_installer'), coalesce(v_want.assignment_type, 'install'),
          v_want.crew_name, 'scheduled', coalesce(v_want.confirmation_status, 'tentative'),
          v_want.attendance_cycle_id, v_want.cycle_attribution, true)
        RETURNING * INTO v_new;
      ELSE
        INSERT INTO public.job_assignments (
          job_id, user_id, scheduled_date, scheduled_end, duration_days, start_time, end_time,
          role, assignment_type, crew_name, status, confirmation_status,
          attendance_cycle_id, cycle_attribution)
        VALUES (
          p_job_id, v_want.user_id, v_want.scheduled_date, v_want.scheduled_end,
          coalesce(v_want.duration_days, 1), v_want.start_time, v_want.end_time,
          coalesce(v_want.role, 'lead_installer'), coalesce(v_want.assignment_type, 'install'),
          v_want.crew_name, 'scheduled', coalesce(v_want.confirmation_status, 'tentative'),
          v_want.attendance_cycle_id, v_want.cycle_attribution)
        RETURNING * INTO v_new;
      END IF;
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint IS DISTINCT FROM 'job_assignments_job_user_date_key' THEN RAISE; END IF;
      PERFORM public.reschedule_job_assignments_refuse(
        'booking_date_taken',
        'Not changed: that crew member already has a booking on this job on '
          || v_want.scheduled_date::text,
        jsonb_build_object('user_id', v_want.user_id,
          'scheduled_date', v_want.scheduled_date,
          'constraint', 'job_assignments_job_user_date_key'));
    END;
    INSERT INTO public.job_events (job_id, event_type, detail_json)
    VALUES (p_job_id, 'assignment_created', jsonb_build_object(
      'assignment_id', v_new.id, 'date', v_new.scheduled_date,
      'operator', p_operator, 'via', 'reschedule_job_bookings'));
    v_created := v_created || jsonb_build_array(to_jsonb(v_new));
  END LOOP;

  RETURN jsonb_build_object(
    'updated', v_updated,
    'created', v_created,
    'deleted', v_deleted,
    'bookings', coalesce((
      SELECT jsonb_agg(to_jsonb(a) ORDER BY a.scheduled_date, a.id)
      FROM public.job_assignments a
      WHERE a.job_id = p_job_id AND a.status IS DISTINCT FROM 'cancelled'
    ), '[]'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION public.reschedule_job_assignments_refuse(text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reschedule_job_assignments_v1(uuid, jsonb, jsonb, jsonb, uuid[], text[], text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reschedule_job_assignments_v1(uuid, jsonb, jsonb, jsonb, uuid[], text[], text)
  TO service_role;

COMMENT ON FUNCTION public.reschedule_job_assignments_v1(uuid, jsonb, jsonb, jsonb, uuid[], text[], text) IS
  'Job bookings (20261028150000): moves or stretches one job''s crew bookings in one transaction for ops-api reschedule_job_bookings. Every row changes or none does.';
