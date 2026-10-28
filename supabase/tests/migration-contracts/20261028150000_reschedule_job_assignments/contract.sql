-- Contract for 20261028150000_reschedule_job_assignments: one job's bookings
-- move or stretch in one step, and a refused plan writes nothing at all.
-- Dates are fixed (Fri 30 Oct 2026 to Thu 5 Nov 2026), never the run's clock.
BEGIN;

INSERT INTO public.users (id, org_id, name, role) VALUES
  ('c1000000-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-0000000000aa', 'Ari Crew (contract)', 'trade'),
  ('c1000000-0000-4000-8000-00000000000b', 'c0000000-0000-4000-8000-0000000000aa', 'Bo Crew (contract)', 'trade'),
  ('c1000000-0000-4000-8000-00000000000c', 'c0000000-0000-4000-8000-0000000000aa', 'Wren Watcher (contract)', 'admin');
INSERT INTO public.jobs (id, org_id, status, type, job_number) VALUES
  ('c2000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000aa', 'scheduled', 'fencing', 'SWF-RJB-1');
-- The money split columns are what the live trade invoice insert trigger
-- (20260827112928) requires of every new row.
INSERT INTO public.trade_invoices (
  id, org_id, user_id, status, invoice_number, subtotal_ex, gst, total_inc,
  gst_on, super_rate, super_amount, gross_earned, net_pay
) VALUES (
  'c4000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000aa',
  'c1000000-0000-4000-8000-00000000000a', 'approved', 'TI-RJB-1',
  250, 0, 250, false, 0.12, 30, 250, 235
);

-- Ari: Fri, Mon, Tue as three one-day rows, and a cancelled Thu row that
-- still holds Ari's Thu key. Bo: one row Fri to Tue. Wren (a watcher): a real
-- row Mon, and her own ghost on Tue and on Thu.
INSERT INTO public.job_assignments
  (id, job_id, user_id, role, status, scheduled_date, scheduled_end, duration_days, assignment_type, crew_name, is_ghost)
VALUES
  ('c3000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-00000000000a', 'lead_installer', 'scheduled', '2026-10-30', '2026-10-30', 1, 'install', 'Ari', false),
  ('c3000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-00000000000a', 'lead_installer', 'scheduled', '2026-11-02', '2026-11-02', 1, 'install', 'Ari', false),
  ('c3000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-00000000000a', 'lead_installer', 'scheduled', '2026-11-03', '2026-11-03', 1, 'install', 'Ari', false),
  ('c3000000-0000-4000-8000-000000000004', 'c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-00000000000c', 'lead_installer', 'scheduled', '2026-11-02', NULL, 1, 'install', 'Wren', false),
  ('c3000000-0000-4000-8000-000000000005', 'c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-00000000000c', 'observer', 'scheduled', '2026-11-03', '2026-11-03', 1, 'observer', 'Wren', true),
  ('c3000000-0000-4000-8000-000000000006', 'c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-00000000000b', 'lead_installer', 'scheduled', '2026-10-30', '2026-11-03', 3, 'install', 'Bo', false),
  ('c3000000-0000-4000-8000-000000000007', 'c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-00000000000a', 'lead_installer', 'cancelled', '2026-11-05', '2026-11-05', 1, 'install', 'Ari', false),
  ('c3000000-0000-4000-8000-000000000008', 'c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-00000000000c', 'observer', 'scheduled', '2026-11-05', '2026-11-05', 1, 'observer', 'Wren', true);

-- Runs one plan; answers 'applied' or '<SQLSTATE>:<reason>'. A refusal undoes
-- every write the call made, exactly as the RPC's own transaction does.
CREATE FUNCTION pg_temp.try_reschedule(
  p_updates jsonb,
  p_deletes jsonb DEFAULT '[]',
  p_creates jsonb DEFAULT '[]',
  p_release uuid[] DEFAULT ARRAY['c1000000-0000-4000-8000-00000000000c']::uuid[],
  p_job uuid DEFAULT 'c2000000-0000-4000-8000-000000000001'
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_state text; v_detail text;
BEGIN
  PERFORM public.reschedule_job_assignments_v1(
    p_job, p_updates, p_deletes, p_creates, p_release,
    ARRAY['draft', 'failed', 'ops-reject'], 'contract@example.test');
  RETURN 'applied';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_detail = PG_EXCEPTION_DETAIL;
  RETURN v_state || ':' || coalesce(v_detail, '');
END $$;

-- Every row of the job as one string, to prove a refusal changed nothing.
CREATE FUNCTION pg_temp.job_rows() RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(concat_ws('|', id, user_id, status, scheduled_date, scheduled_end, duration_days, is_ghost),
                    ';' ORDER BY id)
  FROM public.job_assignments WHERE job_id = 'c2000000-0000-4000-8000-000000000001'
$$;
CREATE FUNCTION pg_temp.job_event_count() RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM public.job_events WHERE job_id = 'c2000000-0000-4000-8000-000000000001'
$$;

CREATE TEMP TABLE before_state AS SELECT pg_temp.job_rows() AS rows, pg_temp.job_event_count() AS events;

-- 1. A failure midway: Ari's Tue row moves to Wed (a good write), then her Mon
-- row is sent onto Thu, where her cancelled row still holds the key. The whole
-- plan is refused and the Wed write is undone.
DO $$
DECLARE v text := pg_temp.try_reschedule('[
  {"id":"c3000000-0000-4000-8000-000000000003","expected_user_id":"c1000000-0000-4000-8000-00000000000a","expected_scheduled_date":"2026-11-03","expected_scheduled_end":"2026-11-03","scheduled_date":"2026-11-04","scheduled_end":"2026-11-04","duration_days":1},
  {"id":"c3000000-0000-4000-8000-000000000002","expected_user_id":"c1000000-0000-4000-8000-00000000000a","expected_scheduled_date":"2026-11-02","expected_scheduled_end":"2026-11-02","scheduled_date":"2026-11-05","scheduled_end":"2026-11-05","duration_days":1}
]');
BEGIN
  IF v <> 'JB409:booking_date_taken' THEN
    RAISE EXCEPTION 'reschedule contract: a clash midway answered % instead of JB409:booking_date_taken', v;
  END IF;
  IF pg_temp.job_rows() <> (SELECT rows FROM before_state) THEN
    RAISE EXCEPTION 'reschedule contract: a refused plan left a row moved';
  END IF;
  IF pg_temp.job_event_count() <> (SELECT events FROM before_state) THEN
    RAISE EXCEPTION 'reschedule contract: a refused plan left a job event';
  END IF;
END $$;

-- 2. A row that changed since it was read refuses the plan.
DO $$
DECLARE v text := pg_temp.try_reschedule('[
  {"id":"c3000000-0000-4000-8000-000000000003","expected_user_id":"c1000000-0000-4000-8000-00000000000a","expected_scheduled_date":"2026-11-02","expected_scheduled_end":"2026-11-02","scheduled_date":"2026-11-04","scheduled_end":"2026-11-04","duration_days":1}
]');
BEGIN
  IF v <> 'JB409:booking_changed' THEN
    RAISE EXCEPTION 'reschedule contract: a stale read answered % instead of JB409:booking_changed', v;
  END IF;
  IF pg_temp.job_rows() <> (SELECT rows FROM before_state) THEN
    RAISE EXCEPTION 'reschedule contract: a stale plan wrote a row';
  END IF;
END $$;

-- 3. A ghost, a cancelled row and another job's id are never moved.
DO $$
DECLARE v text;
BEGIN
  v := pg_temp.try_reschedule('[{"id":"c3000000-0000-4000-8000-000000000005","expected_user_id":"c1000000-0000-4000-8000-00000000000c","expected_scheduled_date":"2026-11-03","expected_scheduled_end":"2026-11-03","scheduled_date":"2026-11-04","scheduled_end":"2026-11-04","duration_days":1}]');
  IF v <> 'JB409:booking_changed' THEN RAISE EXCEPTION 'reschedule contract: a ghost row was movable (%)', v; END IF;
  v := pg_temp.try_reschedule('[{"id":"c3000000-0000-4000-8000-000000000007","expected_user_id":"c1000000-0000-4000-8000-00000000000a","expected_scheduled_date":"2026-11-05","expected_scheduled_end":"2026-11-05","scheduled_date":"2026-11-06","scheduled_end":"2026-11-06","duration_days":1}]');
  IF v <> 'JB409:booking_changed' THEN RAISE EXCEPTION 'reschedule contract: a cancelled row was movable (%)', v; END IF;
  v := pg_temp.try_reschedule('[]', '[]', '[]', ARRAY[]::uuid[], 'c2000000-0000-4000-8000-0000000000ff');
  IF v <> 'JB404:job_not_found' THEN RAISE EXCEPTION 'reschedule contract: an unknown job answered %', v; END IF;
END $$;

-- 4. Wren's real Mon row moving onto Tue, where her own ghost sits: refused
-- when she is not named as a watcher, written when she is (the ghost goes).
DO $$
DECLARE
  plan jsonb := '[{"id":"c3000000-0000-4000-8000-000000000004","expected_user_id":"c1000000-0000-4000-8000-00000000000c","expected_scheduled_date":"2026-11-02","expected_scheduled_end":null,"scheduled_date":"2026-11-03","scheduled_end":"2026-11-03","duration_days":1}]';
  v text;
BEGIN
  v := pg_temp.try_reschedule(plan, '[]', '[]', ARRAY[]::uuid[]);
  IF v <> 'JB409:booking_date_taken' THEN RAISE EXCEPTION 'reschedule contract: a ghost held key answered %', v; END IF;
  IF pg_temp.job_rows() <> (SELECT rows FROM before_state) THEN
    RAISE EXCEPTION 'reschedule contract: an unreleased ghost refusal wrote a row';
  END IF;
END $$;

-- 5. An invoiced booking is never deleted while its invoice is live.
UPDATE public.job_assignments SET invoiced_in = 'c4000000-0000-4000-8000-000000000001'
 WHERE id = 'c3000000-0000-4000-8000-000000000003';
UPDATE before_state SET rows = pg_temp.job_rows();
DO $$
DECLARE v text := pg_temp.try_reschedule('[]', '[
  {"id":"c3000000-0000-4000-8000-000000000003","expected_user_id":"c1000000-0000-4000-8000-00000000000a","expected_scheduled_date":"2026-11-03","expected_scheduled_end":"2026-11-03"}
]');
BEGIN
  IF v <> 'JB409:booking_invoiced' THEN RAISE EXCEPTION 'reschedule contract: an invoiced delete answered %', v; END IF;
  IF pg_temp.job_rows() <> (SELECT rows FROM before_state) THEN
    RAISE EXCEPTION 'reschedule contract: an invoiced booking was deleted';
  END IF;
END $$;
UPDATE public.trade_invoices SET status = 'draft' WHERE id = 'c4000000-0000-4000-8000-000000000001';

-- 6. The whole job moved one working day later: Fri, Mon, Tue become Mon,
-- Tue, Wed; Bo's Fri-Tue row becomes Mon-Wed; Wren's Mon row lands on Tue
-- over her released ghost. Written in the order the caller gives.
DO $$
DECLARE
  out jsonb;
  v_rows text;
BEGIN
  out := public.reschedule_job_assignments_v1(
    'c2000000-0000-4000-8000-000000000001',
    '[
      {"id":"c3000000-0000-4000-8000-000000000003","expected_user_id":"c1000000-0000-4000-8000-00000000000a","expected_scheduled_date":"2026-11-03","expected_scheduled_end":"2026-11-03","scheduled_date":"2026-11-04","scheduled_end":"2026-11-04","duration_days":1},
      {"id":"c3000000-0000-4000-8000-000000000002","expected_user_id":"c1000000-0000-4000-8000-00000000000a","expected_scheduled_date":"2026-11-02","expected_scheduled_end":"2026-11-02","scheduled_date":"2026-11-03","scheduled_end":"2026-11-03","duration_days":1},
      {"id":"c3000000-0000-4000-8000-000000000001","expected_user_id":"c1000000-0000-4000-8000-00000000000a","expected_scheduled_date":"2026-10-30","expected_scheduled_end":"2026-10-30","scheduled_date":"2026-11-02","scheduled_end":"2026-11-02","duration_days":1},
      {"id":"c3000000-0000-4000-8000-000000000004","expected_user_id":"c1000000-0000-4000-8000-00000000000c","expected_scheduled_date":"2026-11-02","expected_scheduled_end":null,"scheduled_date":"2026-11-03","scheduled_end":"2026-11-03","duration_days":1},
      {"id":"c3000000-0000-4000-8000-000000000006","expected_user_id":"c1000000-0000-4000-8000-00000000000b","expected_scheduled_date":"2026-10-30","expected_scheduled_end":"2026-11-03","scheduled_date":"2026-11-02","scheduled_end":"2026-11-04","duration_days":3}
    ]'::jsonb,
    '[]'::jsonb, '[]'::jsonb,
    ARRAY['c1000000-0000-4000-8000-00000000000c']::uuid[],
    ARRAY['draft', 'failed', 'ops-reject'], 'contract@example.test');
  IF jsonb_array_length(out->'updated') <> 5 THEN
    RAISE EXCEPTION 'reschedule contract: the move returned % updated rows, not 5', jsonb_array_length(out->'updated');
  END IF;
  SELECT string_agg(id::text || '=' || scheduled_date || '..' || coalesce(scheduled_end::text, '-'), ',' ORDER BY id)
    INTO v_rows FROM public.job_assignments
   WHERE id IN ('c3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002',
                'c3000000-0000-4000-8000-000000000003', 'c3000000-0000-4000-8000-000000000004',
                'c3000000-0000-4000-8000-000000000006');
  IF v_rows <> 'c3000000-0000-4000-8000-000000000001=2026-11-02..2026-11-02,'
             || 'c3000000-0000-4000-8000-000000000002=2026-11-03..2026-11-03,'
             || 'c3000000-0000-4000-8000-000000000003=2026-11-04..2026-11-04,'
             || 'c3000000-0000-4000-8000-000000000004=2026-11-03..2026-11-03,'
             || 'c3000000-0000-4000-8000-000000000006=2026-11-02..2026-11-04' THEN
    RAISE EXCEPTION 'reschedule contract: the move landed as %', v_rows;
  END IF;
  IF EXISTS (SELECT 1 FROM public.job_assignments WHERE id = 'c3000000-0000-4000-8000-000000000005') THEN
    RAISE EXCEPTION 'reschedule contract: the watcher ghost on the target key was kept';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(out->'bookings') b WHERE b->>'status' = 'cancelled') THEN
    RAISE EXCEPTION 'reschedule contract: the returned bookings carry a cancelled row';
  END IF;
END $$;

-- 7. A stretch: Ari's Wed row is taken off and Wren gets a new Thu row over
-- her own ghost, with the job events create_assignment and delete_assignment
-- write. The draft invoice no longer holds the deleted row.
DO $$
DECLARE
  out jsonb;
  created jsonb;
BEGIN
  out := public.reschedule_job_assignments_v1(
    'c2000000-0000-4000-8000-000000000001',
    '[]'::jsonb,
    '[{"id":"c3000000-0000-4000-8000-000000000003","expected_user_id":"c1000000-0000-4000-8000-00000000000a","expected_scheduled_date":"2026-11-04","expected_scheduled_end":"2026-11-04"}]'::jsonb,
    '[{"user_id":"c1000000-0000-4000-8000-00000000000c","crew_name":"Wren","role":"lead_installer","assignment_type":"install","scheduled_date":"2026-11-05","scheduled_end":"2026-11-05","duration_days":1,"start_time":"07:00:00","end_time":null,"confirmation_status":"tentative","visible_to_trades":true}]'::jsonb,
    ARRAY['c1000000-0000-4000-8000-00000000000c']::uuid[],
    ARRAY['draft', 'failed', 'ops-reject'], 'contract@example.test');
  created := out->'created'->0;
  IF created IS NULL OR created->>'status' <> 'scheduled' OR created->>'scheduled_date' <> '2026-11-05'
     OR (created->>'visible_to_trades')::boolean IS NOT TRUE OR created->>'start_time' <> '07:00:00' THEN
    RAISE EXCEPTION 'reschedule contract: the stretch created %', created;
  END IF;
  IF EXISTS (SELECT 1 FROM public.job_assignments WHERE id IN ('c3000000-0000-4000-8000-000000000003', 'c3000000-0000-4000-8000-000000000008')) THEN
    RAISE EXCEPTION 'reschedule contract: the stretch kept the deleted row or the watcher ghost';
  END IF;
  IF (SELECT count(*) FROM public.job_events
       WHERE job_id = 'c2000000-0000-4000-8000-000000000001'
         AND ((event_type = 'assignment_deleted' AND detail_json->>'date' = '2026-11-04')
           OR (event_type = 'assignment_created' AND detail_json->>'assignment_id' = created->>'id'))) <> 2 THEN
    RAISE EXCEPTION 'reschedule contract: the stretch did not write its two job events';
  END IF;
END $$;

-- 8. Only the service role may call it; the refusal helper is no one's.
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.reschedule_job_assignments_v1(uuid, jsonb, jsonb, jsonb, uuid[], text[], text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.reschedule_job_assignments_v1(uuid, jsonb, jsonb, jsonb, uuid[], text[], text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.reschedule_job_assignments_v1(uuid, jsonb, jsonb, jsonb, uuid[], text[], text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.reschedule_job_assignments_refuse(text, text, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'reschedule contract: the execute grants are wrong';
  END IF;
END $$;

ROLLBACK;
