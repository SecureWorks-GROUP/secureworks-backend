-- K1 evidence cadence contract. Every fixture write is rolled back.
-- Row labels follow cadence.md section 10 (R1 to R18); ids, job numbers and
-- text are synthetic. Times are relative to now(): each fixture sets its own
-- capture and placement times, and each transaction moves live_since ten days
-- back (pg_temp.k1_policy) so a row "captured 20 minutes ago" is live.

CREATE TABLE pg_temp.k1_base_policy AS SELECT public.context_cadence_policy() AS p;

-- Replace the policy inside the current transaction (rolled back with it).
CREATE FUNCTION pg_temp.k1_policy(p_over jsonb DEFAULT '{}'::jsonb) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 EXECUTE format('CREATE OR REPLACE FUNCTION public.context_cadence_policy() RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $b$ SELECT %L::jsonb $b$',
  (SELECT p FROM pg_temp.k1_base_policy)||jsonb_build_object('live_since',now()-interval '10 days')||p_over);
END $$;

CREATE FUNCTION pg_temp.k1_job(p_label text,p_contact text DEFAULT NULL,p_meta jsonb DEFAULT '{}'::jsonb,p_created_ago interval DEFAULT '30 days')
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,metadata,created_at)
  VALUES(j,'00000000-0000-0000-0000-000000000001','quoted','fencing','K1-'||p_label||'-'||left(j::text,8),p_contact,p_meta,now()-p_created_ago);
 RETURN j;
END $$;

-- Insert through the real BEFORE INSERT trigger (it stamps written_as), then
-- set capture and placement times to p_ago before now.
CREATE FUNCTION pg_temp.k1_ev(p_job uuid,p_direction text,p_type text,p_body text,p_ago interval,
 p_source text DEFAULT 'k1_contract',p_payload jsonb DEFAULT '{}'::jsonb,p_meta jsonb DEFAULT '{}'::jsonb,p_event_ago interval DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE new_id uuid;
BEGIN
 INSERT INTO public.business_events(job_id,match_method,direction,event_type,source,payload,occurred_at,event_at)
  VALUES(p_job,'direct_job_id',p_direction,p_type,p_source,jsonb_build_object('body',p_body)||p_payload,
   now()-coalesce(p_event_ago,p_ago),now()-coalesce(p_event_ago,p_ago))
  RETURNING id INTO new_id;
 UPDATE public.business_events SET context_captured_at=now()-p_ago,
  attributed_at=CASE WHEN attributed_at IS NULL THEN NULL ELSE now()-p_ago END,
  metadata=coalesce(metadata,'{}'::jsonb)||p_meta WHERE id=new_id;
 RETURN new_id;
END $$;

CREATE FUNCTION pg_temp.k1_due(p_job uuid) RETURNS boolean LANGUAGE sql AS $$
 SELECT EXISTS(SELECT 1 FROM public.context_extraction_candidates(400) c WHERE c.job_id=p_job) $$;

CREATE FUNCTION pg_temp.k1_today() RETURNS date LANGUAGE sql AS $$ SELECT (now() AT TIME ZONE 'Australia/Perth')::date $$;

-- 1. Grants (review M9): no PUBLIC, anon or authenticated execute on any
-- callable context_* function or on the K1 run and pass functions; every K1
-- function has a fixed search_path; the staff lookup table is service-only.
DO $$
DECLARE f regprocedure;
BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND ((p.proname LIKE 'context\_%' AND p.prorettype<>'trigger'::regtype)
   OR p.proname IN ('claim_context_extraction_run','renew_context_extraction_run',
   'claim_context_pass','renew_context_pass','finish_context_pass','attribute_business_event')) LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE')
  THEN RAISE EXCEPTION 'k1 public execute on %',f; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_cadence_policy()','public.context_request_role()','public.context_event_status_only(public.business_events)',
  'public.context_unread_rows(uuid[])','public.context_unread_events(uuid)','public.context_event_is_ours(public.business_events)',
  'public.context_jobs_cadence(uuid[])','public.context_job_cadence(uuid)','public.context_cadence_pool()','public.context_extraction_candidates(integer)','public.context_ready_jobs_count(integer)',
  'public.context_extraction_events(uuid,integer)','public.context_extraction_event_flags(uuid,uuid[])','public.claim_context_extraction_run(uuid,date,text)',
  'public.renew_context_extraction_run(uuid,uuid)','public.claim_context_pass(date)','public.renew_context_pass(date,uuid)',
  'public.finish_context_pass(date,uuid,text,timestamptz,text)','public.context_job_freshness(uuid)','public.context_cadence_status()']::regprocedure[] LOOP
  IF NOT has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'k1 service_role missing execute on %',f; END IF;
  -- The unread read deliberately carries no SET clause so it inlines into its
  -- callers (the two-week capture filter must reach the index); it is
  -- SECURITY INVOKER SQL with every operator schema-qualified.
  IF f='public.context_unread_rows(uuid[])'::regprocedure THEN
   IF (SELECT proconfig IS NOT NULL OR prosecdef OR prolang<>(SELECT oid FROM pg_language WHERE lanname='sql') FROM pg_proc WHERE oid=f)
   THEN RAISE EXCEPTION 'k1 % must be inlinable invoker SQL without a SET clause',f; END IF;
  ELSIF (SELECT proconfig FROM pg_proc WHERE oid=f) IS NULL THEN RAISE EXCEPTION 'k1 function without fixed search_path %',f; END IF;
 END LOOP;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.staff_ghl_users'::regclass)
  OR has_table_privilege('anon','public.staff_ghl_users','SELECT') OR has_table_privilege('authenticated','public.staff_ghl_users','SELECT')
  OR has_table_privilege('anon','public.staff_ghl_users','INSERT') OR NOT has_table_privilege('service_role','public.staff_ghl_users','SELECT')
 THEN RAISE EXCEPTION 'k1 staff_ghl_users access wrong'; END IF;
 -- The one-run-a-day index is gone; run_seq makes a run unique.
 IF to_regclass('public.context_extraction_runs_job_day_phase') IS NOT NULL OR to_regclass('public.context_extraction_runs_job_day_phase_seq') IS NULL
 THEN RAISE EXCEPTION 'k1 run ledger indexes'; END IF;
 IF (public.context_cadence_policy()->>'version')<>'k1-cadence-policy-v1' OR (public.context_cadence_policy()->>'live_since') IS NULL
  OR (public.context_cadence_policy()->>'live_since')::timestamptz>now()
 THEN RAISE EXCEPTION 'k1 policy %',public.context_cadence_policy(); END IF;
END $$;

-- 2. Who wrote the row (review M9, X16). The trigger records the request role
-- and overwrites what the writer sent; a public-key row is stored but is not
-- unread, never wakes, never enters a batch, and is counted in the status.
BEGIN;
DO $$
DECLARE j uuid; e uuid; anon_e uuid; meta jsonb;
BEGIN
 PERFORM pg_temp.k1_policy();
 j:=pg_temp.k1_job('WRITER');
 e:=pg_temp.k1_ev(j,'inbound','client.sms_in','Can you come Tuesday?','20 minutes');
 IF (SELECT metadata->>'written_as' FROM public.business_events WHERE id=e) IS DISTINCT FROM 'service_role'
 THEN RAISE EXCEPTION 'k1 no-request write not service_role'; END IF;
 PERFORM set_config('request.jwt.claims','{"role":"anon"}',true);
 INSERT INTO public.business_events(job_id,match_method,direction,event_type,payload,metadata)
  VALUES(j,'direct_job_id','inbound','client.sms_in','{"body":"Public key text"}','{"written_as":"service_role"}') RETURNING id,metadata INTO anon_e,meta;
 IF meta->>'written_as' IS DISTINCT FROM 'anon' THEN RAISE EXCEPTION 'k1 public-key row claimed service_role: %',meta; END IF;
 PERFORM set_config('request.jwt.claims','{"role":"authenticated"}',true);
 INSERT INTO public.business_events(job_id,match_method,payload) VALUES(j,'direct_job_id','{"body":"Signed-in text"}') RETURNING metadata INTO meta;
 IF meta->>'written_as' IS DISTINCT FROM 'authenticated' THEN RAISE EXCEPTION 'k1 authenticated row %',meta; END IF;
 PERFORM set_config('request.jwt.claims','not json',true);
 INSERT INTO public.business_events(job_id,match_method,payload) VALUES(j,'direct_job_id','{"body":"Garbled claim"}') RETURNING metadata INTO meta;
 IF meta->>'written_as' IS DISTINCT FROM 'unknown' THEN RAISE EXCEPTION 'k1 unreadable claim %',meta; END IF;
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 INSERT INTO public.business_events(job_id,match_method,payload) VALUES(j,'direct_job_id','{"body":"Edge function text"}') RETURNING metadata INTO meta;
 IF meta->>'written_as' IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'k1 service key row %',meta; END IF;
 PERFORM set_config('request.jwt.claims','',true);
 UPDATE public.business_events SET context_captured_at=now()-interval '20 minutes',attributed_at=now()-interval '20 minutes' WHERE job_id=j;
 IF EXISTS(SELECT 1 FROM public.context_unread_events(j) WHERE metadata->>'written_as'<>'service_role')
 THEN RAISE EXCEPTION 'k1 public-key row counted unread'; END IF;
 IF EXISTS(SELECT 1 FROM public.context_extraction_events(j,25) WHERE id=anon_e) THEN RAISE EXCEPTION 'k1 public-key row entered a batch'; END IF;
 IF (public.context_cadence_status()->>'rows_not_service_role_24h')::int<3 THEN RAISE EXCEPTION 'k1 public-key rows not counted in status'; END IF;
 -- A job whose only new rows came from the public key never wakes.
 DELETE FROM public.business_events WHERE job_id=j AND metadata->>'written_as'='service_role';
 IF pg_temp.k1_due(j) THEN RAISE EXCEPTION 'k1 public-key row woke a job'; END IF;
END $$;
ROLLBACK;

-- 3. R1 and R7: a job whose only evidence is ours. quote.sent wakes one run
-- after the quiet period; the status change with no words is not read; the
-- run is receipted and freshness shows it.
BEGIN;
DO $$
DECLARE j uuid; q uuid; s uuid; claim jsonb; run uuid; tok uuid; f jsonb; c jsonb; d date:=pg_temp.k1_today();
BEGIN
 PERFORM pg_temp.k1_policy();
 j:=pg_temp.k1_job('R1','k1-r1-contact');
 q:=pg_temp.k1_ev(j,'outbound','quote.sent','Quote Q-1 sent to the client for 42 m of Colorbond.','16 minutes','send-quote');
 s:=pg_temp.k1_ev(j,NULL,'job.status_changed','','16 minutes');
 IF (SELECT attribution_status FROM public.business_events WHERE id=s)<>'empty' THEN RAISE EXCEPTION 'k1 R1 fixture: status change has words'; END IF;
 IF NOT pg_temp.k1_due(j) THEN RAISE EXCEPTION 'k1 R1 quote.sent alone did not wake the job: %',public.context_job_cadence(j); END IF;
 IF (SELECT array_agg(id) FROM public.context_extraction_events(j,25))<>ARRAY[q] THEN RAISE EXCEPTION 'k1 R1 batch is not the quote row'; END IF;
 IF NOT (SELECT ours FROM public.context_extraction_event_flags(j,ARRAY[q,s]) WHERE event_id=q)
 THEN RAISE EXCEPTION 'k1 R1 quote row not flagged ours'; END IF;
 claim:=public.claim_context_extraction_run(j,d,'extraction');
 IF claim->>'outcome'<>'claimed' OR (claim->'run'->>'run_seq')::int<>1 THEN RAISE EXCEPTION 'k1 R1 claim %',claim; END IF;
 run:=(claim->'run'->>'id')::uuid; tok:=(claim->'run'->>'lease_token')::uuid;
 IF pg_temp.k1_due(j) THEN RAISE EXCEPTION 'k1 R1 job due while its run is live'; END IF;
 IF NOT public.renew_context_extraction_run(run,tok) OR public.renew_context_extraction_run(run,gen_random_uuid())
 THEN RAISE EXCEPTION 'k1 R1 job lease renewal'; END IF;
 IF NOT public.finish_context_extraction_run(run,tok,'done',ARRAY[q],10,0,0,0,NULL,NULL) THEN RAISE EXCEPTION 'k1 R1 finish refused'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts WHERE event_id=q AND run_id=run) THEN RAISE EXCEPTION 'k1 R1 no receipt'; END IF;
 IF pg_temp.k1_due(j) OR EXISTS(SELECT 1 FROM public.context_unread_events(j)) THEN RAISE EXCEPTION 'k1 R1 still due after its read'; END IF;
 f:=public.context_job_freshness(j);
 IF f->>'last_run_finished_at' IS NULL OR (f->>'unread_count')::int<>0 OR f->>'next_due_at' IS NOT NULL
  OR f->>'line' NOT LIKE 'Facts current to %; 0 newer items not yet read; 0 messages from this customer not yet placed on any job'
 THEN RAISE EXCEPTION 'k1 R7 freshness after the run %',f; END IF;
 -- R7 timing: a clean quote.sent 14 minutes old is not yet due; its next read
 -- is due 15 minutes after it landed.
 j:=pg_temp.k1_job('R7');
 q:=pg_temp.k1_ev(j,'outbound','quote.sent','Quote Q-2 sent.','14 minutes','send-quote');
 c:=public.context_job_cadence(j);
 IF pg_temp.k1_due(j) OR (c->>'next_due_at')::timestamptz NOT BETWEEN now()+interval '50 seconds' AND now()+interval '70 seconds'
 THEN RAISE EXCEPTION 'k1 R7 quiet period %',c; END IF;
END $$;
ROLLBACK;

-- 4. Quiet and ceiling (cadence.md 5.1): a conversation that never goes quiet
-- is still read 60 minutes after its oldest unread row landed.
BEGIN;
DO $$
DECLARE busy uuid; fresh uuid; quiet uuid; m int;
BEGIN
 PERFORM pg_temp.k1_policy();
 busy:=pg_temp.k1_job('CEILING'); fresh:=pg_temp.k1_job('FRESH'); quiet:=pg_temp.k1_job('QUIET');
 FOREACH m IN ARRAY ARRAY[65,55,45,35,25,15,5] LOOP
  PERFORM pg_temp.k1_ev(busy,'inbound','client.sms_in','Text '||m,make_interval(mins=>m));
 END LOOP;
 PERFORM pg_temp.k1_ev(fresh,'inbound','client.sms_in','Just now','5 minutes');
 PERFORM pg_temp.k1_ev(quiet,'inbound','client.sms_in','Earlier today','40 minutes');
 IF NOT pg_temp.k1_due(busy) THEN RAISE EXCEPTION 'k1 ceiling: a never-quiet conversation was not read'; END IF;
 IF pg_temp.k1_due(fresh) THEN RAISE EXCEPTION 'k1 quiet: a 5-minute-old text was read before the quiet period'; END IF;
 IF NOT pg_temp.k1_due(quiet) THEN RAISE EXCEPTION 'k1 quiet: a quiet job was not read'; END IF;
 -- Order: fewest runs today first, then oldest waking evidence first.
 IF (SELECT array_agg(job_id ORDER BY ord) FROM (SELECT job_id, row_number() OVER () ord FROM public.context_extraction_candidates(400)) x WHERE job_id IN (busy,quiet))<>ARRAY[busy,quiet]
 THEN RAISE EXCEPTION 'k1 order: oldest evidence first'; END IF;
 INSERT INTO public.context_extraction_runs(job_id,run_date,phase,status,started_at,finished_at,run_seq)
  VALUES(busy,pg_temp.k1_today(),'extraction','done',now()-interval '2 hours',now()-interval '2 hours',1);
 IF (SELECT array_agg(job_id ORDER BY ord) FROM (SELECT job_id, row_number() OVER () ord FROM public.context_extraction_candidates(400)) x WHERE job_id IN (busy,quiet))<>ARRAY[quiet,busy]
 THEN RAISE EXCEPTION 'k1 order: fewest runs today first'; END IF;
 -- ready_jobs is the candidates read, at every cap, lane on and off.
 FOREACH m IN ARRAY ARRAY[400,2,1,0] LOOP
  IF public.context_ready_jobs_count(m)<>(SELECT count(*) FROM public.context_extraction_candidates(m)) THEN RAISE EXCEPTION 'k1 ready_jobs at cap %',m; END IF;
 END LOOP;
 UPDATE public.automation_switches SET extraction=false WHERE id=1;
 IF public.context_ready_jobs_count(400)<>0 OR pg_temp.k1_due(quiet) OR (public.context_job_cadence(quiet)->>'blocked_reason')<>'lane_off'
  OR public.claim_context_extraction_run(quiet,pg_temp.k1_today(),'extraction')->>'outcome'<>'paused'
  OR EXISTS(SELECT 1 FROM public.context_extraction_events(quiet,25))
 THEN RAISE EXCEPTION 'k1 extraction lane off must hold every job'; END IF;
END $$;
ROLLBACK;

-- 5. R9: a noisy job. Never two runs within 30 minutes; at most 6 runs a
-- Perth date (10 when the newest waking row is the customer's own words in
-- business hours); the claim itself refuses past the limits.
BEGIN;
DO $$
DECLARE j uuid; c jsonb; claim jsonb; d date:=pg_temp.k1_today(); i int; lim int;
BEGIN
 PERFORM pg_temp.k1_policy();
 j:=pg_temp.k1_job('R9');
 FOR i IN 1..40 LOOP PERFORM pg_temp.k1_ev(j,'outbound','client.sms_out','Our text '||i,make_interval(mins=>500-i*10),'ghl-proxy'); END LOOP;
 INSERT INTO public.context_extraction_runs(job_id,run_date,phase,status,started_at,finished_at,run_seq)
  VALUES(j,d,'extraction','done',now()-interval '10 minutes',now()-interval '9 minutes',1);
 c:=public.context_job_cadence(j);
 IF pg_temp.k1_due(j) OR (c->>'cooldown_until')::timestamptz<=now() THEN RAISE EXCEPTION 'k1 R9 cooldown %',c; END IF;
 claim:=public.claim_context_extraction_run(j,d,'extraction');
 IF claim->>'outcome'<>'paused' OR claim->>'reason'<>'cooldown' THEN RAISE EXCEPTION 'k1 R9 claim inside cooldown %',claim; END IF;
 UPDATE public.context_extraction_runs SET started_at=now()-interval '40 minutes' WHERE job_id=j;
 IF NOT pg_temp.k1_due(j) THEN RAISE EXCEPTION 'k1 R9 not due after cooldown %',public.context_job_cadence(j); END IF;
 claim:=public.claim_context_extraction_run(j,d,'extraction');
 IF claim->>'outcome'<>'claimed' OR (claim->'run'->>'run_seq')::int<>2 THEN RAISE EXCEPTION 'k1 R9 second run of the day %',claim; END IF;
 -- Newest waking row is ours: the limit is 6.
 UPDATE public.context_extraction_runs SET status='done',finished_at=now(),lease_expires_at=NULL,started_at=now()-interval '40 minutes' WHERE job_id=j;
 INSERT INTO public.context_extraction_runs(job_id,run_date,phase,status,started_at,finished_at,run_seq)
  SELECT j,d,'extraction','done',now()-interval '40 minutes',now()-interval '39 minutes',s FROM generate_series(3,6) s;
 c:=public.context_job_cadence(j);
 IF pg_temp.k1_due(j) OR (c->>'run_limit')::int<>6 OR c->>'blocked_reason'<>'daily_ceiling' THEN RAISE EXCEPTION 'k1 R9 daily ceiling %',c; END IF;
 claim:=public.claim_context_extraction_run(j,d,'extraction');
 IF claim->>'outcome'<>'ceiling' THEN RAISE EXCEPTION 'k1 R9 claim past the ceiling %',claim; END IF;
 IF (public.context_cadence_status()->>'jobs_at_daily_ceiling')::int<1 OR (public.context_cadence_status()->>'max_runs_one_job_today')::int<6
 THEN RAISE EXCEPTION 'k1 R9 status does not show the ceiling'; END IF;
 IF (public.context_job_freshness(j)->>'next_due_at')::timestamptz<((d+1)::timestamp AT TIME ZONE 'Australia/Perth') THEN RAISE EXCEPTION 'k1 R9 next read before tomorrow'; END IF;
 -- Newest waking row is the customer's words: 4 extra runs in business hours only.
 PERFORM pg_temp.k1_ev(j,'inbound','client.sms_in','Can the crew start earlier?','20 minutes');
 c:=public.context_job_cadence(j);
 lim:=CASE WHEN public.context_in_business_hours(now()) THEN 10 ELSE 6 END;
 IF NOT (c->>'newest_waking_is_customer')::boolean OR (c->>'run_limit')::int<>lim OR pg_temp.k1_due(j)<>(lim=10)
 THEN RAISE EXCEPTION 'k1 R9 inbound extra runs (expected limit %) %',lim,c; END IF;
END $$;
ROLLBACK;

-- 6. A failed run waits for its retry, then is re-claimed in place.
BEGIN;
DO $$
DECLARE j uuid; r uuid; claim jsonb; d date:=pg_temp.k1_today();
BEGIN
 PERFORM pg_temp.k1_policy();
 j:=pg_temp.k1_job('RETRY');
 PERFORM pg_temp.k1_ev(j,'inbound','client.sms_in','Please call me back','50 minutes');
 INSERT INTO public.context_extraction_runs(job_id,run_date,phase,status,started_at,retry_at,error,run_seq)
  VALUES(j,d,'extraction','failed',now()-interval '45 minutes',now()+interval '20 minutes','timeout',1) RETURNING id INTO r;
 IF pg_temp.k1_due(j) OR public.context_job_cadence(j)->>'blocked_reason'<>'retry_wait' THEN RAISE EXCEPTION 'k1 retry wait %',public.context_job_cadence(j); END IF;
 claim:=public.claim_context_extraction_run(j,d,'extraction');
 IF claim->>'outcome'<>'paused' OR claim->>'retry_at' IS NULL THEN RAISE EXCEPTION 'k1 claim during retry wait %',claim; END IF;
 UPDATE public.context_extraction_runs SET retry_at=now()-interval '1 minute' WHERE id=r;
 IF NOT pg_temp.k1_due(j) THEN RAISE EXCEPTION 'k1 retry not due'; END IF;
 claim:=public.claim_context_extraction_run(j,d,'extraction');
 IF claim->>'outcome'<>'claimed' OR (claim->'run'->>'id')::uuid<>r OR (claim->'run'->>'attempts')::int<>2 THEN RAISE EXCEPTION 'k1 retry reclaim %',claim; END IF;
 IF public.claim_context_extraction_run(j,d,'extraction')->>'outcome'<>'busy' THEN RAISE EXCEPTION 'k1 second claimer not busy'; END IF;
 -- Attribution and bucket keep one run a day.
 claim:=public.claim_context_extraction_run(j,d,'attribution');
 PERFORM public.finish_context_extraction_run((claim->'run'->>'id')::uuid,(claim->'run'->>'lease_token')::uuid,'done','{}',0,0,0,0,NULL,NULL);
 IF public.claim_context_extraction_run(j,d,'attribution')->>'outcome'<>'done' THEN RAISE EXCEPTION 'k1 attribution phase ran twice a day'; END IF;
END $$;
ROLLBACK;

-- 7. Status-only rows (review S2) ride along; alone they get one read after
-- 18:00 Perth. Workflow texts are status-only; staff texts are not.
BEGIN;
DO $$
DECLARE j uuid; k uuid; auth uuid; t uuid; c jsonb; evening timestamptz;
 due_now boolean:=(now() AT TIME ZONE 'Australia/Perth')::time>=time '18:00';
 e public.business_events;
BEGIN
 PERFORM pg_temp.k1_policy();
 evening:=(pg_temp.k1_today()::timestamp+time '18:00') AT TIME ZONE 'Australia/Perth';
 j:=pg_temp.k1_job('STATUS');
 auth:=pg_temp.k1_ev(j,'internal','invoice.authorised','Invoice authorised in Xero.','3 hours');
 c:=public.context_job_cadence(j);
 IF (c->>'waking_count')::int<>0 OR (c->>'status_only_count')::int<>1 OR pg_temp.k1_due(j)<>due_now
  OR (NOT due_now AND (c->>'next_due_at')::timestamptz<>evening)
 THEN RAISE EXCEPTION 'k1 status-only alone (due_now %) %',due_now,c; END IF;
 IF due_now THEN
  INSERT INTO public.context_extraction_runs(job_id,run_date,phase,status,started_at,finished_at,run_seq)
   VALUES(j,pg_temp.k1_today(),'extraction','done',greatest(evening,now()-interval '31 minutes'),now()-interval '30 minutes',1);
  IF pg_temp.k1_due(j) THEN RAISE EXCEPTION 'k1 status-only read twice in one evening'; END IF;
 END IF;
 -- Beside a waking row the status-only row is read in the same batch.
 k:=pg_temp.k1_job('STATUS-RIDE');
 auth:=pg_temp.k1_ev(k,'internal','invoice.authorised','Invoice authorised in Xero.','3 hours');
 t:=pg_temp.k1_ev(k,'inbound','client.sms_in','Paid the deposit today','20 minutes');
 IF NOT pg_temp.k1_due(k) OR (SELECT count(*) FROM public.context_extraction_events(k,25) WHERE id IN (auth,t))<>2
 THEN RAISE EXCEPTION 'k1 status-only row did not ride along'; END IF;
 -- The list.
 FOR e IN SELECT (jsonb_populate_record(NULL::public.business_events,jsonb_build_object('event_type',x.t,'payload',x.p))).*
  FROM (VALUES ('trade.site_event','{}'::jsonb),('invoice.payment_received','{}'),('invoice.authorised','{}'),('invoice.emailed','{}'),
   ('po.created','{}'),('booking.scope_visit_created','{}'),('ghl.task_created','{}'),('ghl.appointment_booked','{}'),
   ('client.sms_out','{"sent_by_kind":"workflow"}')) x(t,p) LOOP
  IF NOT public.context_event_status_only(e) THEN RAISE EXCEPTION 'k1 % should be status-only',e.event_type; END IF;
 END LOOP;
 FOR e IN SELECT (jsonb_populate_record(NULL::public.business_events,jsonb_build_object('event_type',x.t,'payload',x.p))).*
  FROM (VALUES ('client.sms_out','{"sent_by_kind":"staff_app"}'::jsonb),('quote.sent','{}'),('client.sms_in','{}'),('note.added','{}'),('po.sent','{}')) x(t,p) LOOP
  IF public.context_event_status_only(e) THEN RAISE EXCEPTION 'k1 % should wake',e.event_type; END IF;
 END LOOP;
END $$;
ROLLBACK;

-- 8. Nothing that is history wakes a read (review M4, M11): R3 backfill, R11
-- relink, rows captured before go-live, and R2's early contact placement of a
-- row older than its job. They still ride along when something live wakes it.
BEGIN;
DO $$
DECLARE j uuid; r2 uuid; old_row uuid; live_row uuid; bf uuid; rl uuid; d date:=pg_temp.k1_today();
BEGIN
 PERFORM pg_temp.k1_policy();
 -- R3: today's backfill writer sends no capture_mode, so its rows wake one run.
 j:=pg_temp.k1_job('R3');
 PERFORM pg_temp.k1_ev(j,'inbound','client.sms_in','Backfilled text 1','25 minutes',p_event_ago=>'3 days');
 PERFORM pg_temp.k1_ev(j,'inbound','client.sms_in','Backfilled text 2','25 minutes',p_event_ago=>'2 days');
 IF NOT pg_temp.k1_due(j) THEN RAISE EXCEPTION 'k1 R3 texts landed after go-live did not wake one run'; END IF;
 -- After rank 1 the same rows carry capture_mode backfill and ride along.
 UPDATE public.business_events SET metadata=metadata||'{"capture_mode":"backfill"}' WHERE job_id=j;
 IF pg_temp.k1_due(j) THEN RAISE EXCEPTION 'k1 R3 backfill rows woke a job'; END IF;
 -- R11: a relinked row does not wake.
 j:=pg_temp.k1_job('R11');
 rl:=pg_temp.k1_ev(j,'inbound','client.sms_in','Pre-job enquiry','25 minutes',p_meta=>'{"capture_mode":"relink"}');
 IF pg_temp.k1_due(j) THEN RAISE EXCEPTION 'k1 R11 relinked row woke a job'; END IF;
 -- M11: rows captured before go-live never wake (the first-deploy catch-up).
 PERFORM pg_temp.k1_policy(jsonb_build_object('live_since',now()-interval '10 minutes'));
 j:=pg_temp.k1_job('PRELIVE');
 old_row:=pg_temp.k1_ev(j,'inbound','client.sms_in','Before go-live','40 minutes');
 IF pg_temp.k1_due(j) THEN RAISE EXCEPTION 'k1 M11 pre-go-live row woke a job'; END IF;
 -- ...even when the ladder re-run places it after go-live (note b).
 UPDATE public.business_events SET attributed_at=now()-interval '20 minutes' WHERE id=old_row;
 IF pg_temp.k1_due(j) THEN RAISE EXCEPTION 'k1 M11 pre-go-live row re-linked after go-live woke a job'; END IF;
 PERFORM pg_temp.k1_policy();
 -- R2: a contact placement (step 3) of a row older than the job does not wake;
 -- the job's own quote.sent still does, and the old row rides along.
 j:=pg_temp.k1_job('R2','k1-r2-contact',p_created_ago=>'1 hour');
 r2:=pg_temp.k1_ev(j,'inbound','call.transcript_completed','Hi, you have reached the voicemail of ...','30 minutes',p_event_ago=>'6 days');
 UPDATE public.business_events SET attribution_status='single_open',attribution_step=3 WHERE id=r2;
 IF pg_temp.k1_due(j) THEN RAISE EXCEPTION 'k1 R2 relinked voicemail woke the new job'; END IF;
 live_row:=pg_temp.k1_ev(j,'outbound','quote.sent','Quote sent for the new job.','20 minutes','send-quote');
 IF NOT pg_temp.k1_due(j) OR (SELECT count(*) FROM public.context_extraction_events(j,25) WHERE id IN (r2,live_row))<>2
 THEN RAISE EXCEPTION 'k1 R2 quote.sent did not wake with the old row as context'; END IF;
 -- Age window (note c): a live row captured 15 days ago no longer wakes.
 j:=pg_temp.k1_job('AGE');
 PERFORM pg_temp.k1_policy(jsonb_build_object('live_since',now()-interval '30 days'));
 PERFORM pg_temp.k1_ev(j,'inbound','client.sms_in','Old unread text','15 days');
 IF pg_temp.k1_due(j) THEN RAISE EXCEPTION 'k1 row older than the age window woke a job'; END IF;
END $$;
ROLLBACK;

-- 9. R4: one supplier email copied into three mailboxes is read in one run;
-- the status change with no words is not in the batch. R5: a holding job is
-- never due.
BEGIN;
DO $$
DECLARE j uuid; h uuid; i int; n int; c jsonb;
BEGIN
 PERFORM pg_temp.k1_policy();
 j:=pg_temp.k1_job('R4');
 FOR i IN 1..3 LOOP
  PERFORM pg_temp.k1_ev(j,'inbound','supplier.email_in','Your Colorbond order is ready for pickup Thursday.','20 minutes','monitor-inbox',
   jsonb_build_object('from','orders@supplier.example','mailbox','box'||i));
 END LOOP;
 PERFORM pg_temp.k1_ev(j,NULL,'job.status_changed','','20 minutes');
 IF NOT pg_temp.k1_due(j) THEN RAISE EXCEPTION 'k1 R4 not due'; END IF;
 SELECT count(*) INTO n FROM public.context_extraction_events(j,25);
 IF n<>3 THEN RAISE EXCEPTION 'k1 R4 batch has % rows, want the three copies',n; END IF;
 h:=pg_temp.k1_job('R5',p_meta=>'{"do_not_schedule":"true","purpose":"pdf_unlock_bucket"}');
 PERFORM pg_temp.k1_ev(h,'inbound','client.email_in','Parked document','2 hours');
 c:=public.context_job_cadence(h);
 IF pg_temp.k1_due(h) OR c->>'blocked_reason'<>'holding_job' OR EXISTS(SELECT 1 FROM public.context_extraction_events(h,25))
 THEN RAISE EXCEPTION 'k1 R5 holding job %',c; END IF;
END $$;
ROLLBACK;

-- 10. Freshness (review M2, M3). R6: a draft with no evidence. R10: two open
-- jobs on one contact; a content_ref row wakes only its job; texts sent to
-- review wake neither and are counted on both. R13: the customer's texts
-- parked on a holding job are counted on their real job.
BEGIN;
DO $$
DECLARE r6 uuid; a uuid; b uuid; hold uuid; r13 uuid; e uuid; f jsonb; i int;
BEGIN
 PERFORM pg_temp.k1_policy();
 -- R6, no contact.
 r6:=pg_temp.k1_job('R6');
 f:=public.context_job_freshness(r6);
 IF (f->>'unread_count')::int<>0 OR f->>'next_due_at' IS NOT NULL OR NOT (f->>'contact_missing')::boolean
  OR f->>'line'<>'No facts read yet; 0 newer items not yet read; no contact on this job'
 THEN RAISE EXCEPTION 'k1 R6 freshness %',f; END IF;
 -- R6 with a contact whose texts are unplaced in the admin bucket.
 r6:=pg_temp.k1_job('R6C','k1-r6-contact');
 FOR i IN 1..2 LOOP
  INSERT INTO public.business_events(contact_id,payload,occurred_at,event_at) VALUES('k1-r6-contact',jsonb_build_object('body','Bucket text '||i),now(),now()) RETURNING id INTO e;
  UPDATE public.business_events SET job_id=NULL,attribution_status='admin_bucket' WHERE id=e;
 END LOOP;
 f:=public.context_job_freshness(r6);
 IF (f#>>'{unplaced_for_contact,count}')::int<>2 OR f->>'line' NOT LIKE '%; 2 messages from this customer not yet placed on any job'
 THEN RAISE EXCEPTION 'k1 R6 unplaced for contact %',f; END IF;
 -- R10.
 a:=pg_temp.k1_job('R10A','k1-r10-contact'); b:=pg_temp.k1_job('R10B','k1-r10-contact');
 e:=pg_temp.k1_ev(a,'inbound','client.sms_in','Is the $5,478 for the front fence?','20 minutes');
 UPDATE public.business_events SET attribution_status='content_ref',contact_id='k1-r10-contact' WHERE id=e;
 e:=pg_temp.k1_ev(a,'inbound','client.sms_in','Thanks, talk soon','20 minutes');
 UPDATE public.business_events SET job_id=NULL,attribution_status='unplaced',candidate_job_ids=ARRAY[a,b],contact_id='k1-r10-contact' WHERE id=e;
 IF NOT pg_temp.k1_due(a) OR pg_temp.k1_due(b) THEN RAISE EXCEPTION 'k1 R10 content_ref must wake only its job'; END IF;
 IF (public.context_job_freshness(a)#>>'{unplaced_for_contact,count}')::int<>1 OR (public.context_job_freshness(b)#>>'{unplaced_for_contact,count}')::int<>1
 THEN RAISE EXCEPTION 'k1 R10 unplaced text not counted on both jobs'; END IF;
 IF (public.context_cadence_status()->>'unplaced_count')::int<1 THEN RAISE EXCEPTION 'k1 R10 status unplaced count'; END IF;
 -- R13.
 hold:=pg_temp.k1_job('R13HOLD',p_meta=>'{"do_not_schedule":"true"}'); r13:=pg_temp.k1_job('R13','k1-r13-contact');
 e:=pg_temp.k1_ev(hold,'inbound','client.sms_in','When are you starting?','1 hour');
 UPDATE public.business_events SET contact_id='k1-r13-contact' WHERE id=e;
 IF (public.context_job_freshness(r13)#>>'{unplaced_for_contact,count}')::int<>1 OR pg_temp.k1_due(r13)
 THEN RAISE EXCEPTION 'k1 R13 holding-job text not in freshness'; END IF;
END $$;
ROLLBACK;

-- 11. R15 and review M1: the text that woke the job is always in the batch,
-- old rows are marked older context, and the newest customer row is kept even
-- behind 25 newer rows of ours.
BEGIN;
DO $$
DECLARE j uuid; k uuid; new_text uuid; cust uuid; i int; ids uuid[];
BEGIN
 PERFORM pg_temp.k1_policy();
 j:=pg_temp.k1_job('R15');
 FOR i IN 1..30 LOOP PERFORM pg_temp.k1_ev(j,'inbound','client.email_in','Old thread '||i,'30 days',p_event_ago=>make_interval(days=>20,mins=>i)); END LOOP;
 new_text:=pg_temp.k1_ev(j,'inbound','client.sms_in','We are ready for the install now','20 minutes');
 IF NOT pg_temp.k1_due(j) THEN RAISE EXCEPTION 'k1 R15 new text did not wake the job'; END IF;
 SELECT array_agg(id ORDER BY coalesce(event_at,occurred_at),id) INTO ids FROM public.context_extraction_events(j,25);
 IF cardinality(ids)<>25 OR NOT new_text=ANY(ids) OR ids[25]<>new_text THEN RAISE EXCEPTION 'k1 R15 batch lost the new text or is not in time order'; END IF;
 IF (SELECT count(*) FILTER (WHERE older_context) FROM public.context_extraction_event_flags(j,ids))<>24
  OR (SELECT older_context FROM public.context_extraction_event_flags(j,ids) WHERE event_id=new_text)
 THEN RAISE EXCEPTION 'k1 R15 older-context flags'; END IF;
 -- A foreign id is ignored by the flags read.
 IF EXISTS(SELECT 1 FROM public.context_extraction_event_flags(gen_random_uuid(),ids)) THEN RAISE EXCEPTION 'k1 flags leaked another job'; END IF;
 -- The newest customer row is kept behind 26 newer rows of ours.
 k:=pg_temp.k1_job('ANCHOR');
 cust:=pg_temp.k1_ev(k,'inbound','client.sms_in','Please use the side gate','3 hours');
 FOR i IN 1..26 LOOP PERFORM pg_temp.k1_ev(k,'outbound','client.sms_out','Our update '||i,make_interval(mins=>150-i),'ghl-proxy'); END LOOP;
 IF NOT EXISTS(SELECT 1 FROM public.context_extraction_events(k,25) WHERE id=cust) OR (SELECT count(*) FROM public.context_extraction_events(k,25))<>25
 THEN RAISE EXCEPTION 'k1 anchor: newest customer row dropped'; END IF;
END $$;
ROLLBACK;

-- 12. R17 and R18 (review M6): "ours" is decided by who sent it, not by the
-- stored direction.
BEGIN;
DO $$
DECLARE e public.business_events; x record;
BEGIN
 INSERT INTO public.staff_ghl_users(ghl_user_id,label) VALUES('k1-staff-user','contract');
 FOR x IN SELECT * FROM (VALUES
  ('R17 admin@ order stored as inbound','inbound','client.email_in','x','{"from":"admin@secureworksgroup.com.au"}'::jsonb,true),
  ('R18 marnin@ reply stored as inbound','inbound','client.email_in','x','{"from":"Marnin <marnin@secureworkswa.com.au>"}',true),
  ('orders@ app domain','inbound','client.email_in','x','{"from":"orders@secureworksgroup.app"}',true),
  ('customer gmail','inbound','client.email_in','x','{"from":"someone@gmail.com"}',false),
  ('lookalike domain','inbound','client.email_in','x','{"from":"a@notsecureworksgroup.com.au.example"}',false),
  ('our SMS line','inbound','client.sms_in','x','{"from":"+61 489 267 771"}',true),
  ('customer mobile','inbound','client.sms_in','x','{"from":"+61400111222"}',false),
  ('staff GHL user','inbound','client.sms_in','x','{"sent_by_user":"k1-staff-user"}',true),
  ('unknown GHL user','inbound','client.sms_in','x','{"sent_by_user":"someone"}',false),
  ('staff app','inbound','client.sms_in','x','{"sent_by_kind":"staff_app"}',true),
  ('internal comment','inbound','ghl.internal_comment','x','{}',true),
  ('GHL note','inbound','ghl.note_added','x','{}',true),
  ('outbound direction','outbound','client.sms_out','x','{}',true),
  ('quote tool','inbound','quote.accepted','send-quote','{}',true),
  ('customer text','inbound','client.sms_in','x','{}',false)) v(label,dir,typ,src,payload,want) LOOP
  e:=jsonb_populate_record(NULL::public.business_events,jsonb_build_object('direction',x.dir,'event_type',x.typ,'source',x.src,'payload',x.payload));
  IF public.context_event_is_ours(e) IS DISTINCT FROM x.want THEN RAISE EXCEPTION 'k1 ours: % should be %',x.label,x.want; END IF;
 END LOOP;
END $$;
ROLLBACK;

-- 13. Morning reserve (review S10): before 12:00 Perth at most 300 of the 400
-- calls. Shown with a reserve of 2 calls held until 23:59:59.
BEGIN;
DO $$
DECLARE j uuid; c jsonb; claim jsonb;
BEGIN
 PERFORM pg_temp.k1_policy('{"morning_cap":2,"morning_until":"23:59:59"}');
 j:=pg_temp.k1_job('PACING');
 PERFORM pg_temp.k1_ev(j,'inbound','client.sms_in','Any update?','20 minutes');
 IF NOT pg_temp.k1_due(j) THEN RAISE EXCEPTION 'k1 pacing fixture not due before the reserve'; END IF;
 INSERT INTO public.context_model_call_reservations(run_date,ordinal,phase,reserved_at)
  SELECT pg_temp.k1_today(),coalesce((SELECT max(ordinal) FROM public.context_model_call_reservations WHERE run_date=pg_temp.k1_today()),0)+g,'attribution',now()
  FROM generate_series(1,2) g;
 c:=public.context_job_cadence(j);
 IF pg_temp.k1_due(j) OR c->>'blocked_reason'<>'pacing_reserve' THEN RAISE EXCEPTION 'k1 pacing %',c; END IF;
 claim:=public.claim_context_extraction_run(j,pg_temp.k1_today(),'extraction');
 IF claim->>'outcome'<>'pacing' THEN RAISE EXCEPTION 'k1 claim inside the morning reserve %',claim; END IF;
 IF (public.context_cadence_status()->>'pacing_held_jobs')::int<1 THEN RAISE EXCEPTION 'k1 status pacing_held_jobs'; END IF;
END $$;
ROLLBACK;

-- 14. R16 and review M7: the tick lease is 5 minutes at any hour, done is not
-- terminal, a lapsed lease is taken over and counted, and only the current
-- token may renew or finish.
BEGIN;
DO $$
DECLARE d date:=pg_temp.k1_today(); c jsonb; tok uuid; tok2 uuid;
BEGIN
 DELETE FROM public.context_pass_days WHERE run_date=d;
 c:=public.claim_context_pass(d);
 IF c->>'outcome'<>'claimed' THEN RAISE EXCEPTION 'k1 pass not claimable at this hour %',c; END IF;
 tok:=(c->>'lease_token')::uuid;
 IF (c->'pass'->>'lease_expires_at')::timestamptz>now()+interval '5 minutes 1 second' THEN RAISE EXCEPTION 'k1 pass lease longer than 5 minutes'; END IF;
 IF public.claim_context_pass(d)->>'outcome'<>'busy' THEN RAISE EXCEPTION 'k1 second claimer not busy'; END IF;
 -- Worker killed mid-tick: the lease lapses and the next process takes over.
 UPDATE public.context_pass_days SET lease_expires_at=now()-interval '1 second' WHERE run_date=d;
 c:=public.claim_context_pass(d); tok2:=(c->>'lease_token')::uuid;
 IF c->>'outcome'<>'claimed' OR tok2=tok OR (c->'pass'->>'lease_takeovers')::int<>1 THEN RAISE EXCEPTION 'k1 takeover %',c; END IF;
 IF public.renew_context_pass(d,tok) OR public.finish_context_pass(d,tok,'done',NULL,NULL) THEN RAISE EXCEPTION 'k1 replaced holder kept its lease'; END IF;
 IF (public.context_cadence_status()->>'lease_takeovers_today')::int<>1 THEN RAISE EXCEPTION 'k1 takeovers not in status'; END IF;
 -- A slow holder that still owns the token renews after its lease ran out.
 UPDATE public.context_pass_days SET lease_expires_at=now()-interval '1 second' WHERE run_date=d;
 IF NOT public.renew_context_pass(d,tok2) THEN RAISE EXCEPTION 'k1 current holder could not renew'; END IF;
 IF NOT public.finish_context_pass(d,tok2,'done',NULL,NULL) THEN RAISE EXCEPTION 'k1 finish refused'; END IF;
 IF public.claim_context_pass(d)->>'outcome'<>'claimed' THEN RAISE EXCEPTION 'k1 done pass is terminal'; END IF;
END $$;
ROLLBACK;

-- 15. The status block reaches the heartbeat through the F1 composer, with the
-- cadence_breach alarm when a due job waited more than 90 minutes.
BEGIN;
DO $$
DECLARE j uuid; s jsonb; st jsonb;
BEGIN
 PERFORM pg_temp.k1_policy();
 j:=pg_temp.k1_job('BREACH');
 PERFORM pg_temp.k1_ev(j,'inbound','client.sms_in','Hello?','3 hours');
 st:=public.context_cadence_status();
 IF (st->>'due_jobs')::int<1 OR NOT (st->>'cadence_breach')::boolean OR (st->>'oldest_due_wait_minutes')::int<100
 THEN RAISE EXCEPTION 'k1 status breach %',st; END IF;
 s:=public.context_pipeline_status();
 IF jsonb_typeof(s->'cadence')<>'object' OR NOT s->'alarms' @> '[{"block":"cadence","key":"cadence_breach"}]'::jsonb
  OR (s->>'ready_jobs')::int<>(SELECT count(*) FROM public.context_extraction_candidates(400))
 THEN RAISE EXCEPTION 'k1 composer %',s; END IF;
 UPDATE public.automation_switches SET extraction=false WHERE id=1;
 IF (public.context_cadence_status()->>'cadence_breach')::boolean THEN RAISE EXCEPTION 'k1 breach with the lane off'; END IF;
END $$;
ROLLBACK;

-- 16. Cost: the unread read inlines, so the pool's two-week filter is applied
-- to business_events itself rather than to a materialised function result.
DO $$
DECLARE plan text:=''; line text;
BEGIN
 FOR line IN EXECUTE 'EXPLAIN SELECT DISTINCT u.job_id FROM public.context_unread_rows(NULL) u WHERE u.context_captured_at>=now()-interval ''14 days''' LOOP
  plan:=plan||line||chr(10);
 END LOOP;
 IF plan LIKE '%Function Scan%context_unread_rows%' THEN RAISE EXCEPTION 'k1 context_unread_rows not inlined: %',plan; END IF;
END $$;
