-- Backlog ceiling contract. Every fixture write is rolled back. Ids, job
-- numbers and text are synthetic. Each transaction moves live_since ten days
-- back (pg_temp.bc_policy), so a row captured 12 days ago is pre-go-live
-- history (read only through the catch-up list) and a row captured 30 minutes
-- ago is live waking evidence. The day's calls are set exactly with
-- pg_temp.bc_calls, whatever earlier contracts left behind.

CREATE TABLE pg_temp.bc_base_policy AS SELECT public.context_cadence_policy() AS p;

CREATE FUNCTION pg_temp.bc_policy(p_over jsonb DEFAULT '{}'::jsonb) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 EXECUTE format('CREATE OR REPLACE FUNCTION public.context_cadence_policy() RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $b$ SELECT %L::jsonb $b$',
  (SELECT p FROM pg_temp.bc_base_policy)||jsonb_build_object('live_since',now()-interval '10 days')||p_over);
END $$;

CREATE FUNCTION pg_temp.bc_today() RETURNS date LANGUAGE sql AS $$ SELECT (now() AT TIME ZONE 'Australia/Perth')::date $$;

-- Exactly p_n model calls today (attribution phase; every phase counts).
CREATE FUNCTION pg_temp.bc_calls(p_n integer) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM public.context_model_call_reservations WHERE run_date=pg_temp.bc_today();
 INSERT INTO public.context_model_call_reservations(run_date,ordinal,phase,reserved_at)
  SELECT pg_temp.bc_today(),g,'attribution',now() FROM generate_series(1,p_n) g;
END $$;

CREATE FUNCTION pg_temp.bc_job(p_number text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,metadata,created_at)
  VALUES(j,'00000000-0000-0000-0000-000000000001','scheduled','fencing',p_number,'{}',now()-interval '60 days');
 RETURN j;
END $$;

-- A row through the real trigger, then moved p_ago back. p_history strips
-- written_as, as on every row captured before K1 went live.
CREATE FUNCTION pg_temp.bc_ev(p_job uuid,p_body text,p_ago interval,p_history boolean) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE new_id uuid;
BEGIN
 INSERT INTO public.business_events(job_id,match_method,direction,event_type,source,payload,occurred_at,event_at)
  VALUES(p_job,'direct_job_id','inbound','client.sms_in','ceiling_contract',jsonb_build_object('body',p_body),now()-p_ago,now()-p_ago)
  RETURNING id INTO new_id;
 UPDATE public.business_events SET context_captured_at=now()-p_ago,
  attributed_at=CASE WHEN attributed_at IS NULL THEN NULL ELSE now()-p_ago END,
  metadata=CASE WHEN p_history THEN coalesce(metadata,'{}'::jsonb)-'written_as' ELSE metadata END WHERE id=new_id;
 RETURN new_id;
END $$;

-- A backlog job: history only, listed by a backlog writer.
CREATE FUNCTION pg_temp.bc_backlog(p_number text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid:=pg_temp.bc_job(p_number);
BEGIN
 PERFORM pg_temp.bc_ev(j,'Old message','12 days',true);
 INSERT INTO public.context_catchup_jobs(job_id,job_number,priority,mode,scope) VALUES(j,p_number,2,'full','backlog');
 RETURN j;
END $$;

-- A live job: a customer text 30 minutes ago (past the 15-minute quiet time).
CREATE FUNCTION pg_temp.bc_live(p_number text,p_ago interval DEFAULT '30 minutes') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid:=pg_temp.bc_job(p_number);
BEGIN
 PERFORM pg_temp.bc_ev(j,'Can you come Tuesday?',p_ago,false);
 RETURN j;
END $$;

-- p_n skipped reads today, two hours ago (past cooldown).
CREATE FUNCTION pg_temp.bc_runs(p_job uuid,p_n integer) RETURNS void LANGUAGE sql AS $$
 INSERT INTO public.context_extraction_runs(job_id,run_date,phase,status,run_seq,started_at,finished_at)
  SELECT p_job,pg_temp.bc_today(),'extraction','skipped',g,now()-interval '2 hours',now()-interval '2 hours' FROM generate_series(1,p_n) g $$;

CREATE FUNCTION pg_temp.bc_cand(p_job uuid) RETURNS boolean LANGUAGE sql AS $$
 SELECT EXISTS(SELECT 1 FROM public.context_extraction_candidates(400) c WHERE c.job_id=p_job) $$;
CREATE FUNCTION pg_temp.bc_midnight() RETURNS timestamptz LANGUAGE sql AS $$
 SELECT (pg_temp.bc_today()+1)::timestamp AT TIME ZONE 'Australia/Perth' $$;

-- 1. Shape: one settings row with the desk's defaults, row security, service
-- role only; the replaced functions keep their grants; the policy and every
-- cap are untouched.
DO $$
DECLARE f regprocedure; s record; p jsonb:=public.context_cadence_policy();
BEGIN
 SELECT * INTO s FROM public.context_cadence_settings;
 IF (SELECT count(*) FROM public.context_cadence_settings)<>1 OR s.live_reserve_calls_day<>100 OR s.live_reserve_calls_morning<>100 OR s.live_reserve_reads_per_job<>2
 THEN RAISE EXCEPTION 'backlog ceiling shape: settings row %',to_jsonb(s); END IF;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.context_cadence_settings'::regclass)
  OR has_table_privilege('anon','public.context_cadence_settings','SELECT') OR has_table_privilege('authenticated','public.context_cadence_settings','UPDATE')
  OR NOT has_table_privilege('service_role','public.context_cadence_settings','UPDATE')
 THEN RAISE EXCEPTION 'backlog ceiling shape: settings grants'; END IF;
 FOREACH f IN ARRAY ARRAY['public.context_jobs_cadence(uuid[])','public.context_cadence_status()','public.claim_context_extraction_run(uuid,date,text)']::regprocedure[] LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') OR NOT has_function_privilege('service_role',f,'EXECUTE')
  THEN RAISE EXCEPTION 'backlog ceiling shape: grants on %',f; END IF;
  IF (SELECT proconfig FROM pg_proc WHERE oid=f) IS NULL OR NOT (SELECT prosecdef FROM pg_proc WHERE oid=f)
  THEN RAISE EXCEPTION 'backlog ceiling shape: % not security definer with a fixed search_path',f; END IF;
 END LOOP;
 IF p IS DISTINCT FROM (SELECT y.p FROM public.ceiling_contract_policy_preimage y)
  OR (p->>'model_call_cap')::int<>400 OR (p->>'morning_cap')::int<>300 OR (p->>'runs_per_job_day')::int<>6
 THEN RAISE EXCEPTION 'backlog ceiling shape: policy moved %',p; END IF;
END $$;

-- 2. The day ceiling: after noon, a backlog job is due at 299 calls and held
-- backlog_budget at 300 (400 less the day reserve of 100) until Perth
-- midnight, and the claim refuses it; a live job stays due and is claimed up
-- to the 400 cap. A re-list that moves requested_at to now() does not get the
-- backlog past the ceiling. The desk can tune the reserve; a missing settings
-- row reads as the defaults.
BEGIN;
DO $$
DECLARE b uuid; l uuid; c jsonb; claim jsonb; d date:=pg_temp.bc_today();
BEGIN
 PERFORM pg_temp.bc_policy('{"morning_until":"00:00"}');
 b:=pg_temp.bc_backlog('BC-DAY-B'); l:=pg_temp.bc_live('BC-DAY-L');
 PERFORM pg_temp.bc_calls(299);
 c:=public.context_job_cadence(b);
 IF NOT (c->>'due')::boolean OR NOT pg_temp.bc_cand(b) OR (c->>'backlog_budget_held')::boolean OR NOT (c->>'catchup_only')::boolean
 THEN RAISE EXCEPTION 'backlog ceiling day: backlog not due below the ceiling %',c; END IF;
 PERFORM pg_temp.bc_calls(300);
 c:=public.context_job_cadence(b);
 IF (c->>'due')::boolean OR pg_temp.bc_cand(b) OR c->>'blocked_reason' IS DISTINCT FROM 'backlog_budget' OR NOT (c->>'backlog_budget_held')::boolean
  OR (c->>'next_due_at')::timestamptz<>pg_temp.bc_midnight()
 THEN RAISE EXCEPTION 'backlog ceiling day: backlog still due at 300 calls %',c; END IF;
 claim:=public.claim_context_extraction_run(b,d,'extraction');
 IF claim->>'outcome'<>'pacing' OR claim->>'reason'<>'backlog_budget' OR EXISTS(SELECT 1 FROM public.context_extraction_runs WHERE job_id=b)
 THEN RAISE EXCEPTION 'backlog ceiling day: claim started a backlog read %',claim; END IF;
 -- A re-list stamps requested_at now(): still held.
 UPDATE public.context_catchup_jobs SET requested_at=now() WHERE job_id=b;
 IF (public.context_job_cadence(b)->>'due')::boolean THEN RAISE EXCEPTION 'backlog ceiling day: requested_at now() bypassed the ceiling'; END IF;
 -- The live job keeps the reserve.
 PERFORM pg_temp.bc_calls(399);
 c:=public.context_job_cadence(l);
 IF NOT (c->>'due')::boolean OR NOT pg_temp.bc_cand(l) OR c->>'blocked_reason' IS NOT NULL OR (c->>'catchup_only')::boolean OR (c->>'backlog_budget_held')::boolean
 THEN RAISE EXCEPTION 'backlog ceiling day: live job not due at 399 calls %',c; END IF;
 claim:=public.claim_context_extraction_run(l,d,'extraction');
 IF claim->>'outcome'<>'claimed' THEN RAISE EXCEPTION 'backlog ceiling day: live claim %',claim; END IF;
 DELETE FROM public.context_extraction_runs WHERE job_id=l;
 -- The 400 cap still holds everyone, as model_cap.
 PERFORM pg_temp.bc_calls(400);
 IF public.context_job_cadence(l)->>'blocked_reason' IS DISTINCT FROM 'model_cap' OR public.context_job_cadence(b)->>'blocked_reason' IS DISTINCT FROM 'model_cap'
 THEN RAISE EXCEPTION 'backlog ceiling day: cap reason changed'; END IF;
 -- Tuned: a day reserve of 50 lets the backlog run to 349.
 UPDATE public.context_cadence_settings SET live_reserve_calls_day=50;
 PERFORM pg_temp.bc_calls(349);
 IF NOT (public.context_job_cadence(b)->>'due')::boolean THEN RAISE EXCEPTION 'backlog ceiling day: tuned reserve ignored'; END IF;
 PERFORM pg_temp.bc_calls(350);
 IF (public.context_job_cadence(b)->>'due')::boolean THEN RAISE EXCEPTION 'backlog ceiling day: tuned ceiling not held'; END IF;
 -- No settings row: the defaults (100) hold, never "no reserve".
 DELETE FROM public.context_cadence_settings;
 PERFORM pg_temp.bc_calls(300);
 IF (public.context_job_cadence(b)->>'due')::boolean THEN RAISE EXCEPTION 'backlog ceiling day: missing settings row dropped the reserve'; END IF;
 -- All reserves 0: the old shared pool.
 INSERT INTO public.context_cadence_settings(id,live_reserve_calls_day,live_reserve_calls_morning,live_reserve_reads_per_job) VALUES(true,0,0,0);
 PERFORM pg_temp.bc_calls(399);
 IF NOT (public.context_job_cadence(b)->>'due')::boolean THEN RAISE EXCEPTION 'backlog ceiling day: zero reserve is not the old pool'; END IF;
END $$;
ROLLBACK;

-- 3. The morning reserve: before morning_until a backlog job is held at 200
-- calls (300 less the morning reserve of 100) until noon; a live job stays
-- due until the morning 300, then K1's pacing_reserve holds it.
BEGIN;
DO $$
DECLARE b uuid; l uuid; c jsonb; noon timestamptz;
BEGIN
 PERFORM pg_temp.bc_policy('{"morning_until":"23:59:59"}');
 noon:=(pg_temp.bc_today()::timestamp+time '23:59:59') AT TIME ZONE 'Australia/Perth';
 b:=pg_temp.bc_backlog('BC-AM-B'); l:=pg_temp.bc_live('BC-AM-L');
 PERFORM pg_temp.bc_calls(199);
 IF NOT (public.context_job_cadence(b)->>'due')::boolean THEN RAISE EXCEPTION 'backlog ceiling morning: backlog not due at 199'; END IF;
 PERFORM pg_temp.bc_calls(200);
 c:=public.context_job_cadence(b);
 IF (c->>'due')::boolean OR c->>'blocked_reason' IS DISTINCT FROM 'backlog_budget' OR (c->>'next_due_at')::timestamptz<>noon
 THEN RAISE EXCEPTION 'backlog ceiling morning: backlog due at 200 before noon %',c; END IF;
 PERFORM pg_temp.bc_calls(299);
 c:=public.context_job_cadence(l);
 IF NOT (c->>'due')::boolean OR NOT pg_temp.bc_cand(l) THEN RAISE EXCEPTION 'backlog ceiling morning: live job not due at 299 %',c; END IF;
 PERFORM pg_temp.bc_calls(300);
 c:=public.context_job_cadence(l);
 IF (c->>'due')::boolean OR c->>'blocked_reason' IS DISTINCT FROM 'pacing_reserve' THEN RAISE EXCEPTION 'backlog ceiling morning: K1 pacing changed %',c; END IF;
 -- Tuned: a morning reserve of 0 lets the backlog run to the morning 300.
 UPDATE public.context_cadence_settings SET live_reserve_calls_morning=0;
 PERFORM pg_temp.bc_calls(299);
 IF NOT (public.context_job_cadence(b)->>'due')::boolean THEN RAISE EXCEPTION 'backlog ceiling morning: tuned morning reserve ignored'; END IF;
END $$;
ROLLBACK;

-- 4. Reads a job: a backlog job stops at 4 reads today (6 less the per-job
-- reserve of 2) until midnight; a listed job with live waking evidence is not
-- catch-up-only and keeps its last two reads; K1's daily ceiling is unchanged.
BEGIN;
DO $$
DECLARE b uuid; l uuid; c jsonb; claim jsonb;
BEGIN
 PERFORM pg_temp.bc_policy('{"morning_until":"00:00"}');
 PERFORM pg_temp.bc_calls(0);
 b:=pg_temp.bc_backlog('BC-JOB-B');
 PERFORM pg_temp.bc_runs(b,3);
 IF NOT (public.context_job_cadence(b)->>'due')::boolean THEN RAISE EXCEPTION 'backlog ceiling job: backlog not due after 3 reads'; END IF;
 DELETE FROM public.context_extraction_runs WHERE job_id=b;
 PERFORM pg_temp.bc_runs(b,4);
 c:=public.context_job_cadence(b);
 IF (c->>'due')::boolean OR c->>'blocked_reason' IS DISTINCT FROM 'backlog_budget' OR (c->>'run_limit')::int<>6
  OR (c->>'next_due_at')::timestamptz<>pg_temp.bc_midnight()
 THEN RAISE EXCEPTION 'backlog ceiling job: backlog due after 4 reads %',c; END IF;
 claim:=public.claim_context_extraction_run(b,pg_temp.bc_today(),'extraction');
 IF claim->>'outcome'<>'pacing' OR claim->>'reason'<>'backlog_budget' THEN RAISE EXCEPTION 'backlog ceiling job: claim %',claim; END IF;
 -- Live evidence lands on the same listed job: it is a live job now.
 PERFORM pg_temp.bc_ev(b,'Are you still coming?','30 minutes',false);
 c:=public.context_job_cadence(b);
 IF NOT (c->>'due')::boolean OR (c->>'catchup_only')::boolean THEN RAISE EXCEPTION 'backlog ceiling job: live evidence did not wake the job %',c; END IF;
 -- K1's limit is 6, or 10 for a customer text in business hours.
 DELETE FROM public.context_extraction_runs WHERE job_id=b;
 PERFORM pg_temp.bc_runs(b,(public.context_job_cadence(b)->>'run_limit')::int);
 IF public.context_job_cadence(b)->>'blocked_reason' IS DISTINCT FROM 'daily_ceiling' THEN RAISE EXCEPTION 'backlog ceiling job: K1 daily ceiling changed'; END IF;
END $$;
ROLLBACK;

-- 5. cadence_breach: a live job held by the cap (or the morning 300) past
-- 90 minutes raises it with cause budget, although no job is due and calls are
-- not below the cap. A backlog job held by the ceiling never raises it. The
-- worker case (a due live job waiting with budget left) still raises it.
BEGIN;
DO $$
DECLARE st jsonb; a jsonb;
BEGIN
 PERFORM pg_temp.bc_policy('{"morning_until":"00:00"}');
 PERFORM pg_temp.bc_backlog('BC-BR-B');
 UPDATE public.context_catchup_jobs SET requested_at=now()-interval '3 hours' WHERE job_number='BC-BR-B';
 PERFORM pg_temp.bc_calls(300);
 st:=public.context_cadence_status();
 IF (st->>'cadence_breach')::boolean OR (st->>'backlog_budget_held_jobs')::int<1
  OR (st->'read_reserve'->>'backlog_ceiling_day')::int<>300 OR (st->'read_reserve'->>'backlog_ceiling_morning')::int<>200
 THEN RAISE EXCEPTION 'backlog ceiling breach: backlog held by the ceiling raised it %',st; END IF;
 PERFORM pg_temp.bc_live('BC-BR-L','3 hours');
 PERFORM pg_temp.bc_calls(400);
 st:=public.context_cadence_status();
 SELECT x INTO a FROM jsonb_array_elements(st->'alarms') x WHERE x->>'key'='cadence_breach';
 IF NOT (st->>'cadence_breach')::boolean OR (st->>'live_held_by_budget_jobs')::int<1 OR (st->>'oldest_held_wait_minutes')::int<150
  OR a->>'cause' IS DISTINCT FROM 'budget' OR a->>'what_to_do' NOT LIKE '%model calls are spent%'
 THEN RAISE EXCEPTION 'backlog ceiling breach: live job held by the cap was silent %',st; END IF;
 -- The morning 300 holds it too.
 PERFORM pg_temp.bc_policy('{"morning_until":"23:59:59"}');
 PERFORM pg_temp.bc_calls(300);
 IF NOT (public.context_cadence_status()->>'cadence_breach')::boolean THEN RAISE EXCEPTION 'backlog ceiling breach: morning hold was silent'; END IF;
 -- Worker case: budget left, the same live job due for hours.
 PERFORM pg_temp.bc_policy('{"morning_until":"00:00"}');
 PERFORM pg_temp.bc_calls(10);
 st:=public.context_cadence_status();
 SELECT x INTO a FROM jsonb_array_elements(st->'alarms') x WHERE x->>'key'='cadence_breach';
 IF NOT (st->>'cadence_breach')::boolean OR a->>'cause' IS DISTINCT FROM 'worker' OR (st->>'live_held_by_budget_jobs')::int<>0
 THEN RAISE EXCEPTION 'backlog ceiling breach: worker case changed %',st; END IF;
END $$;
ROLLBACK;
