BEGIN;
\ir ../../../rollbacks/20261118104627_group_claim_confirm_down.sql
\ir ../../../migrations/20261118104627_group_claim_confirm.sql
\ir ../20261117171901_group_inclusive_pay_basis/fixture.sql
DO $test$
DECLARE
  grp uuid := pg_temp.zztest_group_fixture();
  a uuid := 'f1171901-0000-4000-8000-000000000002';
  b uuid := 'f1171901-0000-4000-8000-000000000003';
  c uuid := 'f1171901-0000-4000-8000-000000000004';
  h text; changed_hash text; answer jsonb; old_deadline timestamptz; job uuid := 'f1171901-0000-4000-8000-000000000101';
  booking uuid:=gen_random_uuid(); foreign_booking uuid:=gen_random_uuid(); saved_clock jsonb;
  d jsonb := '[{"work_date":"2026-11-16","start_time":"08:00","finish_time":"16:00","hours":7.5,"break_minutes":30,"suggested":{"source":"none"},"changed_from_suggestion":null}]';
BEGIN
  UPDATE public.feature_flags SET enabled=true WHERE flag_name IN ('group_claim_flow_v1','group_work_order_v1');
  DELETE FROM public.group_work_order_time_entries WHERE group_id=grp;
  INSERT INTO public.job_assignments(id,job_id,user_id,scheduled_date,clocked_on_at,clocked_off_at,hours_worked,break_minutes)
    VALUES(booking,job,a,'2026-11-16','2026-11-16 08:00+08','2026-11-16 16:00+08',7.5,30),
          (foreign_booking,job,b,'2026-11-16','2026-11-16 08:00+08','2026-11-16 16:00+08',7.5,30);
  saved_clock:=public.group_claim_clock(grp,a);
  IF jsonb_array_length(saved_clock->'bookings')<>1 OR saved_clock#>>'{bookings,0,id}'<>booking::text THEN
    RAISE EXCEPTION 'wrong_clock_owner'; END IF;
  BEGIN
    PERFORM public.group_claim_hours(grp,a,'replace',jsonb_set(d,'{0,suggested}',
      jsonb_build_object('source','clock','booking_id',foreign_booking)),saved_clock);
    RAISE EXCEPTION 'accepted_foreign_booking';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'group_clock_changed' THEN RAISE; END IF; END;
  UPDATE public.job_assignments SET break_minutes=45 WHERE id=booking;
  BEGIN
    PERFORM public.group_claim_hours(grp,a,'replace',d,saved_clock);
    RAISE EXCEPTION 'accepted_stale_booking';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'group_clock_changed' THEN RAISE; END IF; END;
  IF EXISTS(SELECT 1 FROM public.group_work_order_time_entries WHERE group_id=grp)
    OR EXISTS(SELECT 1 FROM public.group_work_order_events WHERE group_id=grp AND action='confirm_hours')
    THEN RAISE EXCEPTION 'refusal_partially_wrote'; END IF;
  PERFORM public.group_claim_hours(grp,a,'replace',d,public.group_claim_clock(grp,a));
  SELECT claim_deadline_at INTO old_deadline FROM public.group_work_orders
    WHERE id=grp AND claim_started_by=a AND claim_state='waiting_hours';
  IF old_deadline IS NULL OR abs(extract(epoch FROM old_deadline-clock_timestamp())-172800)>10 THEN
    RAISE EXCEPTION 'first_confirm_deadline'; END IF;
  answer:=public.group_claim_read(grp,a);
  IF answer->>'split_hash' IS NOT NULL OR answer->>'my_share' IS NOT NULL OR (answer->>'my_hours')::numeric<>7.5 THEN
    RAISE EXCEPTION 'missing_hours_claim'; END IF;
  PERFORM public.group_claim_hours(grp,b,'upsert',d,public.group_claim_clock(grp,b));
  PERFORM public.group_claim_hours(grp,c,'replace',d,public.group_claim_clock(grp,c));
  answer:=public.group_claim_read(grp,a);
  h:=answer->>'split_hash';
  IF h IS NULL OR answer->>'state'<>'waiting_approval' OR answer->>'my_share' IS NULL OR
    public.group_claim_read(grp,b)->>'split_hash' IS DISTINCT FROM h THEN RAISE EXCEPTION 'shared_hash_missing'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(answer->'crew') m WHERE
    m - ARRAY['user_id','name','how','hours_confirmed','answered'] <> '{}' OR NOT (m->>'hours_confirmed')::boolean)
    THEN RAISE EXCEPTION 'crew_projection'; END IF;
  IF (public.group_claim_decide(grp,a,h,'approve',null)->>'all_approved')::boolean THEN RAISE EXCEPTION 'partial_approval'; END IF;
  PERFORM public.group_claim_decide(grp,a,h,'approve',null);
  IF (SELECT count(*) FROM public.group_work_order_events WHERE group_id=grp AND action='approve_split') <> 1 THEN
    RAISE EXCEPTION 'duplicate_approval'; END IF;
  PERFORM public.group_claim_decide(grp,b,h,'approve',null);
  IF NOT (public.group_claim_decide(grp,c,h,'approve',null)->>'all_approved')::boolean THEN RAISE EXCEPTION 'missing_unanimity'; END IF;
  old_deadline:=(SELECT claim_deadline_at FROM public.group_work_orders WHERE id=grp);
  PERFORM public.group_claim_decide(grp,b,h,'dispute','check the day');
  IF (SELECT claim_state FROM public.group_work_orders WHERE id=grp)<>'disputed' OR
    (SELECT claim_deadline_at FROM public.group_work_orders WHERE id=grp) IS DISTINCT FROM old_deadline OR
    (public.group_claim_decide(grp,c,h,'approve',null)->>'all_approved')::boolean THEN RAISE EXCEPTION 'dispute_not_held'; END IF;
  PERFORM public.group_claim_hours(grp,b,'replace',d,public.group_claim_clock(grp,b));
  IF (SELECT claim_state FROM public.group_work_orders WHERE id=grp)<>'disputed' THEN RAISE EXCEPTION 'retry_reopened_dispute'; END IF;
  d:=jsonb_set(jsonb_set(d,'{0,hours}','9'),'{0,finish_time}','"17:30"');
  PERFORM public.group_claim_hours(grp,b,'upsert',d,public.group_claim_clock(grp,b));
  answer:=public.group_claim_read(grp,b); changed_hash:=answer->>'split_hash';
  IF changed_hash IS NULL OR changed_hash=h OR answer->>'state'<>'waiting_approval' OR
    (answer->>'i_answered')::boolean OR EXISTS(SELECT 1 FROM jsonb_array_elements(answer->'crew') m WHERE m->>'answered'<>'waiting')
    THEN RAISE EXCEPTION 'old_answers_counted'; END IF;
  BEGIN
    PERFORM public.group_claim_decide(grp,c,h,'approve',null);
    RAISE EXCEPTION 'accepted_stale_hash';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'group_split_changed' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.group_claim_read(grp,gen_random_uuid());
    RAISE EXCEPTION 'accepted_non_member';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'group_claim_not_member' THEN RAISE; END IF; END;
  UPDATE public.group_work_orders SET claim_state='invoiced' WHERE id=grp;
  BEGIN
    PERFORM public.group_claim_hours(grp,c,'replace',d,public.group_claim_clock(grp,c));
    RAISE EXCEPTION 'edited_invoice';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'group_claim_invoiced' THEN RAISE; END IF; END;
  IF has_function_privilege('authenticated','public.group_claim_read(uuid,uuid)','execute')
    OR has_function_privilege('anon','public.group_claim_hours(uuid,uuid,text,jsonb,jsonb)','execute') THEN RAISE EXCEPTION 'browser_grant'; END IF;
END; $test$;
SELECT 'PASS P1-13.6 atomic confirms, participant privacy, identical split, stale approvals, dispute and retry' AS result;
ROLLBACK;
