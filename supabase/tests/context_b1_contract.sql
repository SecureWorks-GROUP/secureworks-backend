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

SELECT * FROM public.automation_switch_wrap_cron_jobs();
DO $$
DECLARE r jsonb; r2 jsonb; d date := (now() AT TIME ZONE 'Australia/Perth')::date;
 j uuid := gen_random_uuid(); e uuid := gen_random_uuid(); tok uuid; run uuid;
BEGIN
 IF NOT public.automation_lane_enabled('capture') THEN RAISE EXCEPTION 'seed'; END IF;
 IF public.automation_lane_enabled(NULL) OR public.automation_lane_enabled('unknown') THEN RAISE EXCEPTION 'unknown lane'; END IF;
 UPDATE public.automation_switches SET all_stop=true;
 IF public.automation_lane_enabled('capture') THEN RAISE EXCEPTION 'all stop'; END IF;
 UPDATE public.automation_switches SET all_stop=false,capture=false;
 IF public.automation_lane_enabled('capture') OR NOT public.automation_lane_enabled('extraction') THEN RAISE EXCEPTION 'lane isolation'; END IF;
 DELETE FROM public.automation_switches;
 IF public.automation_lane_enabled('capture') THEN RAISE EXCEPTION 'missing row'; END IF;
 INSERT INTO public.automation_switches(id) VALUES(1);
 ALTER TABLE public.automation_switches RENAME TO automation_switches_test_missing;
 IF public.automation_lane_enabled('capture') THEN RAISE EXCEPTION 'missing table'; END IF;
 ALTER TABLE public.automation_switches_test_missing RENAME TO automation_switches;
 ALTER TABLE public.automation_switches RENAME COLUMN capture TO capture_test_missing;
 IF public.automation_lane_enabled('capture') THEN RAISE EXCEPTION 'read error'; END IF;
 ALTER TABLE public.automation_switches RENAME COLUMN capture_test_missing TO capture;
 IF (SELECT count(*) FROM public.automation_switch_cron_lanes())<>3 THEN RAISE EXCEPTION 'cron map'; END IF;
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
 INSERT INTO public.business_events(id,job_id) VALUES(e,j);
 r:=public.claim_context_extraction_run(j,d,'extraction');
 IF r->>'outcome'<>'claimed' THEN RAISE EXCEPTION 'claim %',r; END IF;
 run:=(r->'run'->>'id')::uuid;tok:=(r->'run'->>'lease_token')::uuid;
 IF public.claim_context_extraction_run(j,d,'extraction')->>'outcome'<>'busy' THEN RAISE EXCEPTION 'duplicate lease'; END IF;
 IF public.finish_context_extraction_run(run,gen_random_uuid(),'done',ARRAY[e],1,0,0,0,NULL,NULL) THEN RAISE EXCEPTION 'wrong fence'; END IF;
 IF NOT public.finish_context_extraction_run(run,tok,'failed','{}',0,0,0,0,'rate limit',now()+interval '1 hour') THEN RAISE EXCEPTION 'finish failure'; END IF;
 IF public.claim_context_extraction_run(j,d,'extraction')->>'outcome'<>'paused' THEN RAISE EXCEPTION 'retry pause'; END IF;
 UPDATE public.context_extraction_runs SET retry_at=now()-interval '1 second' WHERE id=run;
 r:=public.claim_context_extraction_run(j,d,'extraction'); tok:=(r->'run'->>'lease_token')::uuid;
 IF r->>'outcome'<>'claimed' OR (r->'run'->>'attempts')::int<>2 THEN RAISE EXCEPTION 'retry'; END IF;
 IF NOT public.finish_context_extraction_run(run,tok,'done',ARRAY[e],10,1,0,0,NULL,NULL) THEN RAISE EXCEPTION 'completion'; END IF;
 IF (SELECT count(*) FROM public.context_extraction_event_receipts WHERE event_id=e)<>1 THEN RAISE EXCEPTION 'receipt'; END IF;
 IF public.claim_context_extraction_run(j,d,'extraction')->>'outcome'<>'done' THEN RAISE EXCEPTION 'done not repeated'; END IF;
 INSERT INTO public.jobs(id,org_id,status,type,job_number) SELECT id,gen_random_uuid(),'draft','patio','B1-'||id FROM (SELECT gen_random_uuid() id FROM generate_series(1,400)) s;
 INSERT INTO public.context_extraction_runs(job_id,run_date,phase,status)
 SELECT id,d,'extraction','failed' FROM public.jobs WHERE id<>j LIMIT 399;
 SELECT id INTO j FROM public.jobs WHERE id NOT IN (SELECT job_id FROM public.context_extraction_runs) LIMIT 1;
 IF public.claim_context_extraction_run(j,d,'extraction')->>'outcome'<>'cap' THEN RAISE EXCEPTION 'cap'; END IF;
 SELECT job_id INTO j FROM public.context_extraction_runs WHERE status='failed' LIMIT 1;
 IF public.claim_context_extraction_run(j,d,'extraction')->>'outcome'<>'claimed' THEN RAISE EXCEPTION 'retry at cap'; END IF;
 SELECT id,lease_token INTO run,tok FROM public.context_extraction_runs WHERE job_id=j;
 UPDATE public.context_extraction_runs SET lease_expires_at=now()-interval '1 second' WHERE id=run;
 IF public.finish_context_extraction_run(run,tok,'done','{}',0,0,0,0,NULL,NULL) THEN RAISE EXCEPTION 'expired fence'; END IF;
 r:=public.claim_context_extraction_run(j,d,'extraction');
 IF r->>'outcome'<>'claimed' OR (r->'run'->>'lease_token')::uuid=tok THEN RAISE EXCEPTION 'expired reclaim'; END IF;
 IF (SELECT count(*) FROM public.context_extraction_runs WHERE phase='extraction')<>400 THEN RAISE EXCEPTION 'budget'; END IF;
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
  IF public.claim_context_pass(d)->>'outcome'<>'done' THEN RAISE EXCEPTION 'pass repeat'; END IF;
 ELSE
  IF r->>'outcome'<>'paused' THEN RAISE EXCEPTION 'pre-six gate'; END IF;
 END IF;
 IF has_function_privilege('anon','public.claim_context_pass(date)','EXECUTE') THEN RAISE EXCEPTION 'public RPC'; END IF;
END $$;
ROLLBACK;
