-- After the down migration (which checks the three restored md5 values
-- itself): the settings table is gone, grants are service role only, and a
-- catch-up-only job is due again at 300 calls (the shared pool).
DO $$
DECLARE f regprocedure;
BEGIN
 IF to_regclass('public.context_cadence_settings') IS NOT NULL THEN RAISE EXCEPTION 'backlog ceiling rollback left the settings table'; END IF;
 FOREACH f IN ARRAY ARRAY['public.context_jobs_cadence(uuid[])','public.context_cadence_status()','public.claim_context_extraction_run(uuid,date,text)']::regprocedure[] LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') OR NOT has_function_privilege('service_role',f,'EXECUTE')
  THEN RAISE EXCEPTION 'backlog ceiling rollback grants on %',f; END IF;
 END LOOP;
END $$;

BEGIN;
DO $$
DECLARE base jsonb:=public.context_cadence_policy(); j uuid:=gen_random_uuid(); e uuid; d date:=(now() AT TIME ZONE 'Australia/Perth')::date; c jsonb;
BEGIN
 EXECUTE format('CREATE OR REPLACE FUNCTION public.context_cadence_policy() RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $b$ SELECT %L::jsonb $b$',
  base||jsonb_build_object('live_since',now()-interval '10 days','morning_until','00:00'));
 INSERT INTO public.jobs(id,org_id,status,type,job_number,metadata,created_at)
  VALUES(j,'00000000-0000-0000-0000-000000000001','scheduled','fencing','BC-RB','{}',now()-interval '60 days');
 INSERT INTO public.business_events(job_id,match_method,direction,event_type,source,payload,occurred_at,event_at)
  VALUES(j,'direct_job_id','inbound','client.sms_in','ceiling_contract','{"body":"Old message"}',now()-interval '12 days',now()-interval '12 days') RETURNING id INTO e;
 UPDATE public.business_events SET context_captured_at=now()-interval '12 days',metadata=coalesce(metadata,'{}'::jsonb)-'written_as' WHERE id=e;
 INSERT INTO public.context_catchup_jobs(job_id,job_number,priority,mode,scope) VALUES(j,'BC-RB',2,'full','backlog');
 INSERT INTO public.context_model_call_reservations(run_date,ordinal,phase,reserved_at)
  SELECT d,g,'attribution',now() FROM generate_series(coalesce((SELECT max(ordinal) FROM public.context_model_call_reservations WHERE run_date=d),0)+1,300) g;
 c:=public.context_job_cadence(j);
 IF NOT (c->>'due')::boolean OR c ? 'backlog_budget_held' THEN RAISE EXCEPTION 'backlog ceiling rollback did not restore the shared pool %',c; END IF;
END $$;
ROLLBACK;
