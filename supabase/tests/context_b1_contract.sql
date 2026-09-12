\set ON_ERROR_STOP on
BEGIN;
CREATE SCHEMA cron;
CREATE TABLE cron.job(jobid bigint PRIMARY KEY,jobname text,command text);
CREATE FUNCTION cron.alter_job(job_id bigint,command text) RETURNS void LANGUAGE sql AS $$ UPDATE cron.job SET command=$2 WHERE jobid=$1 $$;
INSERT INTO cron.job VALUES
 (1,'monitor-inbox-poll','SELECT public.trigger_monitor_inbox()'),
 (2,'xero-invoice-sync',$cmd$SELECT public.trigger_xero_sync('sync_invoices')$cmd$),
 (3,'contact-matching',$cmd$SELECT public.trigger_xero_sync('match_contacts')$cmd$),
 (4,'unrelated','SELECT unrelated()');

CREATE TEMP TABLE invoice_cron_calls(action text);
CREATE OR REPLACE FUNCTION public.trigger_xero_sync(p_action text) RETURNS void LANGUAGE sql AS $$ INSERT INTO invoice_cron_calls VALUES(p_action) $$;
SELECT * FROM public.automation_switch_wrap_cron_jobs();
DO $$
DECLARE r jsonb; r2 jsonb; d date := (now() AT TIME ZONE 'Australia/Perth')::date;
 j uuid := gen_random_uuid(); e uuid := gen_random_uuid(); tok uuid; run uuid; old_tok uuid; i integer; invoice_command text;
BEGIN
 IF NOT public.automation_lane_enabled('capture') THEN RAISE EXCEPTION 'seed'; END IF;
 IF public.automation_lane_enabled(NULL) OR public.automation_lane_enabled('unknown') THEN RAISE EXCEPTION 'unknown lane'; END IF;
 UPDATE public.automation_switches SET all_stop=true;
 IF public.automation_lane_enabled('capture') THEN RAISE EXCEPTION 'all stop'; END IF;
 UPDATE public.automation_switches SET all_stop=false,capture=false;
 IF public.automation_lane_enabled('capture') OR NOT public.automation_lane_enabled('extraction') THEN RAISE EXCEPTION 'lane isolation'; END IF;
 SELECT command INTO invoice_command FROM cron.job WHERE jobid=2;
 EXECUTE invoice_command;
 IF (SELECT count(*) FROM invoice_cron_calls WHERE action='sync_invoices')<>1 THEN RAISE EXCEPTION 'capture stopped finance cron'; END IF;
 DELETE FROM public.automation_switches;
 IF public.automation_lane_enabled('capture') THEN RAISE EXCEPTION 'missing row'; END IF;
 IF public.reserve_context_model_call('bucket',NULL,NULL)->>'outcome'<>'paused' THEN RAISE EXCEPTION 'missing switch admitted call'; END IF;
 INSERT INTO public.automation_switches(id) VALUES(1);
 ALTER TABLE public.automation_switches RENAME TO automation_switches_test_missing;
 IF public.automation_lane_enabled('capture') THEN RAISE EXCEPTION 'missing table'; END IF;
 IF public.reserve_context_model_call('bucket',NULL,NULL)->>'outcome'<>'paused' THEN RAISE EXCEPTION 'missing table admitted call'; END IF;
 ALTER TABLE public.automation_switches_test_missing RENAME TO automation_switches;
 ALTER TABLE public.automation_switches RENAME COLUMN capture TO capture_test_missing;
 IF public.automation_lane_enabled('capture') THEN RAISE EXCEPTION 'read error'; END IF;
 ALTER TABLE public.automation_switches RENAME COLUMN capture_test_missing TO capture;
 IF (SELECT count(*) FROM public.automation_switch_cron_lanes())<>2 THEN RAISE EXCEPTION 'cron map'; END IF;
 IF EXISTS(SELECT 1 FROM public.automation_switch_wrap_cron_jobs() WHERE outcome<>'already_wrapped') THEN RAISE EXCEPTION 'reapply'; END IF;
 IF EXISTS(SELECT 1 FROM public.automation_switch_unwrap_cron_jobs() WHERE outcome<>'unwrapped') THEN RAISE EXCEPTION 'unwrap'; END IF;
 IF EXISTS(SELECT 1 FROM public.automation_switch_wrap_cron_jobs() WHERE outcome<>'wrapped') THEN RAISE EXCEPTION 'wrap'; END IF;
 UPDATE cron.job SET command='SELECT something(); SELECT another()' WHERE jobid=1;
 BEGIN
  PERFORM * FROM public.automation_switch_wrap_cron_jobs();
  RAISE EXCEPTION 'unexpected cron was not rejected' USING ERRCODE='ZX001';
 EXCEPTION WHEN raise_exception THEN NULL;
 END;
 INSERT INTO public.jobs(id,org_id,status,type,job_number) VALUES(j,gen_random_uuid(),'draft','patio','B1-'||j);
 -- B2 provenance: a job_id without an explicit method is a hint and is cleared.
 INSERT INTO public.business_events(id,job_id,match_method,payload)
  VALUES(e,j,'direct_job_id',jsonb_build_object('body','B1 contract source'));
 r:=public.claim_context_extraction_run(j,d,'extraction');
 IF r->>'outcome'<>'claimed' THEN RAISE EXCEPTION 'claim %',r; END IF;
 run:=(r->'run'->>'id')::uuid;tok:=(r->'run'->>'lease_token')::uuid;
 IF public.claim_context_extraction_run(j,d,'extraction')->>'outcome'<>'busy' THEN RAISE EXCEPTION 'duplicate lease'; END IF;
 IF public.finish_context_extraction_run(run,gen_random_uuid(),'done',ARRAY[e],1,0,0,0,NULL,NULL) THEN RAISE EXCEPTION 'wrong fence'; END IF;
 IF public.reserve_context_model_call('extraction',run,tok)->>'outcome'<>'reserved' THEN RAISE EXCEPTION 'first call'; END IF;
 IF NOT public.finish_context_extraction_run(run,tok,'failed','{}',0,0,0,0,'rate limit',now()+interval '1 hour') THEN RAISE EXCEPTION 'finish failure'; END IF;
 IF public.claim_context_extraction_run(j,d,'extraction')->>'outcome'<>'paused' THEN RAISE EXCEPTION 'retry pause'; END IF;
 UPDATE public.context_extraction_runs SET retry_at=now()-interval '1 second' WHERE id=run;
 old_tok:=tok;
 r:=public.claim_context_extraction_run(j,d,'extraction'); tok:=(r->'run'->>'lease_token')::uuid;
 IF r->>'outcome'<>'claimed' OR (r->'run'->>'attempts')::int<>2 THEN RAISE EXCEPTION 'retry'; END IF;
 IF public.reserve_context_model_call('extraction',run,old_tok)->>'outcome'<>'stale' THEN RAISE EXCEPTION 'old lease call'; END IF;
 IF public.reserve_context_model_call('extraction',run,tok)->>'ordinal'<>'2' THEN RAISE EXCEPTION 'retry consumes call'; END IF;
 IF NOT public.finish_context_extraction_run(run,tok,'done',ARRAY[e],10,1,0,0,NULL,NULL) THEN RAISE EXCEPTION 'completion'; END IF;
 IF (SELECT count(*) FROM public.context_extraction_event_receipts WHERE event_id=e)<>1 THEN RAISE EXCEPTION 'receipt'; END IF;
 IF public.claim_context_extraction_run(j,d,'extraction')->>'outcome'<>'done' THEN RAISE EXCEPTION 'done not repeated'; END IF;
 IF public.reserve_context_model_call('extraction',run,tok)->>'outcome'<>'stale' THEN RAISE EXCEPTION 'finished lease call'; END IF;
 BEGIN
  PERFORM public.reserve_context_model_call('extraction',NULL,NULL);
  RAISE EXCEPTION 'unfenced extraction accepted' USING ERRCODE='ZX001';
 EXCEPTION WHEN raise_exception THEN NULL;
 END;
 BEGIN
  PERFORM public.reserve_context_model_call('bucket',run,NULL);
  RAISE EXCEPTION 'partial fence accepted' USING ERRCODE='ZX001';
 EXCEPTION WHEN raise_exception THEN NULL;
 END;
 UPDATE public.automation_switches SET all_stop=true;
 IF public.reserve_context_model_call('bucket',NULL,NULL)->>'outcome'<>'paused' THEN RAISE EXCEPTION 'stopped reservation'; END IF;
 UPDATE public.automation_switches SET all_stop=false,attribution=false;
 IF public.reserve_context_model_call('attribution',NULL,NULL)->>'outcome'<>'paused' THEN RAISE EXCEPTION 'attribution off'; END IF;
 IF public.reserve_context_model_call('bucket',NULL,NULL)->>'outcome'<>'paused' THEN RAISE EXCEPTION 'bucket off'; END IF;
 UPDATE public.automation_switches SET attribution=true;
 INSERT INTO public.context_model_call_reservations(run_date,ordinal,phase,reserved_at) VALUES(d-1,400,'bucket',now()-interval '1 day');
 FOR i IN 3..399 LOOP
  r:=public.reserve_context_model_call(CASE WHEN i%2=0 THEN 'bucket' ELSE 'attribution' END,NULL,NULL);
  IF r->>'outcome'<>'reserved' OR (r->>'ordinal')::int<>i THEN RAISE EXCEPTION 'shared admission %: %',i,r; END IF;
 END LOOP;
 j:=gen_random_uuid();
 INSERT INTO public.jobs(id,org_id,status,type,job_number) VALUES(j,gen_random_uuid(),'draft','patio','B1-'||j);
 r:=public.claim_context_extraction_run(j,d,'extraction');
 run:=(r->'run'->>'id')::uuid;tok:=(r->'run'->>'lease_token')::uuid;
 IF public.reserve_context_model_call('bucket',run,tok)->>'outcome'<>'stale' THEN RAISE EXCEPTION 'wrong phase'; END IF;
 UPDATE public.context_extraction_runs SET lease_expires_at=now()-interval '1 second' WHERE id=run;
 IF public.reserve_context_model_call('extraction',run,tok)->>'outcome'<>'stale' THEN RAISE EXCEPTION 'expired reservation'; END IF;
 IF public.finish_context_extraction_run(run,tok,'done','{}',0,0,0,0,NULL,NULL) THEN RAISE EXCEPTION 'expired fence'; END IF;
 old_tok:=tok;
 r:=public.claim_context_extraction_run(j,d,'extraction');tok:=(r->'run'->>'lease_token')::uuid;
 IF r->>'outcome'<>'claimed' OR tok=old_tok THEN RAISE EXCEPTION 'expired reclaim'; END IF;
 UPDATE public.automation_switches SET extraction=false;
 IF public.reserve_context_model_call('extraction',run,tok)->>'outcome'<>'paused' THEN RAISE EXCEPTION 'extraction off'; END IF;
 UPDATE public.automation_switches SET extraction=true;
 r:=public.reserve_context_model_call('extraction',run,tok);
 IF r->>'outcome'<>'reserved' OR r->>'ordinal'<>'400' THEN RAISE EXCEPTION '400th admission %',r; END IF;
 IF NOT public.finish_context_extraction_run(run,tok,'failed','{}',0,0,0,0,'post-model failure',NULL) THEN RAISE EXCEPTION 'post-model failure'; END IF;
 r:=public.claim_context_extraction_run(j,d,'extraction');tok:=(r->'run'->>'lease_token')::uuid;
 IF r->>'outcome'<>'claimed' THEN RAISE EXCEPTION 'claim independent of budget'; END IF;
 IF public.reserve_context_model_call('extraction',run,tok)->>'outcome'<>'cap' THEN RAISE EXCEPTION '401st retry admitted'; END IF;
 j:=gen_random_uuid();
 INSERT INTO public.jobs(id,org_id,status,type,job_number) VALUES(j,gen_random_uuid(),'draft','patio','B1-'||j);
 r:=public.claim_context_extraction_run(j,d,'extraction');
 IF r->>'outcome'<>'claimed' THEN RAISE EXCEPTION 'new claim at cap'; END IF;
 IF public.reserve_context_model_call('extraction',(r->'run'->>'id')::uuid,(r->'run'->>'lease_token')::uuid)->>'outcome'<>'cap' THEN RAISE EXCEPTION '401st new extraction admitted'; END IF;
 IF public.reserve_context_model_call('attribution',NULL,NULL)->>'outcome'<>'cap' THEN RAISE EXCEPTION '401st attribution admitted'; END IF;
 IF public.reserve_context_model_call('bucket',NULL,NULL)->>'outcome'<>'cap' THEN RAISE EXCEPTION '401st bucket admitted'; END IF;
 IF (SELECT count(*) FROM public.context_model_call_reservations WHERE run_date=d)<>400 THEN RAISE EXCEPTION 'reservation budget'; END IF;
 IF has_function_privilege('anon','public.reserve_context_model_call(text,uuid,uuid)','EXECUTE')
 OR has_table_privilege('service_role','public.context_model_call_reservations','DELETE') THEN RAISE EXCEPTION 'reservation permissions'; END IF;
 -- Pass admission is intentionally time-gated. After 06:00 exercise its fence.
 r:=public.claim_context_pass(d);
 IF (now() AT TIME ZONE 'Australia/Perth')::time >= time '06:00' THEN
  IF r->>'outcome'<>'claimed' THEN RAISE EXCEPTION 'pass'; END IF;
  tok:=(r->>'lease_token')::uuid;
  IF NOT public.renew_context_pass(d,tok) OR public.renew_context_pass(d,gen_random_uuid()) THEN RAISE EXCEPTION 'renew fence'; END IF;
  IF public.claim_context_pass(d)->>'outcome'<>'busy' THEN RAISE EXCEPTION 'pass duplicate'; END IF;
  IF NOT public.finish_context_pass(d,tok,'failed',now()+interval '1 hour','rate limit') THEN RAISE EXCEPTION 'pass failure'; END IF;
  IF public.claim_context_pass(d)->>'outcome'<>'paused' THEN RAISE EXCEPTION 'pass retry'; END IF;
  UPDATE public.context_pass_days SET retry_at=NULL;
  r:=public.claim_context_pass(d);tok:=(r->>'lease_token')::uuid;
  IF NOT public.finish_context_pass(d,tok,'done',NULL,NULL) THEN RAISE EXCEPTION 'pass complete'; END IF;
  IF (SELECT runs FROM public.context_pass_days WHERE run_date=d)<>400 THEN RAISE EXCEPTION 'pass counts calls'; END IF;
  IF public.claim_context_pass(d)->>'outcome'<>'done' THEN RAISE EXCEPTION 'pass repeat'; END IF;
 ELSE
  IF r->>'outcome'<>'paused' THEN RAISE EXCEPTION 'pre-six gate'; END IF;
 END IF;
 IF has_function_privilege('anon','public.claim_context_pass(date)','EXECUTE') THEN RAISE EXCEPTION 'public RPC'; END IF;
END $$;
ROLLBACK;
