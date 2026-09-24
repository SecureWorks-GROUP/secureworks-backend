-- Catch-up contract. Every fixture write is rolled back. Ids, job numbers and
-- text are synthetic. Each transaction moves live_since ten days back
-- (pg_temp.cu_policy), so a row captured 12 days ago is pre-go-live history
-- that K1 alone never reads, and a row captured 20 minutes ago is live.

CREATE TABLE pg_temp.cu_base_policy AS SELECT public.context_cadence_policy() AS p;

CREATE FUNCTION pg_temp.cu_policy(p_over jsonb DEFAULT '{}'::jsonb) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 EXECUTE format('CREATE OR REPLACE FUNCTION public.context_cadence_policy() RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $b$ SELECT %L::jsonb $b$',
  (SELECT p FROM pg_temp.cu_base_policy)||jsonb_build_object('live_since',now()-interval '10 days')||p_over);
END $$;

CREATE FUNCTION pg_temp.cu_job(p_number text,p_meta jsonb DEFAULT '{}'::jsonb,p_status text DEFAULT 'scheduled',p_type text DEFAULT 'fencing',p_quoted_ago interval DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,metadata,created_at,quoted_at)
  VALUES(j,'00000000-0000-0000-0000-000000000001',p_status,p_type,p_number,p_meta,now()-interval '60 days',now()-p_quoted_ago);
 RETURN j;
END $$;

-- Put a job on the list directly (the rule that picks jobs is section 3).
CREATE FUNCTION pg_temp.cu_list(p_job uuid,p_priority integer) RETURNS void LANGUAGE sql AS $$
 INSERT INTO public.context_catchup_jobs(job_id,job_number,priority) SELECT id,job_number,p_priority FROM public.jobs WHERE id=p_job $$;

-- A done extraction run that finished p_ago before now, with receipts for
-- every row on the job at that moment.
CREATE FUNCTION pg_temp.cu_read(p_job uuid,p_ago interval) RETURNS void LANGUAGE plpgsql AS $$
DECLARE run uuid;
BEGIN
 INSERT INTO public.context_extraction_runs(job_id,run_date,phase,status,run_seq,started_at,finished_at)
  VALUES(p_job,((now()-p_ago) AT TIME ZONE 'Australia/Perth')::date,'extraction','done',
   coalesce((SELECT max(run_seq) FROM public.context_extraction_runs WHERE job_id=p_job AND run_date=((now()-p_ago) AT TIME ZONE 'Australia/Perth')::date),0)+1,
   now()-p_ago,now()-p_ago) RETURNING id INTO run;
 INSERT INTO public.context_extraction_event_receipts(event_id,job_id,run_id)
  SELECT e.id,p_job,run FROM public.business_events e WHERE e.job_id=p_job ON CONFLICT DO NOTHING;
END $$;

-- A row through the real trigger, then moved p_ago back. p_history strips
-- written_as, as on every row captured before K1 went live.
CREATE FUNCTION pg_temp.cu_ev(p_job uuid,p_type text,p_body text,p_ago interval,p_history boolean DEFAULT true) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE new_id uuid;
BEGIN
 INSERT INTO public.business_events(job_id,match_method,direction,event_type,source,payload,occurred_at,event_at)
  VALUES(p_job,'direct_job_id','inbound',p_type,'catchup_contract',jsonb_build_object('body',p_body),now()-p_ago,now()-p_ago)
  RETURNING id INTO new_id;
 UPDATE public.business_events SET context_captured_at=now()-p_ago,
  attributed_at=CASE WHEN attributed_at IS NULL THEN NULL ELSE now()-p_ago END,
  metadata=CASE WHEN p_history THEN coalesce(metadata,'{}'::jsonb)-'written_as' ELSE metadata END WHERE id=new_id;
 RETURN new_id;
END $$;

CREATE FUNCTION pg_temp.cu_due(p_job uuid) RETURNS boolean LANGUAGE sql AS $$
 SELECT EXISTS(SELECT 1 FROM public.context_extraction_candidates(400) c WHERE c.job_id=p_job) $$;
CREATE FUNCTION pg_temp.cu_pool(p_job uuid) RETURNS boolean LANGUAGE sql AS $$
 SELECT EXISTS(SELECT 1 FROM public.context_cadence_pool() p WHERE p=p_job) $$;
CREATE FUNCTION pg_temp.cu_today() RETURNS date LANGUAGE sql AS $$ SELECT (now() AT TIME ZONE 'Australia/Perth')::date $$;

-- 1. Grants and shape: the list and every new or replaced function are
-- service role only with a fixed search_path; the table has row security.
DO $$
DECLARE f regprocedure;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_catchup_request(boolean)','public.context_jobs_cadence(uuid[])','public.context_cadence_pool()',
  'public.context_extraction_candidates(integer)','public.context_cadence_status()']::regprocedure[] LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') OR NOT has_function_privilege('service_role',f,'EXECUTE')
  THEN RAISE EXCEPTION 'catch-up grants on %',f; END IF;
  IF (SELECT proconfig FROM pg_proc WHERE oid=f) IS NULL THEN RAISE EXCEPTION 'catch-up function without fixed search_path %',f; END IF;
 END LOOP;
 IF has_function_privilege('anon','public.context_catchup_mark_done()','EXECUTE') OR has_function_privilege('authenticated','public.context_catchup_mark_done()','EXECUTE')
 THEN RAISE EXCEPTION 'catch-up trigger function executable by the public roles'; END IF;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.context_catchup_jobs'::regclass)
  OR has_table_privilege('anon','public.context_catchup_jobs','SELECT') OR has_table_privilege('authenticated','public.context_catchup_jobs','SELECT')
  OR has_table_privilege('authenticated','public.context_catchup_jobs','INSERT') OR NOT has_table_privilege('service_role','public.context_catchup_jobs','SELECT')
 THEN RAISE EXCEPTION 'catch-up table access wrong'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.context_extraction_runs'::regclass AND tgname='context_catchup_mark_done' AND NOT tgisinternal)
 THEN RAISE EXCEPTION 'catch-up done trigger missing'; END IF;
END $$;

-- 2. Caps are unchanged: the policy is K1's, every number and live_since
-- included (the migration never replaces the policy).
DO $$
DECLARE p jsonb:=public.context_cadence_policy();
BEGIN
 IF p->>'version'<>'k1-cadence-policy-v1' OR (p->>'model_call_cap')::int<>400 OR (p->>'morning_cap')::int<>300 OR p->>'morning_until'<>'12:00'
  OR (p->>'tick_max_jobs')::int<>10 OR (p->>'runs_per_job_day')::int<>6 OR (p->>'inbound_extra_runs')::int<>4
  OR (p->>'quiet_min')::int<>15 OR (p->>'ceiling_min')::int<>60 OR (p->>'cooldown_min')::int<>30
 THEN RAISE EXCEPTION 'catch-up policy numbers moved %',p; END IF;
 IF (p->>'live_since')::timestamptz IS DISTINCT FROM (SELECT (x.p->>'live_since')::timestamptz FROM public.catchup_contract_policy_preimage x)
 THEN RAISE EXCEPTION 'catch-up moved live_since %',p; END IF;
END $$;

-- 3. The writer picks by rule: live jobs (accepted, scheduled, in progress,
-- or quoted in the last 60 days) with readable evidence and no done read
-- since live_since; priority 1 when something is unread. Dry run is the
-- default and writes nothing; a real run writes exactly the dry run's jobs,
-- never lowers a priority, and leaves a done job done.
BEGIN;
DO $$
DECLARE a uuid; b uuid; c uuid; i uuid; f uuid; h uuid; late uuid; r jsonb; w jsonb; mine jsonb; want jsonb;
BEGIN
 PERFORM pg_temp.cu_policy();
 DELETE FROM public.context_catchup_jobs;
 -- a: scheduled, never read, old unread text -> 1, active.
 a:=pg_temp.cu_job('CU-A'); PERFORM pg_temp.cu_ev(a,'client.sms_in','Old text','12 days');
 -- b: make-safe in progress, read before go-live, nothing unread -> 2, makesafe.
 b:=pg_temp.cu_job('CU-B','{}','in_progress','makesafe'); PERFORM pg_temp.cu_ev(b,'client.sms_in','Old email','20 days');
 PERFORM pg_temp.cu_read(b,'15 days');
 -- c: quoted 10 days ago, never read, unread -> 1, quote.
 c:=pg_temp.cu_job('CU-C','{}','quoted','fencing','10 days'); PERFORM pg_temp.cu_ev(c,'quote.sent','Quote Q-9 sent for 30 m of fence.','11 days');
 -- i: accepted, read before go-live, newer text since -> 1, active.
 i:=pg_temp.cu_job('CU-I','{}','accepted'); PERFORM pg_temp.cu_ev(i,'client.sms_in','Older text','20 days');
 PERFORM pg_temp.cu_read(i,'15 days'); PERFORM pg_temp.cu_ev(i,'client.sms_in','Newer text','12 days');
 -- Left out: quoted 90 days ago; no evidence (only a wordless row); read since
 -- live_since; not live; holding job.
 PERFORM pg_temp.cu_ev(pg_temp.cu_job('CU-OLDQUOTE','{}','quoted','fencing','90 days'),'client.sms_in','Old text','12 days');
 PERFORM pg_temp.cu_ev(pg_temp.cu_job('CU-EMPTY'),'job.status_changed','','12 days');
 f:=pg_temp.cu_job('CU-FRESH'); PERFORM pg_temp.cu_ev(f,'client.sms_in','Old text','12 days'); PERFORM pg_temp.cu_read(f,'2 days');
 PERFORM pg_temp.cu_ev(pg_temp.cu_job('CU-DONEJOB','{}','completed'),'client.sms_in','Old text','12 days');
 h:=pg_temp.cu_job('CU-HELD','{"do_not_schedule":true}'); PERFORM pg_temp.cu_ev(h,'client.sms_in','Old text','12 days');
 IF (SELECT attribution_status FROM public.business_events WHERE job_id=(SELECT id FROM public.jobs WHERE job_number='CU-EMPTY'))<>'empty'
 THEN RAISE EXCEPTION 'catch-up fixture: wordless row has words'; END IF;

 r:=public.context_catchup_request();
 IF (r->>'dry_run')::boolean IS DISTINCT FROM true OR r->'written' IS DISTINCT FROM 'null'::jsonb OR EXISTS(SELECT 1 FROM public.context_catchup_jobs)
 THEN RAISE EXCEPTION 'catch-up dry run wrote %',r; END IF;
 SELECT jsonb_object_agg(x->>'job_number',jsonb_build_array((x->>'priority')::int,x->>'group')) INTO mine
  FROM jsonb_array_elements(r->'jobs') x WHERE x->>'job_number' LIKE 'CU-%';
 want:='{"CU-A":[1,"active"],"CU-B":[2,"makesafe"],"CU-C":[1,"quote"],"CU-I":[1,"active"]}';
 IF mine IS DISTINCT FROM want THEN RAISE EXCEPTION 'catch-up picked % want %',mine,want; END IF;
 IF (r->>'candidates')::int<>jsonb_array_length(r->'jobs')
  OR (r->'by_priority'->>'1')::int+(r->'by_priority'->>'2')::int<>(r->>'candidates')::int
  OR (SELECT sum((v->>'total')::int) FROM jsonb_each(r->'by_group') AS g(k,v))<>(r->>'candidates')::int
  OR (r->'by_group'->'makesafe'->>'2')::int<1 OR (r->'by_group'->'quote'->>'1')::int<1 OR (r->'by_group'->'active'->>'1')::int<2
  OR (r->'excluded'->>'holding_job')::int<1 OR (r->'excluded'->>'no_evidence')::int<1 OR (r->'excluded'->>'read_since_live')::int<1
 THEN RAISE EXCEPTION 'catch-up counts %',r; END IF;

 w:=public.context_catchup_request(false);
 IF (w->'written'->>'added')::int<>(r->>'candidates')::int OR (SELECT count(*) FROM public.context_catchup_jobs)<>(r->>'candidates')::int
  OR (SELECT priority FROM public.context_catchup_jobs WHERE job_id=b)<>2 OR (SELECT priority FROM public.context_catchup_jobs WHERE job_id=a)<>1
  OR (SELECT job_number FROM public.context_catchup_jobs WHERE job_id=c)<>'CU-C'
  OR (public.context_cadence_status()->'catchup'->>'requested')::int<>(r->>'candidates')::int
 THEN RAISE EXCEPTION 'catch-up write %',w; END IF;
 -- b gains unread evidence: raised to 1. a is done: stays done. c and i stay as listed.
 PERFORM pg_temp.cu_ev(b,'client.sms_in','Another old text','11 days');
 UPDATE public.context_catchup_jobs SET done_at=now(),done_run_id=gen_random_uuid() WHERE job_id=a;
 DELETE FROM public.context_extraction_event_receipts WHERE job_id=b;
 w:=public.context_catchup_request(false);
 IF (w->'written'->>'added')::int<>0 OR (w->'written'->>'priority_raised')::int<>1 OR (w->'written'->>'already_done')::int<>1 OR (w->'written'->>'already_listed')::int<2
  OR (SELECT priority FROM public.context_catchup_jobs WHERE job_id=b)<>1 OR (SELECT done_at FROM public.context_catchup_jobs WHERE job_id=a) IS NULL
 THEN RAISE EXCEPTION 'catch-up second write %',w; END IF;
END $$;
ROLLBACK;

-- 4. The rule. A listed job whose only unread evidence predates live_since is
-- due once; the same evidence on an unlisted job stays not due; a successful
-- run marks the listed job done and it is never due by catch-up again, even
-- with rows past its batch still unread.
BEGIN;
DO $$
DECLARE listed uuid; unlisted uuid; c jsonb; claim jsonb; ids uuid[]; st jsonb;
BEGIN
 PERFORM pg_temp.cu_policy();
 listed:=pg_temp.cu_job('CU-LISTED'); unlisted:=pg_temp.cu_job('CU-UNLISTED');
 PERFORM pg_temp.cu_ev(listed,'client.sms_in','Old message '||g,make_interval(days=>12,mins=>g)) FROM generate_series(1,30) g;
 PERFORM pg_temp.cu_ev(unlisted,'client.sms_in','Old message on another job','12 days');
 IF pg_temp.cu_due(listed) OR pg_temp.cu_due(unlisted) OR pg_temp.cu_pool(listed)
 THEN RAISE EXCEPTION 'catch-up fixture: history woke a job before listing'; END IF;
 PERFORM pg_temp.cu_list(listed,1);
 c:=public.context_job_cadence(listed);
 IF NOT pg_temp.cu_due(listed) OR NOT (c->>'due')::boolean OR NOT (c->>'catchup_only')::boolean OR (c->>'catchup_priority')::int<>1
  OR (c->>'waking_count')::int<>0 OR (c->>'unread_count')::int<>30
 THEN RAISE EXCEPTION 'catch-up listed job with old unread evidence not due %',c; END IF;
 IF pg_temp.cu_due(unlisted) OR pg_temp.cu_pool(unlisted) OR (public.context_job_cadence(unlisted)->>'due')::boolean
 THEN RAISE EXCEPTION 'catch-up unlisted job with old evidence became due %',public.context_job_cadence(unlisted); END IF;
 -- The heartbeat's ready_jobs is the candidates read, so it counts the job.
 IF public.context_ready_jobs_count(400)<>(SELECT count(*) FROM public.context_extraction_candidates(400)) THEN RAISE EXCEPTION 'catch-up ready count'; END IF;
 st:=public.context_cadence_status()->'catchup';
 IF (st->>'requested')::int<>1 OR (st->>'done')::int<>0 OR (st->>'remaining')::int<>1 OR (st->>'due_now')::int<>1
  OR (st->>'remaining_priority_1')::int<>1 OR (st->>'oldest_requested_at') IS NULL
 THEN RAISE EXCEPTION 'catch-up status before the run %',st; END IF;
 -- The normal claim and batch: 25 rows, newest first.
 claim:=public.claim_context_extraction_run(listed,pg_temp.cu_today(),'extraction');
 IF claim->>'outcome'<>'claimed' THEN RAISE EXCEPTION 'catch-up claim %',claim; END IF;
 SELECT array_agg(id) INTO ids FROM public.context_extraction_events(listed,25);
 IF cardinality(ids)<>25 THEN RAISE EXCEPTION 'catch-up batch size %',cardinality(ids); END IF;
 IF NOT public.finish_context_extraction_run((claim->'run'->>'id')::uuid,(claim->'run'->>'lease_token')::uuid,'done',ids,10,3,0,0,NULL,NULL)
 THEN RAISE EXCEPTION 'catch-up finish refused'; END IF;
 IF (SELECT done_run_id FROM public.context_catchup_jobs WHERE job_id=listed) IS DISTINCT FROM (claim->'run'->>'id')::uuid
 THEN RAISE EXCEPTION 'catch-up run did not mark the job done'; END IF;
 c:=public.context_job_cadence(listed);
 IF (c->>'unread_count')::int<>5 OR (c->>'due')::boolean OR c->>'next_due_at' IS NOT NULL OR c->>'catchup_priority' IS NOT NULL
  OR pg_temp.cu_pool(listed) OR pg_temp.cu_due(listed)
 THEN RAISE EXCEPTION 'catch-up done job still due %',c; END IF;
 -- Even after its cooldown, a done job stays quiet until live evidence lands.
 UPDATE public.context_extraction_runs SET started_at=now()-interval '2 hours',finished_at=now()-interval '2 hours' WHERE job_id=listed;
 IF pg_temp.cu_due(listed) THEN RAISE EXCEPTION 'catch-up done job due again after cooldown'; END IF;
 st:=public.context_cadence_status()->'catchup';
 IF (st->>'done')::int<>1 OR (st->>'remaining')::int<>0 OR (st->>'oldest_requested_at') IS NOT NULL OR (st->>'last_done_at') IS NULL
 THEN RAISE EXCEPTION 'catch-up status after the run %',st; END IF;
 -- Live evidence still wakes it the K1 way.
 PERFORM pg_temp.cu_ev(listed,'client.sms_in','New message','20 minutes',false);
 IF NOT pg_temp.cu_due(listed) OR (public.context_job_cadence(listed)->>'catchup_only')::boolean
 THEN RAISE EXCEPTION 'catch-up done job lost the live rule %',public.context_job_cadence(listed); END IF;
END $$;
ROLLBACK;

-- 5. Order: jobs due on live evidence first in K1's order, then catch-up
-- priority 1, then priority 2.
BEGIN;
DO $$
DECLARE p2 uuid; p1 uuid; live_job uuid; got uuid[];
BEGIN
 PERFORM pg_temp.cu_policy();
 p2:=pg_temp.cu_job('CU-P2'); p1:=pg_temp.cu_job('CU-P1'); live_job:=pg_temp.cu_job('CU-LIVE');
 PERFORM pg_temp.cu_ev(p2,'client.sms_in','Oldest history','20 days');
 PERFORM pg_temp.cu_ev(p1,'client.sms_in','Newer history','11 days');
 PERFORM pg_temp.cu_ev(live_job,'client.sms_in','Live message','20 minutes',false);
 PERFORM pg_temp.cu_list(p2,2);
 PERFORM pg_temp.cu_list(p1,1);
 SELECT array_agg(c.job_id ORDER BY c.ord) INTO got FROM public.context_extraction_candidates(400) WITH ORDINALITY c(job_id,ord)
  WHERE c.job_id IN (p2,p1,live_job);
 IF got IS DISTINCT FROM ARRAY[live_job,p1,p2] THEN RAISE EXCEPTION 'catch-up order %',got; END IF;
 -- The cap argument still bounds the read.
 IF (SELECT count(*) FROM public.context_extraction_candidates(2) c WHERE c.job_id IN (p2,p1,live_job))<>2 THEN RAISE EXCEPTION 'catch-up ignored the limit'; END IF;
END $$;
ROLLBACK;

-- 6. Caps and holds apply to a catch-up job exactly as to any other: daily run
-- limit, cooldown, retry wait, the morning reserve, the 400-call cap, a holding
-- job and the lane switch. A failed run does not mark it done.
BEGIN;
DO $$
DECLARE j uuid; c jsonb; claim jsonb; d date:=pg_temp.cu_today();
BEGIN
 PERFORM pg_temp.cu_policy();
 j:=pg_temp.cu_job('CU-CAPS');
 PERFORM pg_temp.cu_ev(j,'client.sms_in','Old message','12 days');
 PERFORM pg_temp.cu_list(j,1);
 IF NOT pg_temp.cu_due(j) THEN RAISE EXCEPTION 'catch-up caps fixture not due'; END IF;
 -- Failed run: retry wait, not done.
 claim:=public.claim_context_extraction_run(j,d,'extraction');
 PERFORM public.finish_context_extraction_run((claim->'run'->>'id')::uuid,(claim->'run'->>'lease_token')::uuid,'failed','{}',0,0,0,0,'timeout',now()+interval '30 minutes');
 c:=public.context_job_cadence(j);
 IF pg_temp.cu_due(j) OR c->>'blocked_reason'<>'retry_wait' OR (SELECT done_at FROM public.context_catchup_jobs WHERE job_id=j) IS NOT NULL
 THEN RAISE EXCEPTION 'catch-up failed run %',c; END IF;
 -- Cooldown: the retry time passed, but the run started 10 minutes ago.
 UPDATE public.context_extraction_runs SET retry_at=now()-interval '1 minute',started_at=now()-interval '10 minutes' WHERE job_id=j;
 IF pg_temp.cu_due(j) OR public.claim_context_extraction_run(j,d,'extraction')->>'outcome'<>'claimed' THEN RAISE EXCEPTION 'catch-up cooldown'; END IF;
 DELETE FROM public.context_extraction_runs WHERE job_id=j;
 -- Daily run limit: six runs today (skipped), old enough to be past cooldown.
 INSERT INTO public.context_extraction_runs(job_id,run_date,phase,status,run_seq,started_at,finished_at)
  SELECT j,d,'extraction','skipped',g,now()-interval '2 hours',now()-interval '2 hours' FROM generate_series(1,6) g;
 c:=public.context_job_cadence(j);
 IF pg_temp.cu_due(j) OR c->>'blocked_reason'<>'daily_ceiling' OR (c->>'run_limit')::int<>6
  OR public.claim_context_extraction_run(j,d,'extraction')->>'outcome'<>'ceiling'
 THEN RAISE EXCEPTION 'catch-up daily ceiling %',c; END IF;
 DELETE FROM public.context_extraction_runs WHERE job_id=j;
 IF NOT pg_temp.cu_due(j) THEN RAISE EXCEPTION 'catch-up fixture not due after clearing runs'; END IF;
 -- Holding job and lane off.
 UPDATE public.jobs SET metadata='{"do_not_schedule":true}' WHERE id=j;
 IF pg_temp.cu_due(j) OR public.context_job_cadence(j)->>'blocked_reason'<>'holding_job' THEN RAISE EXCEPTION 'catch-up holding job due'; END IF;
 UPDATE public.jobs SET metadata='{}' WHERE id=j;
 UPDATE public.automation_switches SET extraction=false WHERE id=1;
 IF pg_temp.cu_due(j) THEN RAISE EXCEPTION 'catch-up due with the lane off'; END IF;
 UPDATE public.automation_switches SET extraction=true WHERE id=1;
 -- Morning reserve, shown with a reserve of 2 calls held until 23:59:59.
 PERFORM pg_temp.cu_policy('{"morning_cap":2,"morning_until":"23:59:59"}');
 INSERT INTO public.context_model_call_reservations(run_date,ordinal,phase,reserved_at)
  SELECT d,coalesce((SELECT max(ordinal) FROM public.context_model_call_reservations WHERE run_date=d),0)+g,'attribution',now() FROM generate_series(1,2) g;
 c:=public.context_job_cadence(j);
 IF pg_temp.cu_due(j) OR c->>'blocked_reason'<>'pacing_reserve' OR public.claim_context_extraction_run(j,d,'extraction')->>'outcome'<>'pacing'
 THEN RAISE EXCEPTION 'catch-up morning reserve %',c; END IF;
 -- The 400-call cap (reserve moved out of the way).
 PERFORM pg_temp.cu_policy(jsonb_build_object('morning_until','00:00'));
 INSERT INTO public.context_model_call_reservations(run_date,ordinal,phase,reserved_at)
  SELECT d,g,'attribution',now() FROM generate_series(coalesce((SELECT max(ordinal) FROM public.context_model_call_reservations WHERE run_date=d),0)+1,400) g;
 c:=public.context_job_cadence(j);
 IF pg_temp.cu_due(j) OR c->>'blocked_reason'<>'model_cap' THEN RAISE EXCEPTION 'catch-up model cap %',c; END IF;
END $$;
ROLLBACK;

-- 7. Live evidence keeps K1's timing on a listed job; status-only live rows do
-- not delay the catch-up to the evening read; a listed job with nothing unread
-- is never due and is reported; a job due only by catch-up never raises
-- cadence_breach.
BEGIN;
DO $$
DECLARE quiet uuid; so uuid; empty uuid; old uuid; st jsonb; c jsonb;
BEGIN
 PERFORM pg_temp.cu_policy();
 quiet:=pg_temp.cu_job('CU-QUIET'); so:=pg_temp.cu_job('CU-SO'); empty:=pg_temp.cu_job('CU-EMPTY'); old:=pg_temp.cu_job('CU-OLD');
 PERFORM pg_temp.cu_ev(quiet,'client.sms_in','Old message','12 days');
 PERFORM pg_temp.cu_ev(quiet,'client.sms_in','Live message','5 minutes',false);
 PERFORM pg_temp.cu_ev(so,'trade.checked_in','Crew on site','20 minutes',false);
 PERFORM pg_temp.cu_ev(old,'client.sms_in','Old message','12 days');
 PERFORM pg_temp.cu_list(quiet,2); PERFORM pg_temp.cu_list(so,2); PERFORM pg_temp.cu_list(empty,2); PERFORM pg_temp.cu_list(old,2);
 c:=public.context_job_cadence(quiet);
 IF pg_temp.cu_due(quiet) OR (c->>'catchup_only')::boolean OR (c->>'next_due_at')::timestamptz<now()+interval '9 minutes'
 THEN RAISE EXCEPTION 'catch-up skipped the quiet period %',c; END IF;
 c:=public.context_job_cadence(so);
 IF NOT pg_temp.cu_due(so) OR NOT (c->>'catchup_only')::boolean OR (c->>'status_only_count')::int<>1
 THEN RAISE EXCEPTION 'catch-up status-only job not due now %',c; END IF;
 c:=public.context_job_cadence(empty);
 IF pg_temp.cu_due(empty) OR (c->>'due')::boolean OR c->>'catchup_priority' IS NOT NULL THEN RAISE EXCEPTION 'catch-up empty job due %',c; END IF;
 -- A backlog requested three hours ago and still waiting is not a stalled worker.
 UPDATE public.context_catchup_jobs SET requested_at=now()-interval '3 hours';
 st:=public.context_cadence_status();
 IF (st->>'cadence_breach')::boolean OR st->>'oldest_due_wait_minutes' IS NOT NULL OR (st->>'due_jobs')::int<2
  OR (st->'catchup'->>'remaining')::int<>4 OR (st->'catchup'->>'remaining_nothing_unread')::int<>1
  OR (st->'catchup'->>'remaining_priority_2')::int<>4 OR (st->'catchup'->>'due_now')::int<>2
  OR (st->'catchup'->>'oldest_requested_at')::timestamptz>now()-interval '179 minutes'
 THEN RAISE EXCEPTION 'catch-up status or breach %',st; END IF;
 -- Control: a live job due as long still raises the alarm.
 PERFORM pg_temp.cu_ev(pg_temp.cu_job('CU-BREACH'),'client.sms_in','Hello?','3 hours',false);
 IF NOT (public.context_cadence_status()->>'cadence_breach')::boolean THEN RAISE EXCEPTION 'catch-up hid a real breach'; END IF;
END $$;
ROLLBACK;
