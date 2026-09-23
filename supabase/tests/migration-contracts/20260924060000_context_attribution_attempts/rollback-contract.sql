DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.reserve_context_model_call(text,uuid,uuid)')) IS DISTINCT FROM '569a31f3e75c7e5e5e75e85cc628adde'
 THEN RAISE EXCEPTION 'a1 rollback: reserve_context_model_call not restored to the live body'; END IF;
 IF to_regclass('public.context_attribution_attempts') IS NOT NULL THEN RAISE EXCEPTION 'a1 rollback: attempts table left'; END IF;
 IF to_regprocedure('public.attribute_context_event_with_luna(uuid,uuid,numeric,text)') IS NOT NULL
  OR to_regprocedure('public.record_attribution_error(uuid,text)') IS NOT NULL
  OR to_regprocedure('public.context_attribution_due(integer)') IS NOT NULL
 THEN RAISE EXCEPTION 'a1 rollback: new functions left'; END IF;
 IF to_regprocedure('public.attribute_context_event_with_luna(uuid,uuid,numeric)') IS NULL THEN RAISE EXCEPTION 'a1 rollback: legacy Luna function lost'; END IF;
 IF NOT has_function_privilege('service_role','public.reserve_context_model_call(text,uuid,uuid)','EXECUTE')
  OR has_function_privilege('anon','public.reserve_context_model_call(text,uuid,uuid)','EXECUTE')
 THEN RAISE EXCEPTION 'a1 rollback: reserve grants wrong'; END IF;
END $$;
