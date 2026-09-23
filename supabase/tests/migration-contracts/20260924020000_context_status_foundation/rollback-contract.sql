-- After the F1 down migration: the 17 Sep heartbeat, statuses, custody writer
-- and current-facts view are back, and every F1 object is gone.
DO $$
DECLARE snap jsonb; f text;
 org uuid:='00000000-0000-0000-0000-000000000001';
 j uuid:=gen_random_uuid(); e uuid; ev jsonb; claimed jsonb; run uuid; tok uuid; result jsonb; fact uuid;
 d date:=(now() AT TIME ZONE 'Australia/Perth')::date;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_linked_status(text)','public.context_unplaced_for_job(uuid)','public.context_source_freshness()',
  'public.context_source_freshness_policy()','public.context_in_business_hours(timestamptz)','public.context_business_minutes(timestamptz,timestamptz)',
  'public.context_core_status()','public.context_cadence_status()','public.context_ghl_capture_status()',
  'public.context_booking_capture_status()','public.context_parties_status()','public.record_capture_run(jsonb)'] LOOP
  IF to_regprocedure(f) IS NOT NULL THEN RAISE EXCEPTION 'f1 rollback left %',f; END IF;
 END LOOP;
 IF to_regclass('public.context_capture_runs') IS NOT NULL THEN RAISE EXCEPTION 'f1 rollback left context_capture_runs'; END IF;
 -- The live production bodies are back byte for byte; the other overload never moved.
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_pipeline_status()')) IS DISTINCT FROM '0fa6842cebf236e47b608a520c6c9fd1'
 THEN RAISE EXCEPTION 'f1 rollback heartbeat is not the live body'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.persist_luna_context_revision(uuid,uuid,uuid,jsonb,jsonb,jsonb,jsonb,text,integer)'))
    IS DISTINCT FROM 'd3441ee4b6c93777564f1385b00c73dc'
 THEN RAISE EXCEPTION 'f1 rollback custody writer is not the live body'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.persist_luna_context_revision(text,text,jsonb,text,jsonb)'))
    IS DISTINCT FROM 'f8c4bd29bba0878396ee7626c21ee65d'
 THEN RAISE EXCEPTION 'f1 rollback moved the 5-arg overload'; END IF;
 IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid='public.business_events'::regclass AND c.conname='business_events_attribution_status_check')
    IS DISTINCT FROM 'CHECK ((attribution_status = ANY (ARRAY[''direct''::text, ''thread''::text, ''single_open''::text, ''single_line''::text, ''luna''::text, ''admin_bucket''::text, ''pending_luna''::text, ''empty''::text, ''automated''::text])))'
 THEN RAISE EXCEPTION 'f1 rollback status check is not the live nine values'; END IF;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.business_events'::regclass AND attname='candidate_job_ids' AND NOT attisdropped)
 THEN RAISE EXCEPTION 'f1 rollback left candidate_job_ids'; END IF;
 IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname='business_events_attribution_status_check')) LIKE '%unplaced%'
 THEN RAISE EXCEPTION 'f1 rollback left the wide status check'; END IF;
 snap:=public.context_pipeline_status();
 IF snap ? 'alarms' OR snap ? 'capture_sources' OR snap->'coverage' IS NULL OR snap->>'run_date' IS NULL
 THEN RAISE EXCEPTION 'f1 rollback heartbeat shape %',snap; END IF;
 IF has_function_privilege('anon','public.context_pipeline_status()','EXECUTE') OR NOT has_function_privilege('service_role','public.context_pipeline_status()','EXECUTE')
 THEN RAISE EXCEPTION 'f1 rollback heartbeat grants'; END IF;

 INSERT INTO public.jobs(id,org_id,status,type,job_number) VALUES(j,org,'quoted','fencing','F1-RB-'||j);
 INSERT INTO public.business_events(job_id,match_method,payload,occurred_at)
  VALUES(j,'direct_job_id',jsonb_build_object('body','We would like to go ahead with the quote.'),now()-interval '1 hour')
  RETURNING id,to_jsonb(business_events) INTO e,ev;
 IF ev->>'attribution_status' IS DISTINCT FROM 'direct' THEN RAISE EXCEPTION 'f1 rollback direct insert %',ev; END IF;
 claimed:=public.claim_context_extraction_run(j,d,'extraction'); run:=(claimed->'run'->>'id')::uuid; tok:=(claimed->'run'->>'lease_token')::uuid;
 result:=public.persist_luna_context_revision(run,tok,j,jsonb_build_array(ev),
  jsonb_build_array(jsonb_build_object('kind','note','text','Customer wants to proceed.','confidence',0.9,'source_event_ids',jsonb_build_array(e))),'[]','[]');
 IF result->>'outcome'<>'inserted' THEN RAISE EXCEPTION 'f1 rollback persist refused %',result; END IF;
 fact:=(result->'fact_ids'->>0)::uuid;
 IF NOT EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE id=fact) THEN RAISE EXCEPTION 'f1 rollback fact hidden'; END IF;
 BEGIN
  UPDATE public.business_events SET attribution_status='unplaced' WHERE id=e;
  RAISE EXCEPTION 'f1 rollback accepted unplaced' USING ERRCODE='ZX001';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
