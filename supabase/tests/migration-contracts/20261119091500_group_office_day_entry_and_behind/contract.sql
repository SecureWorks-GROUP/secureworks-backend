-- G4 office day entry and crew dispute (20261119091500). ZZTEST fixture only.
BEGIN;
\ir ../20261117171901_group_inclusive_pay_basis/fixture.sql
DO $test$
DECLARE
  grp uuid := pg_temp.zztest_group_fixture();
  office uuid := 'f1171901-0000-4000-8000-000000000001';
  a uuid := 'f1171901-0000-4000-8000-000000000002';
  c uuid := 'f1171901-0000-4000-8000-000000000004';
  outsider uuid := 'f1171901-0000-4000-8000-0000000000aa';
  day jsonb := '[{"work_date":"2026-11-16","start_time":"07:00","finish_time":"15:00","break_minutes":30,"hours":7.5}]';
  answer jsonb;
  row_now public.group_work_order_time_entries;
BEGIN
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'group_office_day_entry_v1') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'switch_not_seeded_off';
  END IF;
  -- Crew C never entered hours, so the claim is stuck waiting for them.
  DELETE FROM public.group_work_order_time_entries WHERE group_id = grp AND user_id = c;
  UPDATE public.group_work_orders SET claim_state = 'waiting_hours', claim_started_by = a,
    claim_deadline_at = clock_timestamp() - interval '1 day' WHERE id = grp;

  -- Off: refused with no write.
  BEGIN
    PERFORM public.group_office_enter_hours(grp, office, c, day, 'ZZTEST absent trade');
    RAISE EXCEPTION 'entered_while_off';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'group_office_day_entry_disabled' THEN RAISE; END IF; END;
  IF EXISTS (SELECT 1 FROM public.group_work_order_time_entries WHERE group_id = grp AND user_id = c) THEN
    RAISE EXCEPTION 'off_wrote'; END IF;
  UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'group_office_day_entry_v1';

  -- Reason, actor and target are checked before any write.
  BEGIN
    PERFORM public.group_office_enter_hours(grp, office, c, day, '  x ');
    RAISE EXCEPTION 'short_reason_accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'group_reason_invalid' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.group_office_enter_hours(grp, a, c, day, 'ZZTEST crew entering for crew');
    RAISE EXCEPTION 'trade_entered_for_another';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'group_office_actor_not_staff' THEN RAISE; END IF; END;
  INSERT INTO public.users(id, org_id, name, role) VALUES (outsider, '00000000-0000-0000-0000-000000000001', 'ZZTEST outsider', 'crew');
  BEGIN
    PERFORM public.group_office_enter_hours(grp, office, outsider, day, 'ZZTEST not on the crew');
    RAISE EXCEPTION 'non_member_entered';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'group_office_target_not_member' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.group_office_enter_hours(grp, office, c,
      '[{"work_date":"2099-01-01","start_time":"07:00","finish_time":"15:00","break_minutes":0,"hours":8}]', 'ZZTEST future day');
    RAISE EXCEPTION 'future_day_accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'group_day_invalid' THEN RAISE; END IF; END;
  IF EXISTS (SELECT 1 FROM public.group_work_order_time_entries WHERE group_id = grp AND user_id = c)
     OR EXISTS (SELECT 1 FROM public.group_work_order_events WHERE group_id = grp AND action = 'office_enter_hours') THEN
    RAISE EXCEPTION 'refusal_partially_wrote'; END IF;

  -- The office enters C's day: marked, attributed, logged, and the claim moves on.
  answer := public.group_office_enter_hours(grp, office, c, day, '  ZZTEST trade away, foreman confirmed  ');
  SELECT * INTO STRICT row_now FROM public.group_work_order_time_entries WHERE group_id = grp AND user_id = c;
  IF NOT row_now.entered_by_office OR row_now.office_entered_by <> office OR row_now.office_entered_at IS NULL
     OR row_now.office_entry_reason <> 'ZZTEST trade away, foreman confirmed' OR row_now.hours <> 7.5 THEN
    RAISE EXCEPTION 'office_entry_not_recorded'; END IF;
  IF (SELECT claim_state FROM public.group_work_orders WHERE id = grp) <> 'waiting_approval'
     OR answer->>'claim_state' <> 'waiting_approval'
     OR (SELECT claim_deadline_at FROM public.group_work_orders WHERE id = grp) <= clock_timestamp() THEN
    RAISE EXCEPTION 'claim_not_moved_on'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.group_work_order_events WHERE group_id = grp AND action = 'office_enter_hours'
      AND actor_user_id = office AND detail->>'user_id' = c::text AND detail->>'reason' = 'ZZTEST trade away, foreman confirmed') THEN
    RAISE EXCEPTION 'office_entry_not_logged'; END IF;

  -- Nobody but the two functions can set or alter the office columns.
  BEGIN
    INSERT INTO public.group_work_order_time_entries(group_id, user_id, work_date, start_time, finish_time, break_minutes, hours,
      entered_by_office, office_entered_by, office_entered_at, office_entry_reason)
      VALUES (grp, a, '2026-11-17', '07:00', '15:00', 0, 8, true, office, now(), 'ZZTEST forged');
    RAISE EXCEPTION 'forged_insert_accepted';
  EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM <> 'group_office_entry_forged' THEN RAISE; END IF; END;
  BEGIN
    UPDATE public.group_work_order_time_entries SET office_entry_reason = 'ZZTEST rewritten'
      WHERE group_id = grp AND user_id = c;
    RAISE EXCEPTION 'forged_update_accepted';
  EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM <> 'group_office_entry_forged' THEN RAISE; END IF; END;

  -- Only the person the office entered days for may dispute them.
  BEGIN
    PERFORM public.group_office_dispute_hours(grp, a, 'ZZTEST not my entry');
    RAISE EXCEPTION 'dispute_without_office_entry';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'group_office_entry_not_found' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.group_office_dispute_hours(grp, outsider, 'ZZTEST outsider');
    RAISE EXCEPTION 'outsider_disputed';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'group_claim_not_member' THEN RAISE; END IF; END;
  answer := public.group_office_dispute_hours(grp, c, 'ZZTEST I worked a longer day');
  IF NOT (answer->>'disputed')::boolean OR (answer->>'already_disputed')::boolean THEN RAISE EXCEPTION 'dispute_answer'; END IF;
  IF NOT public.group_work_order_office_dispute_open(grp) THEN RAISE EXCEPTION 'dispute_not_open'; END IF;
  IF NOT (public.group_office_dispute_hours(grp, c, 'ZZTEST again')->>'already_disputed')::boolean THEN
    RAISE EXCEPTION 'repeat_dispute_not_idempotent'; END IF;

  -- An open dispute holds the group: no freeze, no invoiced claim.
  BEGIN
    UPDATE public.group_work_orders SET split_frozen_at = clock_timestamp() WHERE id = grp;
    RAISE EXCEPTION 'dispute did not hold the freeze';
  EXCEPTION WHEN check_violation THEN IF SQLERRM <> 'group_office_hours_disputed' THEN RAISE; END IF; END;
  BEGIN
    UPDATE public.group_work_orders SET claim_state = 'invoiced' WHERE id = grp;
    RAISE EXCEPTION 'dispute did not hold the claim';
  EXCEPTION WHEN check_violation THEN IF SQLERRM <> 'group_office_hours_disputed' THEN RAISE; END IF; END;

  -- The office entering the days again resolves it; the log keeps the dispute.
  answer := public.group_office_enter_hours(grp, office, c,
    '[{"work_date":"2026-11-16","start_time":"07:00","finish_time":"16:00","break_minutes":30,"hours":8.5}]',
    'ZZTEST checked with the crew');
  IF (answer->>'resolved_disputes')::int <> 1 OR public.group_work_order_office_dispute_open(grp) THEN
    RAISE EXCEPTION 'reentry_did_not_resolve'; END IF;
  SELECT * INTO STRICT row_now FROM public.group_work_order_time_entries WHERE group_id = grp AND user_id = c;
  IF row_now.disputed_at IS NOT NULL OR row_now.hours <> 8.5 OR row_now.office_entry_reason <> 'ZZTEST checked with the crew' THEN
    RAISE EXCEPTION 'reentry_not_fresh'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.group_work_order_events WHERE group_id = grp AND action = 'dispute_office_hours'
      AND actor_user_id = c AND detail->>'reason' = 'ZZTEST I worked a longer day') THEN
    RAISE EXCEPTION 'dispute_not_logged'; END IF;

  -- The person changing the day themselves makes it their own entry.
  PERFORM public.group_office_dispute_hours(grp, c, 'ZZTEST still wrong');
  UPDATE public.group_work_order_time_entries SET hours = 9, finish_time = '16:30'
    WHERE group_id = grp AND user_id = c;
  SELECT * INTO STRICT row_now FROM public.group_work_order_time_entries WHERE group_id = grp AND user_id = c;
  IF row_now.entered_by_office OR row_now.office_entered_by IS NOT NULL OR row_now.disputed_at IS NOT NULL
     OR public.group_work_order_office_dispute_open(grp) THEN
    RAISE EXCEPTION 'own_edit_kept_office_marks'; END IF;

  -- A frozen split takes no office entry and no dispute.
  UPDATE public.group_work_orders SET split_frozen_at = clock_timestamp() WHERE id = grp;
  BEGIN
    PERFORM public.group_office_enter_hours(grp, office, c, day, 'ZZTEST after the freeze');
    RAISE EXCEPTION 'entered_after_freeze';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'group_split_frozen' THEN RAISE; END IF; END;

  IF has_function_privilege('anon', 'public.group_office_enter_hours(uuid,uuid,uuid,jsonb,text)', 'execute')
     OR has_function_privilege('authenticated', 'public.group_office_enter_hours(uuid,uuid,uuid,jsonb,text)', 'execute')
     OR has_function_privilege('authenticated', 'public.group_office_dispute_hours(uuid,uuid,text)', 'execute')
     OR has_function_privilege('anon', 'public.group_office_dispute_hours(uuid,uuid,text)', 'execute')
     OR NOT has_function_privilege('service_role', 'public.group_office_dispute_hours(uuid,uuid,text)', 'execute') THEN
    RAISE EXCEPTION 'browser_grant'; END IF;
END; $test$;
SELECT 'PASS G4 office day entry: switch, reason, staff only, own dispute, hold, resolve, own edit wins, freeze' AS result;
ROLLBACK;
