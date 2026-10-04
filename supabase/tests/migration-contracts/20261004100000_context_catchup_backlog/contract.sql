-- Catch-up backlog contract. Every fixture write is rolled back. Ids, job
-- numbers and text are synthetic. Each transaction moves live_since ten days
-- back (pg_temp.bl_policy), so a row captured 12 days ago is pre-go-live
-- history and a row captured 20 minutes ago is live. Earlier contracts leave
-- fixture jobs behind, so tier assertions look only at BL- jobs and at count
-- deltas.

CREATE TABLE pg_temp.bl_base_policy AS SELECT public.context_cadence_policy() AS p;

CREATE FUNCTION pg_temp.bl_policy() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 EXECUTE format('CREATE OR REPLACE FUNCTION public.context_cadence_policy() RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $b$ SELECT %L::jsonb $b$',
  (SELECT p FROM pg_temp.bl_base_policy)||jsonb_build_object('live_since',now()-interval '10 days'));
END $$;

CREATE FUNCTION pg_temp.bl_job(p_number text,p_status text,p_meta jsonb DEFAULT '{}'::jsonb,p_quoted_ago interval DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,metadata,created_at,quoted_at)
  VALUES(j,'00000000-0000-0000-0000-000000000001',p_status,'fencing',p_number,p_meta,now()-interval '400 days',now()-p_quoted_ago);
 RETURN j;
END $$;

-- A row through the real trigger, then moved p_ago back. p_history strips
-- written_as, as on every row captured before K1 went live.
CREATE FUNCTION pg_temp.bl_ev(p_job uuid,p_body text,p_ago interval,p_history boolean DEFAULT true) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE new_id uuid;
BEGIN
 INSERT INTO public.business_events(job_id,match_method,direction,event_type,source,payload,occurred_at,event_at)
  VALUES(p_job,'direct_job_id','inbound','client.sms_in','backlog_contract',jsonb_build_object('body',p_body),now()-p_ago,now()-p_ago)
  RETURNING id INTO new_id;
 UPDATE public.business_events SET context_captured_at=now()-p_ago,
  attributed_at=CASE WHEN attributed_at IS NULL THEN NULL ELSE now()-p_ago END,
  metadata=CASE WHEN p_history THEN coalesce(metadata,'{}'::jsonb)-'written_as' ELSE metadata END WHERE id=new_id;
 RETURN new_id;
END $$;

-- A done extraction run p_ago back, with luna_v2 receipts for every row on the
-- job at that moment. Returns the run id.
CREATE FUNCTION pg_temp.bl_read(p_job uuid,p_ago interval) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE run uuid; d date:=((now()-p_ago) AT TIME ZONE 'Australia/Perth')::date;
BEGIN
 INSERT INTO public.context_extraction_runs(job_id,run_date,phase,status,run_seq,started_at,finished_at)
  VALUES(p_job,d,'extraction','done',coalesce((SELECT max(run_seq) FROM public.context_extraction_runs WHERE job_id=p_job AND run_date=d),0)+1,
   now()-p_ago,now()-p_ago) RETURNING id INTO run;
 INSERT INTO public.context_extraction_event_receipts(event_id,job_id,run_id)
  SELECT e.id,p_job,run FROM public.business_events e WHERE e.job_id=p_job ON CONFLICT DO NOTHING;
 RETURN run;
END $$;

-- An invoice on the job.
CREATE FUNCTION pg_temp.bl_inv(p_job uuid,p_type text,p_status text,p_due numeric) RETURNS void LANGUAGE sql AS $$
 INSERT INTO public.xero_invoices(org_id,xero_invoice_id,invoice_type,status,amount_due,job_id)
  VALUES('00000000-0000-0000-0000-000000000001','BL-'||gen_random_uuid(),p_type,p_status,p_due,p_job) $$;

-- What a tier's dry run says about the BL- jobs: job_number -> action/mode.
CREATE FUNCTION pg_temp.bl_mine(r jsonb) RETURNS jsonb LANGUAGE sql AS $$
 SELECT coalesce(jsonb_object_agg(x->>'job_number',(x->>'action')||'/'||(x->>'mode')),'{}'::jsonb)
 FROM jsonb_array_elements(r->'jobs') x WHERE x->>'job_number' LIKE 'BL-%' $$;
CREATE FUNCTION pg_temp.bl_today() RETURNS date LANGUAGE sql AS $$ SELECT (now() AT TIME ZONE 'Australia/Perth')::date $$;
CREATE FUNCTION pg_temp.bl_list_state() RETURNS text LANGUAGE sql AS $$
 SELECT coalesce(md5(string_agg(to_jsonb(c)::text,',' ORDER BY c.job_id)),'empty') FROM public.context_catchup_jobs c $$;

-- 1. Shape and grants. The writer and the pending read are service role only
-- with a fixed search_path; priority takes 1..5; mode and scope default to the
-- existing behaviour and refuse anything else.
DO $$
DECLARE f regprocedure;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_catchup_request_backlog(integer,boolean,integer)','public.context_catchup_pending_rows(uuid[])']::regprocedure[] LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') OR NOT has_function_privilege('service_role',f,'EXECUTE')
  THEN RAISE EXCEPTION 'backlog grants on %',f; END IF;
  IF (SELECT proconfig FROM pg_proc WHERE oid=f) IS NULL OR NOT (SELECT prosecdef FROM pg_proc WHERE oid=f)
  THEN RAISE EXCEPTION 'backlog function % not security definer with a fixed search_path',f; END IF;
 END LOOP;
 IF (SELECT array_agg(pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid='public.context_catchup_jobs'::regclass AND contype='c'
   AND conname IN ('context_catchup_jobs_priority_check','context_catchup_jobs_mode_check','context_catchup_jobs_scope_check'))
  IS DISTINCT FROM ARRAY['CHECK ((mode = ANY (ARRAY[''full''::text, ''unread''::text])))','CHECK (((priority >= 1) AND (priority <= 5)))',
   'CHECK ((scope = ANY (ARRAY[''live_catchup''::text, ''backlog''::text])))']
 THEN RAISE EXCEPTION 'backlog checks %',(SELECT array_agg(pg_get_constraintdef(oid)) FROM pg_constraint WHERE conrelid='public.context_catchup_jobs'::regclass AND contype='c'); END IF;
 IF (SELECT count(*) FROM pg_constraint WHERE conrelid='public.context_catchup_jobs'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%priority%')<>1
 THEN RAISE EXCEPTION 'backlog left a second priority check'; END IF;
 IF (SELECT prosrc FROM pg_proc WHERE oid='public.context_catchup_request_backlog(integer,boolean,integer)'::regprocedure) NOT LIKE '%pg_advisory_xact_lock(20260924,22)%'
 THEN RAISE EXCEPTION 'backlog writer does not take the catch-up lock'; END IF;
END $$;

BEGIN;
DO $$
DECLARE j uuid;
BEGIN
 j:=pg_temp.bl_job('BL-SHAPE','scheduled');
 INSERT INTO public.context_catchup_jobs(job_id,job_number,priority) VALUES(j,'BL-SHAPE',5);
 IF (SELECT mode||'/'||scope FROM public.context_catchup_jobs WHERE job_id=j)<>'full/live_catchup' THEN RAISE EXCEPTION 'backlog defaults'; END IF;
 BEGIN UPDATE public.context_catchup_jobs SET priority=6 WHERE job_id=j; RAISE EXCEPTION 'backlog accepted priority 6';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN UPDATE public.context_catchup_jobs SET mode='partial' WHERE job_id=j; RAISE EXCEPTION 'backlog accepted mode partial';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN UPDATE public.context_catchup_jobs SET scope='other' WHERE job_id=j; RAISE EXCEPTION 'backlog accepted scope other';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
ROLLBACK;

-- 2. Unchanged: the policy (every cap and live_since), the original writer and
-- the cadence, candidates, batch, flags, done marker and status bodies.
DO $$
DECLARE p jsonb:=public.context_cadence_policy(); x record; live text;
BEGIN
 IF p IS DISTINCT FROM (SELECT y.p FROM public.backlog_contract_policy_preimage y)
  OR (p->>'model_call_cap')::int<>400 OR (p->>'morning_cap')::int<>300 OR (p->>'runs_per_job_day')::int<>6
 THEN RAISE EXCEPTION 'backlog moved the policy %',p; END IF;
 FOR x IN SELECT * FROM (VALUES
  ('public.context_catchup_request(boolean)','b12a7e9637f87d4345c03e4a604a4022'),
  ('public.context_jobs_cadence(uuid[])','184bfbf98717e2a85cfaed282bcca9a6'),
  ('public.context_cadence_pool()','5cb50d8d47eb917acb2406ae3f0d9369'),
  ('public.context_extraction_candidates(integer)','fc0f681d15d59c80a8ee41b45d0486cc'),
  ('public.context_cadence_status()','552d7971757d43624ec3667e3dc1fb99'),
  ('public.context_extraction_events(uuid,integer)','68f6da2aac47cae91aa62a0420402d74'),
  ('public.context_extraction_event_flags(uuid,uuid[])','5aedb3e5a7aa3286145079032e8e22f8'),
  ('public.context_catchup_mark_done()','f52e823ab347b0983bb561bcb951514d'),
  ('public.context_catchup_record_read()','5420a6486bee3e03501200008aca6053')) AS t(sig,want) LOOP
  SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid=to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.want THEN RAISE EXCEPTION 'backlog changed % (md5 %)',x.sig,live; END IF;
 END LOOP;
END $$;

-- 3. Bad arguments refuse before anything is read.
DO $$
DECLARE bad integer;
BEGIN
 FOREACH bad IN ARRAY ARRAY[0,6] LOOP
  BEGIN PERFORM public.context_catchup_request_backlog(bad); RAISE EXCEPTION 'backlog accepted tier %',bad;
  EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'context_catchup_backlog_tier_invalid%' THEN RAISE; END IF; END;
 END LOOP;
 BEGIN PERFORM public.context_catchup_request_backlog(NULL); RAISE EXCEPTION 'backlog accepted tier null';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'context_catchup_backlog_tier_invalid%' THEN RAISE; END IF; END;
 BEGIN PERFORM public.context_catchup_request_backlog(1,true,0); RAISE EXCEPTION 'backlog accepted limit 0';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'context_catchup_backlog_limit_invalid%' THEN RAISE; END IF; END;
END $$;

-- 4. Tier membership, the pick rule and the dry run. One job per case; every
-- BL- job lands in exactly one tier, and the dry run writes nothing.
BEGIN;
DO $$
DECLARE base jsonb:='{}'; after jsonb:='{}'; r jsonb; t integer; mine jsonb; want jsonb; state text; other uuid; moved uuid; recv uuid; run uuid; j uuid;
 counted integer;
BEGIN
 PERFORM pg_temp.bl_policy();
 FOR t IN 1..5 LOOP
  base:=base||jsonb_build_object(t::text,public.context_catchup_request_backlog(t,true,5000));
 END LOOP;
 -- Tier 1.
 j:=pg_temp.bl_job('BL-T1-OPEN-NEVER','complete'); PERFORM pg_temp.bl_ev(j,'Old text','40 days');
 PERFORM pg_temp.bl_inv(j,'ACCREC','AUTHORISED',150);
 j:=pg_temp.bl_job('BL-T1-SUBMITTED-NEVER','invoiced'); PERFORM pg_temp.bl_ev(j,'Old text','40 days');
 PERFORM pg_temp.bl_inv(j,'ACCREC','SUBMITTED',90);
 j:=pg_temp.bl_job('BL-T1-CANCELLED-READ','cancelled'); PERFORM pg_temp.bl_ev(j,'Old text','40 days');
 PERFORM pg_temp.bl_read(j,'30 days'); PERFORM pg_temp.bl_ev(j,'Invoice still owing','20 days');
 PERFORM pg_temp.bl_inv(j,'ACCREC','AUTHORISED',300);
 j:=pg_temp.bl_job('BL-T1-ARCHIVED-READ-DONE','archived'); PERFORM pg_temp.bl_ev(j,'Old text','40 days');
 PERFORM pg_temp.bl_read(j,'30 days'); PERFORM pg_temp.bl_inv(j,'ACCREC','AUTHORISED',300);
 -- The receiving job: read, done in the live catch-up, then a relinked row
 -- (receipted on the job it left, never read here) moved onto it.
 recv:=pg_temp.bl_job('BL-T1-RECEIVING','scheduled'); PERFORM pg_temp.bl_ev(recv,'Own text','40 days');
 run:=pg_temp.bl_read(recv,'12 days');
 INSERT INTO public.context_catchup_jobs(job_id,job_number,priority,requested_at,done_at,done_run_id) VALUES(recv,'BL-T1-RECEIVING',2,now()-interval '13 days',now()-interval '12 days',run);
 other:=pg_temp.bl_job('BL-T2-SENDER-READ','scheduled'); moved:=pg_temp.bl_ev(other,'Text for the other job','15 days');
 PERFORM pg_temp.bl_read(other,'14 days');
 UPDATE public.business_events SET job_id=recv,metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('capture_mode','relink',
  'placement_repaired',jsonb_build_object('rule','payload_job_mismatch','from_job_id',other)) WHERE id=moved;
 -- Not open money: these fall to their status tier.
 j:=pg_temp.bl_job('BL-T4-DRAFT-INVOICE','complete'); PERFORM pg_temp.bl_ev(j,'Old text','40 days');
 PERFORM pg_temp.bl_inv(j,'ACCREC','DRAFT',150);
 j:=pg_temp.bl_job('BL-T4-PAID','complete'); PERFORM pg_temp.bl_ev(j,'Old text','40 days');
 PERFORM pg_temp.bl_inv(j,'ACCREC','PAID',0);
 j:=pg_temp.bl_job('BL-T4-BILL','complete'); PERFORM pg_temp.bl_ev(j,'Old text','40 days');
 PERFORM pg_temp.bl_inv(j,'ACCPAY','AUTHORISED',150);
 j:=pg_temp.bl_job('BL-T4-OPEN-READ','complete'); PERFORM pg_temp.bl_ev(j,'Old text','40 days');
 PERFORM pg_temp.bl_read(j,'30 days'); PERFORM pg_temp.bl_ev(j,'Payment reminder','20 days');
 PERFORM pg_temp.bl_inv(j,'ACCREC','AUTHORISED',150);
 -- Tier 2.
 j:=pg_temp.bl_job('BL-T2-GETREVIEW-NEVER','get_review'); PERFORM pg_temp.bl_ev(j,'Old text','40 days');
 j:=pg_temp.bl_job('BL-T2-PROCESSING-READ','processing'); PERFORM pg_temp.bl_ev(j,'Old text','40 days');
 PERFORM pg_temp.bl_read(j,'30 days'); PERFORM pg_temp.bl_ev(j,'Newer text','20 days');
 j:=pg_temp.bl_job('BL-T2-NOTHING-UNREAD','in_progress'); PERFORM pg_temp.bl_ev(j,'Old text','40 days');
 PERFORM pg_temp.bl_read(j,'30 days');
 j:=pg_temp.bl_job('BL-T2-HOLDING','scheduled','{"do_not_schedule":true}'); PERFORM pg_temp.bl_ev(j,'Old text','40 days');
 PERFORM pg_temp.bl_job('BL-T2-NO-EVIDENCE','scheduled');
 -- Tier 3.
 j:=pg_temp.bl_job('BL-T3-OLD-QUOTE','quoted','{}','200 days'); PERFORM pg_temp.bl_ev(j,'Quote follow-up','190 days');
 j:=pg_temp.bl_job('BL-T3-RECENT-DRAFT','draft'); PERFORM pg_temp.bl_ev(j,'Lead text','10 days');
 -- Tier 4.
 j:=pg_temp.bl_job('BL-T4-COMPLETE','complete'); PERFORM pg_temp.bl_ev(j,'Thanks','100 days');
 -- Tier 5.
 j:=pg_temp.bl_job('BL-T5-OLD-DRAFT','draft'); PERFORM pg_temp.bl_ev(j,'Lead text','200 days');
 j:=pg_temp.bl_job('BL-T5-CANCELLED','cancelled'); PERFORM pg_temp.bl_ev(j,'Cancel','100 days');
 j:=pg_temp.bl_job('BL-T5-ARCHIVED','archived'); PERFORM pg_temp.bl_ev(j,'Old','300 days');
 j:=pg_temp.bl_job('BL-T5-LOST','lost'); PERFORM pg_temp.bl_ev(j,'No thanks','100 days');
 j:=pg_temp.bl_job('BL-T5-UNKNOWN-STATUS','order_confirmed'); PERFORM pg_temp.bl_ev(j,'Order','100 days');

 state:=pg_temp.bl_list_state();
 FOR t IN 1..5 LOOP
  r:=public.context_catchup_request_backlog(t,true,5000);
  IF (r->>'dry_run')::boolean IS DISTINCT FROM true OR r->'written' IS DISTINCT FROM 'null'::jsonb OR (r->>'tier')::int<>t
  THEN RAISE EXCEPTION 'backlog dry run shape %',r; END IF;
  after:=after||jsonb_build_object(t::text,r);
 END LOOP;
 IF pg_temp.bl_list_state()<>state THEN RAISE EXCEPTION 'backlog dry run wrote to the list'; END IF;

 want:='{"1":{"BL-T1-OPEN-NEVER":"add/full","BL-T1-SUBMITTED-NEVER":"add/full","BL-T1-CANCELLED-READ":"add/unread","BL-T1-RECEIVING":"reopen/unread"},
  "2":{"BL-T2-GETREVIEW-NEVER":"add/full","BL-T2-PROCESSING-READ":"add/unread"},
  "3":{"BL-T3-OLD-QUOTE":"add/full","BL-T3-RECENT-DRAFT":"add/full"},
  "4":{"BL-T4-DRAFT-INVOICE":"add/full","BL-T4-PAID":"add/full","BL-T4-BILL":"add/full","BL-T4-OPEN-READ":"add/unread","BL-T4-COMPLETE":"add/full"},
  "5":{"BL-T5-OLD-DRAFT":"add/full","BL-T5-CANCELLED":"add/full","BL-T5-ARCHIVED":"add/full","BL-T5-LOST":"add/full","BL-T5-UNKNOWN-STATUS":"add/full"}}';
 FOR t IN 1..5 LOOP
  mine:=pg_temp.bl_mine(after->t::text);
  IF mine IS DISTINCT FROM want->t::text THEN RAISE EXCEPTION 'backlog tier % picked % want %',t,mine,want->t::text; END IF;
 END LOOP;
 -- Excluded jobs are still members of their tier, counted under the reason:
 -- tier 2 holding (BL-T2-HOLDING), no evidence (BL-T2-NO-EVIDENCE and the
 -- sender, whose only row moved away), nothing unread (BL-T2-NOTHING-UNREAD);
 -- tier 1 nothing unread (BL-T1-ARCHIVED-READ-DONE).
 IF (after->'2'->'excluded'->>'holding_job')::int-(base->'2'->'excluded'->>'holding_job')::int<>1
  OR (after->'2'->'excluded'->>'no_evidence')::int-(base->'2'->'excluded'->>'no_evidence')::int<>2
  OR (after->'2'->'excluded'->>'nothing_unread')::int-(base->'2'->'excluded'->>'nothing_unread')::int<>1
  OR (after->'1'->'excluded'->>'nothing_unread')::int-(base->'1'->'excluded'->>'nothing_unread')::int<>1
 THEN RAISE EXCEPTION 'backlog exclusions % / %',after->'1'->'excluded',after->'2'->'excluded'; END IF;
 -- Every BL- job is a member of exactly one tier: the tier sizes together
 -- grew by exactly the number of BL- jobs.
 SELECT sum((after->g.k::text->>'tier_jobs')::int-(base->g.k::text->>'tier_jobs')::int) INTO counted FROM generate_series(1,5) g(k);
 IF counted<>(SELECT count(*) FROM public.jobs WHERE job_number LIKE 'BL-%') THEN RAISE EXCEPTION 'backlog tiers do not partition the jobs (% of %)',counted,
  (SELECT count(*) FROM public.jobs WHERE job_number LIKE 'BL-%'); END IF;
 -- Counts, by status, ids and numbers only, and estimated runs.
 r:=after->'1';
 IF (r->>'candidates')::int<>jsonb_array_length(r->'jobs')+(r->>'more')::int OR (r->>'more')::int<>0
  OR (r->'by_status'->'cancelled'->>'picked')::int<1 OR (r->'by_status'->'scheduled'->>'picked')::int<1
  OR (r->'by_action'->>'reopen')::int<1
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(r->'jobs') x WHERE EXISTS(SELECT 1 FROM jsonb_object_keys(x) k
   WHERE k NOT IN ('job_id','job_number','status','mode','action','pending_rows','runs')))
  OR (SELECT (x->>'pending_rows')::int FROM jsonb_array_elements(r->'jobs') x WHERE x->>'job_number'='BL-T1-RECEIVING')<>1
  OR (SELECT (x->>'pending_rows')::int FROM jsonb_array_elements(r->'jobs') x WHERE x->>'job_number'='BL-T1-CANCELLED-READ')<>1
  OR (r->>'estimated_runs')::int<>(SELECT sum((x->>'runs')::int) FROM jsonb_array_elements(r->'jobs') x)
 THEN RAISE EXCEPTION 'backlog tier 1 report %',r; END IF;
END $$;
ROLLBACK;

-- 5. The real run writes exactly the dry run's jobs, as backlog rows at the
-- tier's priority; re-opens a done row only when it has unread rows; never
-- lowers a pending priority; raises one; honours the limit; and a second run
-- writes nothing new.
BEGIN;
DO $$
DECLARE r jsonb; w jsonb; n uuid; rd uuid; done_quiet uuid; low uuid; high uuid; run uuid; ids uuid[];
BEGIN
 PERFORM pg_temp.bl_policy();
 DELETE FROM public.context_catchup_jobs;
 n:=pg_temp.bl_job('BL-NEW','complete'); PERFORM pg_temp.bl_ev(n,'Old text','40 days');
 rd:=pg_temp.bl_job('BL-REOPEN','complete'); PERFORM pg_temp.bl_ev(rd,'Old text','40 days');
 run:=pg_temp.bl_read(rd,'30 days'); PERFORM pg_temp.bl_ev(rd,'Unread text','20 days');
 INSERT INTO public.context_catchup_jobs(job_id,job_number,priority,done_at,done_run_id) VALUES(rd,'BL-REOPEN',1,now()-interval '30 days',run);
 done_quiet:=pg_temp.bl_job('BL-DONE-QUIET','complete'); PERFORM pg_temp.bl_ev(done_quiet,'Old text','40 days');
 run:=pg_temp.bl_read(done_quiet,'30 days');
 INSERT INTO public.context_catchup_jobs(job_id,job_number,priority,done_at,done_run_id) VALUES(done_quiet,'BL-DONE-QUIET',1,now()-interval '30 days',run);
 -- low: pending at priority 1, a tier 4 job: kept at 1. high: pending at 2,
 -- an open-invoice tier 1 job: raised to 1.
 low:=pg_temp.bl_job('BL-PENDING-LOW','complete'); PERFORM pg_temp.bl_ev(low,'Old text','40 days');
 INSERT INTO public.context_catchup_jobs(job_id,job_number,priority) VALUES(low,'BL-PENDING-LOW',1);
 high:=pg_temp.bl_job('BL-PENDING-HIGH','complete'); PERFORM pg_temp.bl_ev(high,'Old text','40 days');
 PERFORM pg_temp.bl_inv(high,'ACCREC','AUTHORISED',150);
 INSERT INTO public.context_catchup_jobs(job_id,job_number,priority) VALUES(high,'BL-PENDING-HIGH',2);

 r:=public.context_catchup_request_backlog(4,true,5000);
 w:=public.context_catchup_request_backlog(4,false,5000);
 IF w->'jobs' IS DISTINCT FROM r->'jobs' OR (w->'written'->>'added')::int<>(r->'by_action'->>'add')::int
  OR (w->'written'->>'reopened')::int<>(r->'by_action'->>'reopen')::int OR (w->'written'->>'priority_raised')::int<>0
 THEN RAISE EXCEPTION 'backlog real run differs from the dry run % / %',r,w; END IF;
 IF (SELECT priority||'/'||mode||'/'||scope||'/'||(done_at IS NULL) FROM public.context_catchup_jobs WHERE job_id=n)<>'4/full/backlog/true'
  OR (SELECT priority||'/'||mode||'/'||scope||'/'||(done_at IS NULL)||'/'||(done_run_id IS NULL)||'/'||(requested_at=now())
      FROM public.context_catchup_jobs WHERE job_id=rd)<>'4/unread/backlog/true/true/true'
  OR (SELECT done_at IS NOT NULL AND scope='live_catchup' FROM public.context_catchup_jobs WHERE job_id=done_quiet) IS NOT TRUE
  OR (SELECT priority||'/'||mode||'/'||scope FROM public.context_catchup_jobs WHERE job_id=low)<>'1/full/live_catchup'
  OR pg_temp.bl_mine(r)?'BL-DONE-QUIET' OR pg_temp.bl_mine(r)?'BL-PENDING-LOW'
 THEN RAISE EXCEPTION 'backlog write %',(SELECT jsonb_agg(to_jsonb(c)) FROM public.context_catchup_jobs c); END IF;
 -- The re-opened job reads only its unread row.
 SELECT array_agg(id) INTO ids FROM public.context_extraction_events(rd,25);
 IF cardinality(ids)<>1 OR (SELECT payload->>'body' FROM public.business_events WHERE id=ids[1])<>'Unread text'
 THEN RAISE EXCEPTION 'backlog re-opened job batch %',ids; END IF;
 -- Tier 1 raises the open-invoice job from 2 to 1 and keeps its row.
 w:=public.context_catchup_request_backlog(1,false,5000);
 IF (w->'written'->>'priority_raised')::int<>1 OR (w->'written'->>'added')::int<>0
  OR (SELECT priority||'/'||mode||'/'||scope FROM public.context_catchup_jobs WHERE job_id=high)<>'1/full/live_catchup'
 THEN RAISE EXCEPTION 'backlog raise %',w; END IF;
 -- A second run of the same tier writes nothing new.
 w:=public.context_catchup_request_backlog(4,false,5000);
 IF (w->'written'->>'added')::int<>0 OR (w->'written'->>'reopened')::int<>0 OR (w->'written'->>'priority_raised')::int<>0
  OR (w->>'candidates')::int<>0 OR (w->'already_listed'->>'jobs')::int<3
 THEN RAISE EXCEPTION 'backlog second run %',w; END IF;
 -- The original writer still never lowers or re-opens anything.
 PERFORM public.context_catchup_request(false);
 IF (SELECT priority FROM public.context_catchup_jobs WHERE job_id=n)<>4 OR (SELECT done_at FROM public.context_catchup_jobs WHERE job_id=done_quiet) IS NULL
 THEN RAISE EXCEPTION 'backlog rows disturbed by context_catchup_request'; END IF;
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE w jsonb;
BEGIN
 PERFORM pg_temp.bl_policy();
 DELETE FROM public.context_catchup_jobs;
 PERFORM pg_temp.bl_ev(pg_temp.bl_job('BL-LIMIT-'||g,'lost'),'Old text '||g,make_interval(days=>100+g)) FROM generate_series(1,3) g;
 w:=public.context_catchup_request_backlog(5,false,1);
 IF (w->'written'->>'added')::int<>1 OR jsonb_array_length(w->'jobs')<>1 OR (w->>'more')::int<(w->>'candidates')::int-1
  OR (w->>'more')::int<2 OR (SELECT count(*) FROM public.context_catchup_jobs)<>1
 THEN RAISE EXCEPTION 'backlog limit %',w; END IF;
END $$;
ROLLBACK;

-- 6. Mode unread leaves receipted rows out; mode full still reads them. The
-- done marker still fires when nothing is left, and a receipted row the batch
-- never offered is refused by the revision store.
BEGIN;
DO $$
DECLARE u uuid; u2 uuid; f uuid; run uuid; claim jsonb; ids uuid[]; ev uuid; events jsonb; facts jsonb; res jsonb; replay uuid; lease uuid;
BEGIN
 PERFORM pg_temp.bl_policy();
 DELETE FROM public.context_catchup_jobs;
 u:=pg_temp.bl_job('BL-UNREAD','complete');
 PERFORM pg_temp.bl_ev(u,'Read text '||g,make_interval(days=>40,mins=>g)) FROM generate_series(1,3) g;
 run:=pg_temp.bl_read(u,'30 days');
 ev:=pg_temp.bl_ev(u,'Never read text','20 days');
 f:=pg_temp.bl_job('BL-FULL','complete');
 PERFORM pg_temp.bl_ev(f,'Read text '||g,make_interval(days=>40,mins=>g)) FROM generate_series(1,3) g;
 PERFORM pg_temp.bl_read(f,'30 days');
 PERFORM pg_temp.bl_ev(f,'Never read text','20 days');
 INSERT INTO public.context_catchup_jobs(job_id,job_number,priority,mode,scope) VALUES(u,'BL-UNREAD',4,'unread','backlog'),(f,'BL-FULL',4,'full','backlog');
 IF (SELECT count(*) FROM public.context_catchup_pending_rows(ARRAY[u]))<>1
  OR (SELECT id FROM public.context_catchup_pending_rows(ARRAY[u]))<>ev
  OR (SELECT count(*) FROM public.context_catchup_pending_rows(ARRAY[f]))<>4
 THEN RAISE EXCEPTION 'backlog pending rows by mode'; END IF;
 IF (public.context_job_cadence(u)->>'catchup_pending_count')::int<>1 OR NOT (public.context_job_cadence(u)->>'due')::boolean
 THEN RAISE EXCEPTION 'backlog unread job not due %',public.context_job_cadence(u); END IF;
 claim:=public.claim_context_extraction_run(u,pg_temp.bl_today(),'extraction');
 IF claim->>'outcome'<>'claimed' THEN RAISE EXCEPTION 'backlog claim %',claim; END IF;
 SELECT array_agg(id) INTO ids FROM public.context_extraction_events(u,25);
 IF ids IS DISTINCT FROM ARRAY[ev] THEN RAISE EXCEPTION 'backlog unread batch %',ids; END IF;
 IF NOT public.finish_context_extraction_run((claim->'run'->>'id')::uuid,(claim->'run'->>'lease_token')::uuid,'done',ids,10,1,0,0,NULL,NULL)
 THEN RAISE EXCEPTION 'backlog finish refused'; END IF;
 IF (SELECT done_run_id FROM public.context_catchup_jobs WHERE job_id=u) IS DISTINCT FROM (claim->'run'->>'id')::uuid
  OR EXISTS(SELECT 1 FROM public.context_catchup_pending_rows(ARRAY[u])) OR (public.context_job_cadence(u)->>'due')::boolean
 THEN RAISE EXCEPTION 'backlog done marker did not fire'; END IF;
 IF (SELECT done_at FROM public.context_catchup_jobs WHERE job_id=f) IS NOT NULL THEN RAISE EXCEPTION 'backlog full job marked done'; END IF;
 -- A listed, pending unread-mode job: a receipted row offered to the store is
 -- refused, because it is not pending.
 u2:=pg_temp.bl_job('BL-UNREAD-2','complete');
 PERFORM pg_temp.bl_ev(u2,'Read text','40 days'); PERFORM pg_temp.bl_read(u2,'30 days');
 PERFORM pg_temp.bl_ev(u2,'Never read text','20 days');
 INSERT INTO public.context_catchup_jobs(job_id,job_number,priority,mode,scope) VALUES(u2,'BL-UNREAD-2',4,'unread','backlog');
 SELECT jsonb_agg(to_jsonb(e)) INTO events FROM public.business_events e WHERE e.job_id=u2 AND e.payload->>'body'='Read text';
 facts:=jsonb_build_array(jsonb_build_object('kind','note','text','Stale','confidence',0.9,'source_event_ids',jsonb_build_array(events->0->>'id')));
 replay:=gen_random_uuid(); lease:=gen_random_uuid();
 INSERT INTO public.context_extraction_runs(id,job_id,run_date,phase,status,run_seq,lease_token,lease_expires_at)
  VALUES(replay,u2,pg_temp.bl_today(),'extraction','running',1,lease,now()+interval '30 minutes');
 res:=public.persist_luna_context_revision(replay,lease,u2,events,facts,'[]','[]','luna_v2',10);
 IF res->>'outcome'<>'held' OR res->>'reason'<>'source_already_processed' THEN RAISE EXCEPTION 'backlog unread mode let a receipted row in %',res; END IF;
END $$;
ROLLBACK;

-- 7. Order: a live-due job still reads before any catch-up job, and tier 1
-- catch-up before tier 5.
BEGIN;
DO $$
DECLARE live_job uuid; t1 uuid; t5 uuid; got uuid[];
BEGIN
 PERFORM pg_temp.bl_policy();
 DELETE FROM public.context_catchup_jobs;
 t5:=pg_temp.bl_job('BL-ORDER-T5','lost'); PERFORM pg_temp.bl_ev(t5,'Old text','300 days');
 t1:=pg_temp.bl_job('BL-ORDER-T1','complete'); PERFORM pg_temp.bl_ev(t1,'Old text','12 days');
 PERFORM pg_temp.bl_inv(t1,'ACCREC','AUTHORISED',150);
 live_job:=pg_temp.bl_job('BL-ORDER-LIVE','scheduled'); PERFORM pg_temp.bl_ev(live_job,'Live message','20 minutes',false);
 PERFORM public.context_catchup_request_backlog(5,false,5000);
 PERFORM public.context_catchup_request_backlog(1,false,5000);
 IF (SELECT priority FROM public.context_catchup_jobs WHERE job_id=t5)<>5 OR (SELECT priority FROM public.context_catchup_jobs WHERE job_id=t1)<>1
 THEN RAISE EXCEPTION 'backlog order fixture'; END IF;
 SELECT array_agg(c.job_id ORDER BY c.ord) INTO got FROM public.context_extraction_candidates(400) WITH ORDINALITY c(job_id,ord)
  WHERE c.job_id IN (live_job,t1,t5);
 IF got IS DISTINCT FROM ARRAY[live_job,t1,t5] THEN RAISE EXCEPTION 'backlog order %',got; END IF;
END $$;
ROLLBACK;
