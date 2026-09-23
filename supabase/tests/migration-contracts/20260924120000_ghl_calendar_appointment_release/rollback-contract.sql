DO $$ BEGIN
  IF to_regprocedure('public.release_ghl_calendar_appointment_sending(text,text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'release function survived rollback';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name = 'ghl_calendar_appointment_requests'
    AND column_name IN ('released_at','released_by','release_reason')) THEN
    RAISE EXCEPTION 'release columns survived rollback';
  END IF;
  IF pg_catalog.pg_get_constraintdef((SELECT oid FROM pg_catalog.pg_constraint
    WHERE conname = 'ghl_calendar_appointment_requests_state_check')) <>
    'CHECK ((state = ANY (ARRAY[''reserved''::text, ''sending''::text, ''complete''::text])))' THEN
    RAISE EXCEPTION 'state check not restored';
  END IF;
  PERFORM location_id, idempotency_key, state, lease_until FROM public.ghl_calendar_appointment_requests;
END $$;
