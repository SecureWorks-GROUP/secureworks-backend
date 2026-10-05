-- B-2 behaviour contract (GHL history schedule). Every fixture write is rolled
-- back. Job numbers start B2-; contact ids are synthetic GHL-shaped ids. Each
-- transaction first puts every other job out of scope (archived) and moves
-- every earlier history run a month back, so earlier contracts' fixtures never
-- reach the due list, the day's count or the reading hand-over.
--   1. Grants, hardening and the schedule's numbers.
--   2. The day limit: base, boost from the first scheduled run, boost ended
--      after 7 days, 100 for good from the first GHL rate limit since.
--   3. The quota: a run is charged at the end for what it loaded; a contact
--      attempted earlier today costs nothing again; nothing due writes no run
--      row; an abandoned run keeps only what it recorded; each limit switch is
--      on the run row.
--   4. The link attempt record and the link due list.
--   5. The reading hand-over through the catch-up list.
--   6. The after-check read.
--   7. The schedule on pg_cron stand-ins.

CREATE FUNCTION pg_temp.b2_scope() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 UPDATE public.jobs SET archived=true WHERE job_number IS DISTINCT FROM NULL AND job_number NOT LIKE 'B2-%' AND NOT coalesce(archived,false);
 UPDATE public.jobs SET archived=true WHERE job_number IS NULL AND NOT coalesce(archived,false);
 UPDATE public.context_capture_runs SET started_at=started_at-interval '31 days'
 WHERE source IN ('ghl_history_load','ghl_history_load_dry','ghl_history_link','ghl_history_link_dry');
 DELETE FROM public.context_ghl_history_contacts;
END $$;
CREATE FUNCTION pg_temp.b2_job(p_number text,p_status text,p_contact text,p_quote_sent timestamptz DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,created_at,updated_at)
 VALUES(j,'00000000-0000-0000-0000-000000000001',p_status,'fencing',p_number,p_contact,now()-interval '30 days',now()-interval '30 days');
 IF p_quote_sent IS NOT NULL THEN
  INSERT INTO public.job_documents(job_id,type,sent_at,file_name) VALUES(j,'quote',p_quote_sent,p_number||'-quote.pdf');
 END IF;
 RETURN j;
END $$;
-- A run row of p_source started at p_started, with an actor, an error code and
-- the jobs it counted. Finished unless p_status says running.
CREATE FUNCTION pg_temp.b2_run(p_source text,p_actor text,p_started timestamptz,p_error text DEFAULT NULL,p_jobs integer DEFAULT 0,
 p_status text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r jsonb; st text:=coalesce(p_status,CASE WHEN p_error IS NULL THEN 'succeeded' ELSE 'failed' END);
BEGIN
 r:=public.record_capture_run(jsonb_build_object('source',p_source,'status',st,'error_code',p_error,
  'cursor',jsonb_build_object('v',1,'actor',p_actor),'counts',jsonb_build_object('jobs_covered',p_jobs)));
 UPDATE public.context_capture_runs SET started_at=p_started,updated_at=p_started WHERE id=(r->>'run_id')::uuid;
 RETURN (r->>'run_id')::uuid;
END $$;
-- A ledger row for a contact, attempted at p_at (done rows complete then).
CREATE FUNCTION pg_temp.b2_contact(p_contact text,p_status text,p_jobs integer,p_at timestamptz) RETURNS void LANGUAGE plpgsql AS $$
DECLARE run uuid:=pg_temp.b2_run('ghl_history_load','b2-test',p_at);
BEGIN
 PERFORM public.record_ghl_history_contact(jsonb_build_object('contact_id',p_contact,'run_id',run,'status',p_status,'jobs',p_jobs,
  'actor','b2-test','error_code',CASE WHEN p_status='failed' THEN 'provider_request_failed' END));
 UPDATE public.context_ghl_history_contacts SET last_attempt_at=p_at,first_attempt_at=p_at,
  completed_at=CASE WHEN p_status='done' THEN p_at END WHERE contact_id=p_contact;
END $$;
-- A placed, worded row on the job (through the real trigger), captured p_ago back.
CREATE FUNCTION pg_temp.b2_ev(p_job uuid,p_body text,p_ago interval DEFAULT interval '2 days') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE new_id uuid;
BEGIN
 INSERT INTO public.business_events(job_id,match_method,direction,event_type,source,payload,occurred_at,event_at,metadata)
  VALUES(p_job,'direct_job_id','inbound','client.sms_in','b2_contract',jsonb_build_object('body',p_body),now()-p_ago,now()-p_ago,
   jsonb_build_object('capture_mode','backfill'))
  RETURNING id INTO new_id;
 UPDATE public.business_events SET context_captured_at=now()-p_ago WHERE id=new_id;
 RETURN new_id;
END $$;
CREATE FUNCTION pg_temp.b2_day_start() RETURNS timestamptz LANGUAGE sql AS $$
 SELECT (date_trunc('day',now() AT TIME ZONE 'Australia/Perth')) AT TIME ZONE 'Australia/Perth' $$;
CREATE FUNCTION pg_temp.b2_mine(p_due jsonb) RETURNS text[] LANGUAGE sql AS $$
 SELECT coalesce(array_agg(x->>'contact_id' ORDER BY x->>'contact_id'),'{}') FROM jsonb_array_elements(p_due->'contacts') x $$;

BEGIN;
-- 1. Grants and hardening: service side only, fixed search_path; the link
-- attempt record unreadable by the public key and a signed-in login.
DO $$
DECLARE f regprocedure;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_ghl_history_schedule_policy()','public.context_ghl_history_day_limit(boolean)',
  'public.context_ghl_history_due_at(integer,jsonb)','public.context_ghl_history_due(integer)','public.reserve_ghl_history_run(integer,text)',
  'public.record_ghl_link_attempt(jsonb)','public.context_ghl_history_link_due(integer)','public.context_ghl_history_request_reads(boolean,integer)',
  'public.context_ghl_history_progress()']::regprocedure[] LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') OR has_function_privilege('public',f,'EXECUTE')
  THEN RAISE EXCEPTION 'b2 public execute on %',f; END IF;
  IF NOT has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'b2 service_role cannot execute %',f; END IF;
  IF (SELECT proconfig FROM pg_proc WHERE oid=f) IS NULL THEN RAISE EXCEPTION 'b2 % has no fixed search_path',f; END IF;
 END LOOP;
 IF has_function_privilege('service_role','public.trigger_ghl_history_schedule()','EXECUTE')
  OR has_function_privilege('anon','public.trigger_ghl_history_schedule()','EXECUTE')
  OR NOT has_function_privilege('postgres','public.trigger_ghl_history_schedule()','EXECUTE')
 THEN RAISE EXCEPTION 'b2 the cron caller must be callable by the cron owner only'; END IF;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.context_ghl_history_link_attempts'::regclass)
  OR has_table_privilege('anon','public.context_ghl_history_link_attempts','SELECT')
  OR has_table_privilege('authenticated','public.context_ghl_history_link_attempts','SELECT')
  OR has_table_privilege('service_role','public.context_ghl_history_link_attempts','INSERT')
  OR has_table_privilege('service_role','public.context_ghl_history_link_attempts','UPDATE')
  OR NOT has_table_privilege('service_role','public.context_ghl_history_link_attempts','SELECT')
  OR (SELECT count(*) FROM pg_policy WHERE polrelid='public.context_ghl_history_link_attempts'::regclass)<>0
 THEN RAISE EXCEPTION 'b2 link attempt record grants'; END IF;
 -- The desk decision, in one place; M4's base limit unchanged.
 IF public.context_ghl_history_schedule_policy()->'boost_daily_job_limit'<>'250' OR public.context_ghl_history_schedule_policy()->'boost_days'<>'7'
  OR public.context_ghl_history_schedule_policy()->>'schedule_actor'<>'cron:ghl-history-schedule'
  OR public.context_ghl_history_policy()->'daily_job_limit'<>'100'
 THEN RAISE EXCEPTION 'b2 policy % %',public.context_ghl_history_schedule_policy(),public.context_ghl_history_policy(); END IF;
END $$;
ROLLBACK;

BEGIN;
-- 2. The day limit.
DO $$
DECLARE l jsonb; boost uuid;
BEGIN
 PERFORM pg_temp.b2_scope();
 -- Never scheduled: M4's 100. A scheduled caller with no scheduled run yet: the boost starts now.
 l:=public.context_ghl_history_day_limit(false);
 IF l->>'basis'<>'base' OR l->'daily_job_limit'<>'100' OR l->>'boost_started_at' IS NOT NULL THEN RAISE EXCEPTION 'b2 base %',l; END IF;
 l:=public.context_ghl_history_day_limit(true);
 IF l->>'basis'<>'boost' OR l->'daily_job_limit'<>'250' THEN RAISE EXCEPTION 'b2 first scheduled call %',l; END IF;
 -- A rate limit on a hand run before any scheduled run does not count.
 PERFORM pg_temp.b2_run('ghl_history_load','operator',now()-interval '3 days','ghl_rate_limited');
 -- The first scheduled run (a link run here) two days ago: the boost runs for 7 days from it.
 boost:=pg_temp.b2_run('ghl_history_link','cron:ghl-history-schedule',now()-interval '2 days');
 PERFORM pg_temp.b2_run('ghl_history_load','cron:ghl-history-schedule',now()-interval '1 day');
 l:=public.context_ghl_history_day_limit(false);
 IF l->>'basis'<>'boost' OR l->'daily_job_limit'<>'250'
  OR (l->>'boost_started_at')::timestamptz<>(SELECT started_at FROM public.context_capture_runs WHERE id=boost)
  OR (l->>'boost_until')::timestamptz<>(SELECT started_at+interval '7 days' FROM public.context_capture_runs WHERE id=boost)
 THEN RAISE EXCEPTION 'b2 boost %',l; END IF;
 -- A dry run and another source never start or end anything.
 PERFORM pg_temp.b2_run('ghl_history_load_dry','cron:ghl-history-schedule',now()-interval '20 days','ghl_rate_limited');
 PERFORM pg_temp.b2_run('ghl_message_reconcile','cron:ghl-history-schedule',now()-interval '1 hour','ghl_rate_limited');
 IF public.context_ghl_history_day_limit(false)->>'basis'<>'boost' THEN RAISE EXCEPTION 'b2 other sources moved the limit'; END IF;
 -- The first GHL rate limit since the boost began (a contact-level code counts too): 100 for good.
 PERFORM pg_temp.b2_run('ghl_history_load','cron:ghl-history-schedule',now()-interval '3 hours','contact_partial:ghl_rate_limited',0,'partial');
 l:=public.context_ghl_history_day_limit(true);
 IF l->>'basis'<>'rate_limited' OR l->'daily_job_limit'<>'100' OR l->>'rate_limited_at' IS NULL THEN RAISE EXCEPTION 'b2 rate limited %',l; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 2b. Seven days on, the boost ends by itself; a link run's rate limit also counts.
DO $$
DECLARE l jsonb;
BEGIN
 PERFORM pg_temp.b2_scope();
 PERFORM pg_temp.b2_run('ghl_history_link','cron:ghl-history-schedule',now()-interval '8 days');
 l:=public.context_ghl_history_day_limit(true);
 IF l->>'basis'<>'boost_ended' OR l->'daily_job_limit'<>'100' THEN RAISE EXCEPTION 'b2 boost ended %',l; END IF;
 DELETE FROM public.context_capture_runs WHERE source='ghl_history_link' AND started_at>now()-interval '9 days';
 PERFORM pg_temp.b2_run('ghl_history_link','cron:ghl-history-schedule',now()-interval '1 day');
 PERFORM pg_temp.b2_run('ghl_history_link','cron:ghl-history-schedule',now()-interval '2 hours','ghl_rate_limited');
 IF public.context_ghl_history_day_limit(false)->>'basis'<>'rate_limited' THEN RAISE EXCEPTION 'b2 link rate limit not counted'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 3. The quota.
DO $$
DECLARE r jsonb; d jsonb; run uuid; runs_before integer; ds timestamptz:=pg_temp.b2_day_start();
BEGIN
 PERFORM pg_temp.b2_scope();
 -- Nothing live with a contact: nothing due, and no run row is written.
 SELECT count(*) INTO runs_before FROM public.context_capture_runs WHERE source='ghl_history_load';
 r:=public.reserve_ghl_history_run(25,'b2-test');
 IF r->>'outcome'<>'nothing_due' OR jsonb_array_length(r#>'{due,contacts}')<>0 OR r ? 'run_id' THEN RAISE EXCEPTION 'b2 nothing due %',r; END IF;
 IF (SELECT count(*) FROM public.context_capture_runs WHERE source='ghl_history_load')<>runs_before THEN RAISE EXCEPTION 'b2 nothing due wrote a run row'; END IF;

 -- Five contacts: A (2 jobs) partial and attempted earlier today, B (1) never
 -- loaded, C (3) never loaded, D (1) partial from yesterday, E done.
 PERFORM pg_temp.b2_job('B2-A1','in_progress','b2ContactAaaaaa01');
 PERFORM pg_temp.b2_job('B2-A2','scheduled','b2ContactAaaaaa01');
 PERFORM pg_temp.b2_job('B2-B1','accepted','b2ContactBbbbbb01');
 PERFORM pg_temp.b2_job('B2-C1','accepted','b2ContactCcccccc1');
 PERFORM pg_temp.b2_job('B2-C2','accepted','b2ContactCcccccc1');
 PERFORM pg_temp.b2_job('B2-C3','accepted','b2ContactCcccccc1');
 PERFORM pg_temp.b2_job('B2-D1','accepted','b2ContactDdddddd1');
 PERFORM pg_temp.b2_job('B2-E1','accepted','b2ContactEeeeee01');
 PERFORM pg_temp.b2_contact('b2ContactAaaaaa01','partial',2,greatest(ds,now()-interval '1 minute'));
 PERFORM pg_temp.b2_contact('b2ContactDdddddd1','partial',1,ds-interval '2 hours');
 PERFORM pg_temp.b2_contact('b2ContactEeeeee01','done',1,ds-interval '3 days');
 -- The day so far: those ledger runs counted nothing; today 99 of 100 already charged.
 PERFORM pg_temp.b2_run('ghl_history_load','b2-test',greatest(ds,now()-interval '2 minutes'),NULL,99);
 d:=public.context_ghl_history_due(25);
 -- A was attempted today: free. D resumes from yesterday: one job, fits the last one.
 -- B and C wait: the day is spent.
 IF pg_temp.b2_mine(d)<>ARRAY['b2ContactAaaaaa01','b2ContactDdddddd1'] OR d->'jobs_charged'<>'1' OR d->'jobs_offered'<>'3'
  OR d->'daily_remaining'<>'1' OR d->'contacts_waiting'<>'2'
  OR (SELECT (x->>'charged_today')::boolean FROM jsonb_array_elements(d->'contacts') x WHERE x->>'contact_id'='b2ContactAaaaaa01') IS NOT TRUE
  OR (SELECT (x->>'charged_today')::boolean FROM jsonb_array_elements(d->'contacts') x WHERE x->>'contact_id'='b2ContactDdddddd1') IS NOT FALSE
 THEN RAISE EXCEPTION 'b2 charged once a day %',d; END IF;
 -- The reservation counts what the contacts charge (1), not every job offered (3).
 r:=public.reserve_ghl_history_run(25,'b2-test');
 run:=(r->>'run_id')::uuid;
 IF r->>'outcome'<>'reserved' OR (SELECT (counts->>'jobs_covered')::integer FROM public.context_capture_runs WHERE id=run)<>1
 THEN RAISE EXCEPTION 'b2 reservation %',r; END IF;
 -- The first run that knows the limit records the switch from M4's base.
 IF r#>'{cursor,limit,daily_job_limit}'<>'100' OR r#>>'{cursor,limit,basis}'<>'base'
  OR (SELECT cursor FROM public.context_capture_runs WHERE id=run)<>r->'cursor'
 THEN RAISE EXCEPTION 'b2 limit on the run row %',r; END IF;
 -- The worker reaches only A, then times out: it charges what it attempted
 -- (A: nothing, attempted today already) and gives D's job back.
 PERFORM public.record_ghl_history_contact(jsonb_build_object('contact_id','b2ContactAaaaaa01','run_id',run,'status','done','jobs',2,'actor','b2-test'));
 PERFORM public.record_capture_run(jsonb_build_object('run_id',run,'source','ghl_history_load','status','partial',
  'counts',jsonb_build_object('jobs_covered',0),'cursor',r->'cursor'));
 d:=public.context_ghl_history_due(25);
 IF d->'daily_remaining'<>'1' OR pg_temp.b2_mine(d)<>ARRAY['b2ContactDdddddd1'] THEN RAISE EXCEPTION 'b2 refund %',d; END IF;
 -- A contact with more live jobs than the whole day is never offered.
 PERFORM pg_temp.b2_job('B2-F'||g,'accepted','b2ContactFfffff01') FROM generate_series(1,101) g;
 d:=public.context_ghl_history_due(250);
 IF d->'contacts_over_daily_limit'<>'1' OR 'b2ContactFfffff01'=ANY(pg_temp.b2_mine(d)) THEN RAISE EXCEPTION 'b2 oversized %',d; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 3b. The scheduled actor's first reservation starts the boost and records the
-- switch; an abandoned run keeps only the jobs of the contacts it recorded.
DO $$
DECLARE r jsonb; r2 jsonb; run uuid;
BEGIN
 PERFORM pg_temp.b2_scope();
 PERFORM pg_temp.b2_job('B2-G1','in_progress','b2ContactGggggg01');
 PERFORM pg_temp.b2_job('B2-G2','in_progress','b2ContactGggggg01');
 PERFORM pg_temp.b2_job('B2-H1','accepted','b2ContactHhhhhh01');
 PERFORM pg_temp.b2_job('B2-I1','accepted','b2ContactIiiiii01');
 PERFORM pg_temp.b2_job('B2-I2','accepted','b2ContactIiiiii01');
 PERFORM pg_temp.b2_job('B2-I3','accepted','b2ContactIiiiii01');
 -- An earlier hand run carried no limit: the scheduled run switches base -> boost.
 PERFORM pg_temp.b2_run('ghl_history_load','operator',now()-interval '2 days');
 r:=public.reserve_ghl_history_run(25,'cron:ghl-history-schedule');
 run:=(r->>'run_id')::uuid;
 IF r->>'outcome'<>'reserved' OR r#>'{due,daily_job_limit}'<>'250' OR r#>'{due,jobs_charged}'<>'6'
  OR r#>'{cursor,limit_switch}'<>'{"from":{"basis":"base","daily_job_limit":100},"to":{"basis":"boost","daily_job_limit":250}}'::jsonb
  OR (SELECT cursor->>'actor' FROM public.context_capture_runs WHERE id=run)<>'cron:ghl-history-schedule'
 THEN RAISE EXCEPTION 'b2 first scheduled reservation %',r; END IF;
 IF public.context_ghl_history_day_limit(false)->>'basis'<>'boost' THEN RAISE EXCEPTION 'b2 the boost did not start'; END IF;
 -- The worker records G (2 jobs) and dies.
 PERFORM public.record_ghl_history_contact(jsonb_build_object('contact_id','b2ContactGggggg01','run_id',run,'status','partial','jobs',2,'actor','b2-test',
  'resume',jsonb_build_object('v',1,'done','[]'::jsonb,'conversation_id','b2Conv0001','last_message_id','b2Msg0001')));
 UPDATE public.context_capture_runs SET updated_at=now()-interval '11 minutes' WHERE id=run;
 r2:=public.reserve_ghl_history_run(25,'cron:ghl-history-schedule');
 IF (SELECT status<>'failed' OR error_code<>'run_abandoned' OR (counts->>'jobs_covered')::integer<>2
   OR cursor->'quota'<>'{"jobs_reserved":6,"jobs_charged":2,"jobs_refunded":4,"abandoned":true}'::jsonb
   OR cursor->>'actor'<>'cron:ghl-history-schedule'
  FROM public.context_capture_runs WHERE id=run) THEN RAISE EXCEPTION 'b2 abandoned run %',(SELECT row_to_json(c) FROM public.context_capture_runs c WHERE id=run); END IF;
 -- The next reservation: 2 charged today; G is free (attempted today), H and I charge 4.
 IF r2->>'outcome'<>'reserved' OR r2#>'{due,jobs_counted_today}'<>'2' OR r2#>'{due,jobs_charged}'<>'4' OR r2#>'{due,jobs_offered}'<>'6'
  OR r2#>'{cursor,limit_switch}' IS NOT NULL
 THEN RAISE EXCEPTION 'b2 reservation after abandon %',r2; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 4. The link attempt record and the jobs due a link try.
DO $$
DECLARE run uuid; dry uuid; load uuid; j_new uuid; j_failed_today uuid; j_failed_old uuid; j_none_recent uuid; j_none_old uuid; j_contact uuid;
 o jsonb; got uuid[]; ds timestamptz:=pg_temp.b2_day_start();
BEGIN
 PERFORM pg_temp.b2_scope();
 run:=pg_temp.b2_run('ghl_history_link','b2-test',now());
 dry:=pg_temp.b2_run('ghl_history_link_dry','b2-test',now());
 load:=pg_temp.b2_run('ghl_history_load','b2-test',now());
 j_new:=pg_temp.b2_job('B2-L-NEW','accepted',NULL);
 UPDATE public.jobs SET client_phone='0412 999 001' WHERE id=j_new;
 j_failed_today:=pg_temp.b2_job('B2-L-FT','accepted',NULL);
 j_failed_old:=pg_temp.b2_job('B2-L-FO','accepted',NULL);
 j_none_recent:=pg_temp.b2_job('B2-L-NR','accepted',NULL);
 j_none_old:=pg_temp.b2_job('B2-L-NO','scheduled','  ');
 j_contact:=pg_temp.b2_job('B2-L-HAS','accepted','b2ContactJjjjjj01');
 -- The writer's refusals.
 BEGIN PERFORM public.record_ghl_link_attempt(jsonb_build_object('job_id',j_new,'run_id',dry,'verdict','none','reason','not_in_ghl','actor','b2-test'));
  RAISE EXCEPTION 'b2 a dry run wrote an attempt';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'history_link_attempt_run_invalid' THEN RAISE; END IF; END;
 BEGIN PERFORM public.record_ghl_link_attempt(jsonb_build_object('job_id',j_new,'run_id',load,'verdict','none','reason','not_in_ghl','actor','b2-test'));
  RAISE EXCEPTION 'b2 a load run wrote an attempt';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'history_link_attempt_run_invalid' THEN RAISE; END IF; END;
 BEGIN PERFORM public.record_ghl_link_attempt(jsonb_build_object('job_id',j_new,'run_id',run,'verdict','maybe','reason','x','actor','b2-test'));
  RAISE EXCEPTION 'b2 a bad verdict was taken';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'history_link_attempt_verdict_invalid' THEN RAISE; END IF; END;
 BEGIN PERFORM public.record_ghl_link_attempt(jsonb_build_object('job_id',j_new,'run_id',run,'verdict','none','reason','+61412999001','actor','b2-test'));
  RAISE EXCEPTION 'b2 a key was taken as a reason';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'history_link_attempt_reason_invalid' THEN RAISE; END IF; END;
 BEGIN PERFORM public.record_ghl_link_attempt(jsonb_build_object('job_id',j_new,'run_id',run,'verdict','none','reason','x','actor','b2-test','phone_key','412999001'));
  RAISE EXCEPTION 'b2 an extra key was taken';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'history_link_attempt_invalid' THEN RAISE; END IF; END;
 -- Upsert: attempts counted, first attempt kept.
 o:=public.record_ghl_link_attempt(jsonb_build_object('job_id',j_failed_today,'run_id',run,'verdict','none','reason','not_in_ghl','actor','b2-test'));
 IF o->>'outcome'<>'created' THEN RAISE EXCEPTION 'b2 attempt %',o; END IF;
 o:=public.record_ghl_link_attempt(jsonb_build_object('job_id',j_failed_today,'run_id',run,'verdict','failed','reason','search_failed','actor','b2-test'));
 IF o->>'outcome'<>'updated' OR o->'attempts'<>'2' OR o->>'verdict'<>'failed' THEN RAISE EXCEPTION 'b2 attempt upsert %',o; END IF;
 PERFORM public.record_ghl_link_attempt(jsonb_build_object('job_id',j_failed_old,'run_id',run,'verdict','failed','reason','search_failed','actor','b2-test'));
 PERFORM public.record_ghl_link_attempt(jsonb_build_object('job_id',j_none_recent,'run_id',run,'verdict','none','reason','no_keys','actor','b2-test'));
 PERFORM public.record_ghl_link_attempt(jsonb_build_object('job_id',j_none_old,'run_id',run,'verdict','ambiguous','reason','several_contacts','actor','b2-test'));
 UPDATE public.context_ghl_history_link_attempts SET last_attempt_at=ds-interval '1 hour' WHERE job_id=j_failed_old;
 UPDATE public.context_ghl_history_link_attempts SET last_attempt_at=now()-interval '3 days' WHERE job_id=j_none_recent;
 UPDATE public.context_ghl_history_link_attempts SET last_attempt_at=now()-interval '8 days' WHERE job_id=j_none_old;
 -- Due: never tried first, then the failed try from before today and the
 -- ambiguous verdict older than 7 days; never a job that has a contact.
 SELECT array_agg(d.job_id) INTO got FROM public.context_ghl_history_link_due(100) d;
 IF got[1]<>j_new OR cardinality(got)<>3 OR NOT got@>ARRAY[j_failed_old,j_none_old] THEN
  RAISE EXCEPTION 'b2 link due %',(SELECT array_agg(job_number) FROM public.jobs WHERE id=ANY(got));
 END IF;
 -- The B0 keys come with the job, as on M4's candidates page.
 IF (SELECT phone_key FROM public.context_ghl_history_link_due(100) WHERE job_id=j_new)<>public.context_phone_key('0412 999 001')
 THEN RAISE EXCEPTION 'b2 link due keys'; END IF;
 IF (SELECT count(*) FROM public.context_ghl_history_link_due(1))<>1 THEN RAISE EXCEPTION 'b2 link due limit'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 5. The reading hand-over.
DO $$
DECLARE run uuid; j_never uuid; j_quote uuid; j_listed uuid; j_read uuid; j_empty uuid; j_closed uuid; r jsonb; ev uuid; before text;
BEGIN
 PERFORM pg_temp.b2_scope();
 j_never:=pg_temp.b2_job('B2-R-NEVER','in_progress','b2ContactRrrrrr01');
 j_quote:=pg_temp.b2_job('B2-R-QUOTE','quoted','b2ContactRrrrrr01',now()-interval '5 days');
 j_listed:=pg_temp.b2_job('B2-R-LISTED','accepted','b2ContactSsssss01');
 j_read:=pg_temp.b2_job('B2-R-READ','scheduled','b2ContactTtttt001');
 j_empty:=pg_temp.b2_job('B2-R-EMPTY','accepted','b2ContactUuuuuu01');
 -- A closed job on the same contact: not live, never handed over.
 j_closed:=pg_temp.b2_job('B2-R-CLOSED','complete','b2ContactRrrrrr01');
 PERFORM pg_temp.b2_ev(j_never,'history one'); PERFORM pg_temp.b2_ev(j_never,'history two');
 PERFORM pg_temp.b2_ev(j_quote,'quote history');
 PERFORM pg_temp.b2_ev(j_listed,'listed history');
 PERFORM pg_temp.b2_ev(j_closed,'closed history');
 ev:=pg_temp.b2_ev(j_read,'read long ago',interval '20 days');
 -- j_read was read (a done extraction run with receipts) and its catch-up row is done.
 INSERT INTO public.context_extraction_runs(job_id,run_date,phase,status,run_seq,started_at,finished_at)
  VALUES(j_read,(now() AT TIME ZONE 'Australia/Perth')::date-10,'extraction','done',1,now()-interval '10 days',now()-interval '10 days') RETURNING id INTO run;
 INSERT INTO public.context_extraction_event_receipts(event_id,job_id,run_id) VALUES(ev,j_read,run);
 INSERT INTO public.context_catchup_jobs(job_id,job_number,priority,done_at,done_run_id) VALUES(j_read,'B2-R-READ',2,now()-interval '9 days',run);
 PERFORM pg_temp.b2_ev(j_read,'new history row');
 -- j_listed already waits on the list at tier 5: raised, never lowered.
 INSERT INTO public.context_catchup_jobs(job_id,job_number,priority,mode,scope) VALUES(j_listed,'B2-R-LISTED',5,'unread','backlog');
 PERFORM pg_temp.b2_contact('b2ContactRrrrrr01','done',3,now()-interval '1 hour');
 PERFORM pg_temp.b2_contact('b2ContactSsssss01','done',1,now()-interval '1 hour');
 PERFORM pg_temp.b2_contact('b2ContactTtttt001','done',1,now()-interval '1 hour');
 PERFORM pg_temp.b2_contact('b2ContactUuuuuu01','done',1,now()-interval '1 hour');
 -- A partial contact is not handed over.
 PERFORM pg_temp.b2_job('B2-R-PART','accepted','b2ContactVvvvvv01');
 PERFORM pg_temp.b2_contact('b2ContactVvvvvv01','partial',1,now()-interval '1 hour');

 -- Dry run: the plan, nothing written.
 SELECT coalesce(md5(string_agg(to_jsonb(c)::text,',' ORDER BY c.job_id)),'empty') INTO before FROM public.context_catchup_jobs c;
 r:=public.context_ghl_history_request_reads(true,200);
 IF r->>'dry_run'<>'true' OR r->'contacts_handled'<>'4' OR r->'jobs_considered'<>'5' OR r->'written'<>'null'
  OR (SELECT coalesce(md5(string_agg(to_jsonb(c)::text,',' ORDER BY c.job_id)),'empty') FROM public.context_catchup_jobs c)<>before
  OR EXISTS(SELECT 1 FROM public.context_ghl_history_contacts WHERE reads_requested_at IS NOT NULL)
 THEN RAISE EXCEPTION 'b2 dry run %',r; END IF;
 IF (SELECT jsonb_object_agg(x->>'job_number',(x->>'action')||'/'||(x->>'mode')||'/'||(x->>'tier')) FROM jsonb_array_elements(r->'jobs') x)
  <>'{"B2-R-NEVER":"add/full/2","B2-R-QUOTE":"add/full/3","B2-R-LISTED":"raise/unread/2","B2-R-READ":"reopen/unread/2","B2-R-EMPTY":"no_evidence/full/2"}'::jsonb
 THEN RAISE EXCEPTION 'b2 plan %',r->'jobs'; END IF;

 -- Real: the list gains, re-opens and raises exactly that; the contacts are stamped.
 r:=public.context_ghl_history_request_reads(false,200);
 IF r->'written'<>'{"added":2,"reopened":1,"priority_raised":1,"contacts_stamped":4}'::jsonb OR r->'jobs_listed'<>'4'
 THEN RAISE EXCEPTION 'b2 written %',r; END IF;
 IF (SELECT array_agg(job_number||':'||priority||':'||mode||':'||scope||':'||(done_at IS NULL) ORDER BY job_number) FROM public.context_catchup_jobs
   WHERE job_number LIKE 'B2-R-%')
  <>ARRAY['B2-R-LISTED:2:unread:backlog:true','B2-R-NEVER:2:full:backlog:true','B2-R-QUOTE:3:full:backlog:true','B2-R-READ:2:unread:backlog:true']
 THEN RAISE EXCEPTION 'b2 list %',(SELECT array_agg(to_jsonb(c)) FROM public.context_catchup_jobs c WHERE job_number LIKE 'B2-R-%'); END IF;
 -- The reader now sees the rows: the pending read covers them.
 IF (SELECT count(*) FROM public.context_catchup_pending_rows(ARRAY[j_never]))<>2
  OR (SELECT count(*) FROM public.context_catchup_pending_rows(ARRAY[j_read]))<>1
 THEN RAISE EXCEPTION 'b2 pending rows'; END IF;
 -- Handed over once: a second call does nothing.
 r:=public.context_ghl_history_request_reads(false,200);
 IF r->'contacts_handled'<>'0' OR r->'jobs_considered'<>'0' THEN RAISE EXCEPTION 'b2 second hand-over %',r; END IF;
 -- A contact that completes again later (a reopened load) is handed over again.
 UPDATE public.context_ghl_history_contacts SET completed_at=now()+interval '1 second' WHERE contact_id='b2ContactUuuuuu01';
 PERFORM pg_temp.b2_ev(j_empty,'late history');
 r:=public.context_ghl_history_request_reads(false,200);
 IF r->'contacts_handled'<>'1' OR r#>'{written,added}'<>'1' THEN RAISE EXCEPTION 'b2 re-completed contact %',r; END IF;
 -- The limit bounds the contacts one call takes.
 BEGIN PERFORM public.context_ghl_history_request_reads(true,0); RAISE EXCEPTION 'b2 limit 0 taken';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'history_reads_limit_invalid%' THEN RAISE; END IF; END;
END $$;
ROLLBACK;

BEGIN;
-- 6. The after-check: jobs done counts completed histories plus tried jobs with no contact.
DO $$
DECLARE run uuid; p jsonb; j uuid;
BEGIN
 PERFORM pg_temp.b2_scope();
 PERFORM pg_temp.b2_job('B2-P-DONE','accepted','b2ContactPppppp01');
 PERFORM pg_temp.b2_job('B2-P-PART','accepted','b2ContactPppppp02');
 PERFORM pg_temp.b2_job('B2-P-NEW','accepted','b2ContactPppppp03');
 PERFORM pg_temp.b2_job('B2-P-BAD','accepted','bad id!');
 PERFORM pg_temp.b2_job('B2-P-UNTRIED','accepted',NULL);
 j:=pg_temp.b2_job('B2-P-TRIED','accepted',NULL);
 PERFORM pg_temp.b2_contact('b2ContactPppppp01','done',1,now()-interval '1 hour');
 PERFORM pg_temp.b2_contact('b2ContactPppppp02','partial',1,now()-interval '1 hour');
 run:=pg_temp.b2_run('ghl_history_link','b2-test',now());
 PERFORM public.record_ghl_link_attempt(jsonb_build_object('job_id',j,'run_id',run,'verdict','none','reason','not_in_ghl','actor','b2-test'));
 p:=public.context_ghl_history_progress();
 IF p->'live_jobs'<>'6' OR p->'jobs_done'<>'2' OR p->'with_contact'<>'4' OR p->'history_done'<>'1' OR p->'history_partial'<>'1'
  OR p->'history_not_started'<>'1' OR p->'invalid_contact_id'<>'1' OR p->'no_contact'<>'2' OR p->'no_contact_tried'<>'1'
  OR p->'no_contact_untried'<>'1' OR p->'contacts_reads_pending'<>'1' OR p#>>'{limit,basis}'<>'base'
 THEN RAISE EXCEPTION 'b2 progress %',p; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 7. The schedule: gated by the live-texts flag and the attribution lane, made
-- gated on a pg_cron stand-in, idempotent on re-apply, owned by the capture lane.
DO $$
DECLARE attempted boolean:=false;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.automation_switch_cron_lanes() WHERE cron_jobname='ghl-history-schedule' AND lane='capture')
 THEN RAISE EXCEPTION 'b2 lane list %',(SELECT array_agg(to_jsonb(l)) FROM public.automation_switch_cron_lanes() l); END IF;
 -- Flag missing or off: no call (no pg_net here, so a call shows as an error).
 DELETE FROM public.feature_flags WHERE flag_name='ghl_message_capture_v2';
 PERFORM public.trigger_ghl_history_schedule();
 INSERT INTO public.feature_flags(flag_name,enabled) VALUES('ghl_message_capture_v2',false);
 PERFORM public.trigger_ghl_history_schedule();
 UPDATE public.feature_flags SET enabled=true WHERE flag_name='ghl_message_capture_v2';
 UPDATE public.automation_switches SET attribution=false WHERE id=1;
 PERFORM public.trigger_ghl_history_schedule();
 UPDATE public.automation_switches SET attribution=true WHERE id=1;
 BEGIN
  PERFORM public.trigger_ghl_history_schedule();
 EXCEPTION WHEN OTHERS THEN attempted:=true;
 END;
 IF NOT attempted THEN RAISE EXCEPTION 'b2 the cron caller must post while the flag and lane are on'; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY,schedule text NOT NULL,command text NOT NULL,active boolean NOT NULL DEFAULT true,jobname text);
CREATE FUNCTION cron.schedule(job_name text,schedule text,command text) RETURNS bigint LANGUAGE sql AS $$
 INSERT INTO cron.job(jobname,schedule,command) VALUES(job_name,schedule,command) RETURNING jobid
$$;
CREATE FUNCTION cron.alter_job(job_id bigint,schedule text DEFAULT NULL,command text DEFAULT NULL,database text DEFAULT NULL,
 username text DEFAULT NULL,active boolean DEFAULT NULL) RETURNS void LANGUAGE sql AS $$
 UPDATE cron.job SET command=coalesce(alter_job.command,job.command) WHERE jobid=job_id
$$;
\ir ../../../migrations/20261005190000_context_ghl_history_schedule.sql
\ir ../../../migrations/20261005190000_context_ghl_history_schedule.sql
DO $$
DECLARE w record;
BEGIN
 IF (SELECT count(*) FROM cron.job WHERE jobname='ghl-history-schedule')<>1 THEN RAISE EXCEPTION 'b2 re-apply scheduled twice'; END IF;
 IF (SELECT schedule||' '||command FROM cron.job WHERE jobname='ghl-history-schedule')
  <>'7-59/15 * * * * SELECT public.trigger_ghl_history_schedule() WHERE public.automation_lane_enabled(''capture'')'
 THEN RAISE EXCEPTION 'b2 job %',(SELECT jsonb_agg(row_to_json(j)) FROM cron.job j); END IF;
 SELECT * INTO w FROM public.automation_switch_wrap_cron_jobs() x WHERE x.cron_jobname='ghl-history-schedule';
 IF w.outcome<>'already_wrapped' THEN RAISE EXCEPTION 'b2 wrap %',row_to_json(w); END IF;
END $$;
ROLLBACK;
