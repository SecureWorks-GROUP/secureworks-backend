BEGIN;
-- Disposable booking fixtures isolate this contract from unrelated triggers.
SET LOCAL session_replication_role = replica;
DO $$
DECLARE
  trade_id uuid := gen_random_uuid();
  job_id uuid := gen_random_uuid();
  booking_id uuid := gen_random_uuid();
  office_booking_id uuid := gen_random_uuid();
  week_start date := '2026-01-05';
  old_shape public.job_assignments;
BEGIN
  INSERT INTO public.job_assignments(id, job_id, user_id, scheduled_date, status)
    VALUES(booking_id, job_id, trade_id, week_start, 'scheduled')
    RETURNING * INTO old_shape;
  IF old_shape.added_by IS DISTINCT FROM 'office' OR old_shape.self_added_status IS NOT NULL THEN
    RAISE EXCEPTION 'ZZTEST old-shape booking must default to office';
  END IF;
  BEGIN
    UPDATE public.job_assignments SET added_by = 'self' WHERE id = booking_id;
    RAISE EXCEPTION 'ZZTEST self without status was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.job_assignments SET self_added_status = 'added' WHERE id = booking_id;
    RAISE EXCEPTION 'ZZTEST office with status was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.job_assignments SET added_by = 'self', self_added_status = 'added', is_lead = true
      WHERE id = booking_id;
    RAISE EXCEPTION 'ZZTEST self-appointed lead was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  UPDATE public.job_assignments SET added_by = 'self', self_added_status = 'not_accepted'
    WHERE id = booking_id;
  IF public.trade_is_off_job_crew(trade_id, job_id, week_start) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'ZZTEST not-accepted booking must be off crew';
  END IF;
  INSERT INTO public.job_assignments(id, job_id, user_id, scheduled_date, status)
    VALUES(office_booking_id, job_id, trade_id, week_start + 6, 'scheduled');
  IF public.trade_is_off_job_crew(trade_id, job_id, week_start) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'ZZTEST office booking in same week must keep trade on crew';
  END IF;
  UPDATE public.job_assignments SET scheduled_date = week_start + 7 WHERE id = office_booking_id;
  IF public.trade_is_off_job_crew(trade_id, job_id, week_start) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'ZZTEST next-week office booking must not change this week';
  END IF;
  DELETE FROM public.job_assignments WHERE id = office_booking_id;
  UPDATE public.job_assignments SET self_added_status = 'accepted' WHERE id = booking_id;
  IF public.trade_is_off_job_crew(trade_id, job_id, week_start) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'ZZTEST accepted booking must keep trade on crew';
  END IF;
  INSERT INTO public.job_assignments(id, job_id, user_id, scheduled_date, status, added_by, self_added_status)
    VALUES(office_booking_id, job_id, trade_id, week_start + 1, 'scheduled', 'self', 'not_accepted');
  IF public.trade_is_off_job_crew(trade_id, job_id, week_start) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'ZZTEST accepted booking must outweigh another rejected booking';
  END IF;
  DELETE FROM public.job_assignments WHERE id = office_booking_id;
  UPDATE public.job_assignments SET self_added_status = 'not_accepted', status = 'cancelled'
    WHERE id = booking_id;
  IF public.trade_is_off_job_crew(trade_id, job_id, week_start) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'ZZTEST cancelled booking must not exclude trade';
  END IF;
  IF public.trade_is_off_job_crew(gen_random_uuid(), job_id, week_start) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'ZZTEST absent booking must not exclude trade';
  END IF;
  UPDATE public.job_assignments SET self_added_status = 'added', status = 'scheduled'
    WHERE id = booking_id;
  IF public.trade_is_off_job_crew(trade_id, job_id, week_start) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'ZZTEST unreviewed booking must keep trade on crew';
  END IF;
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'trade_self_add_v1') IS DISTINCT FROM false
    OR has_function_privilege('anon', 'public.trade_is_off_job_crew(uuid,uuid,date)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.trade_is_off_job_crew(uuid,uuid,date)', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.trade_is_off_job_crew(uuid,uuid,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ZZTEST switch or service-only function access differs';
  END IF;
END $$;
SELECT 'PASS: P1-16.11 booking shape, lead refusal, weekly crew decision and private access' AS result;
ROLLBACK;
