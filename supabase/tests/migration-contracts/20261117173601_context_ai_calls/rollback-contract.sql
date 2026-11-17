DO $$ BEGIN
  IF to_regclass('public.context_ai_calls') IS NOT NULL
     OR to_regclass('public.context_ai_calls_daily') IS NOT NULL
     OR to_regprocedure('public.context_ai_calls_log(jsonb)') IS NOT NULL
     OR to_regprocedure('public.context_ai_calls_trim(timestamptz,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'context ai calls rollback: log objects remain';
  END IF;
  IF to_regclass('public.context_model_call_reservations') IS NULL THEN
    RAISE EXCEPTION 'context ai calls rollback: reservation table was removed';
  END IF;
END $$;
