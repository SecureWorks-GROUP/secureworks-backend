-- After the K1 down migration: the live bodies are back (the down migration
-- checks their md5 itself), every K1 function is gone, the heartbeat's cadence
-- block is null again, and the rollback claim keeps one run a day even though
-- run_seq rows remain.
DO $$
DECLARE f text; j uuid:=gen_random_uuid(); e uuid; d date:=(now() AT TIME ZONE 'Australia/Perth')::date; c jsonb; meta jsonb;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_cadence_policy()','public.context_request_role()','public.context_event_status_only(public.business_events)',
  'public.context_unread_rows(uuid[])','public.context_unread_events(uuid)','public.context_event_is_ours(public.business_events)',
  'public.context_jobs_cadence(uuid[])','public.context_job_cadence(uuid)','public.context_cadence_pool()','public.context_extraction_event_flags(uuid,uuid[])',
  'public.renew_context_extraction_run(uuid,uuid)','public.context_job_freshness(uuid)'] LOOP
  IF to_regprocedure(f) IS NOT NULL THEN RAISE EXCEPTION 'k1 rollback left %',f; END IF;
 END LOOP;
 IF public.context_pipeline_status()->'cadence'<>'null'::jsonb THEN RAISE EXCEPTION 'k1 rollback cadence block not null'; END IF;
 IF has_function_privilege('anon','public.claim_context_extraction_run(uuid,date,text)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.claim_context_extraction_run(uuid,date,text)','EXECUTE')
 THEN RAISE EXCEPTION 'k1 rollback claim grants'; END IF;
 -- Kept: run_seq and its index; the daily index is not recreated.
 IF to_regclass('public.context_extraction_runs_job_day_phase_seq') IS NULL OR to_regclass('public.context_extraction_runs_job_day_phase') IS NOT NULL
 THEN RAISE EXCEPTION 'k1 rollback run ledger indexes'; END IF;
 -- The trigger stops recording written_as.
 INSERT INTO public.jobs(id,org_id,status,type,job_number) VALUES(j,'00000000-0000-0000-0000-000000000001','quoted','fencing','K1-RB-'||j);
 INSERT INTO public.business_events(job_id,match_method,direction,payload) VALUES(j,'direct_job_id','inbound','{"body":"After rollback"}') RETURNING id,metadata INTO e,meta;
 IF meta ? 'written_as' THEN RAISE EXCEPTION 'k1 rollback trigger still records written_as'; END IF;
 -- Two runs today under K1 (run_seq 1 done, run_seq 2 failed): the rollback
 -- claim reads any completed read today as done.
 INSERT INTO public.context_extraction_runs(job_id,run_date,phase,status,run_seq,finished_at) VALUES(j,d,'extraction','done',1,now());
 INSERT INTO public.context_extraction_runs(job_id,run_date,phase,status,run_seq,error) VALUES(j,d,'extraction','failed',2,'timeout');
 c:=public.claim_context_extraction_run(j,d,'extraction');
 IF c->>'outcome'<>'done' THEN RAISE EXCEPTION 'k1 rollback claim %',c; END IF;
 DELETE FROM public.context_extraction_runs WHERE job_id=j;
 c:=public.claim_context_extraction_run(j,d,'extraction');
 IF c->>'outcome'<>'claimed' OR public.claim_context_extraction_run(j,d,'extraction')->>'outcome'<>'busy' THEN RAISE EXCEPTION 'k1 rollback fresh claim %',c; END IF;
 DELETE FROM public.context_extraction_runs WHERE job_id=j;
 DELETE FROM public.business_events WHERE job_id=j;
 DELETE FROM public.jobs WHERE id=j;
END $$;
