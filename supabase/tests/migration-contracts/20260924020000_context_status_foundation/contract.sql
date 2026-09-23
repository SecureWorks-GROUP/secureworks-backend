-- F1 context foundation contract. Every fixture write is rolled back.
-- Row labels follow the design notes (sms.md R1 and R17, cadence.md R6 and
-- R13); ids, job numbers and text are synthetic.
-- Byte-for-byte copy of the 20260917210000 context_pipeline_status() body.
-- The named row for F1 is "status output identical to today's for existing
-- keys": the composer is compared against this on the same fixtures, in the
-- same transaction (so as_of is the same instant).
CREATE FUNCTION pg_temp.legacy_context_pipeline_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d date:=(now() AT TIME ZONE 'Australia/Perth')::date; switches jsonb; queue jsonb; calls integer; call_state text:='available'; ready integer;
BEGIN
 SELECT to_jsonb(s) INTO switches FROM public.automation_switches s WHERE id=1;
 SELECT jsonb_object_agg(status,n) INTO queue FROM (SELECT coalesce(e.attribution_status,'unknown') status,count(*) n
 FROM public.business_events e WHERE e.attribution_status NOT IN ('empty','automated')
 AND NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r WHERE r.event_id=e.id AND r.job_id=e.job_id AND r.extractor_version='luna_v2')
 GROUP BY e.attribution_status) q;
 BEGIN
  EXECUTE 'SELECT count(*) FROM public.context_model_call_reservations WHERE run_date=$1' INTO calls USING d;
 EXCEPTION WHEN OTHERS THEN calls:=NULL;call_state:='unavailable'; END;
 SELECT count(*) INTO ready FROM public.context_extraction_candidates(400);
 RETURN jsonb_build_object('as_of',now(),'run_date',d,'switches',switches,
  'lanes',jsonb_build_object('capture',public.automation_lane_enabled('capture'),'attribution',public.automation_lane_enabled('attribution'),'extraction',public.automation_lane_enabled('extraction')),
  'runs_used',(SELECT count(*) FROM public.context_extraction_runs WHERE run_date=d AND phase='extraction'),'run_cap',400,
  'runs_by_status',(SELECT coalesce(jsonb_object_agg(status,n),'{}'::jsonb) FROM (SELECT status,count(*) n FROM public.context_extraction_runs WHERE run_date=d AND phase='extraction' GROUP BY status) s),
  'failed_by_error',(SELECT coalesce(jsonb_object_agg(coalesce(nullif(error,''),'(none)'),n),'{}'::jsonb) FROM (SELECT error,count(*) n FROM public.context_extraction_runs WHERE run_date=d AND phase='extraction' AND status='failed' GROUP BY error) s),
  'model_calls_used',calls,'model_call_cap',400,'model_call_budget_state',call_state,
  'evidence_by_attribution_status',coalesce(queue,'{}'::jsonb),'ready_jobs',ready,'ready_jobs_is_lower_bound',ready=400,
  'admin_bucket_size',(SELECT count(*) FROM public.business_events WHERE attribution_status='admin_bucket'),
  'missing_event_time',(SELECT count(*) FROM public.business_events WHERE event_at IS NULL AND occurred_at IS NULL AND attribution_status NOT IN ('empty','automated')),
  'oldest_pending_event_at',(SELECT min(coalesce(e.event_at, e.occurred_at)) FROM public.business_events e WHERE e.attribution_status NOT IN ('empty','automated') AND NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r WHERE r.event_id=e.id AND r.job_id=e.job_id AND r.extractor_version='luna_v2')),
  'last_pass_finished_at',(SELECT max(finished_at) FROM public.context_pass_days WHERE status='done'),
  'today_pass',(SELECT to_jsonb(p) FROM public.context_pass_days p WHERE run_date=d),
  'coverage',public.context_coverage());
END $$;

-- Insert a row through the real BEFORE INSERT ladder, then set the placement
-- state the later slices will write, the way they will write it (UPDATE).
CREATE FUNCTION pg_temp.f1_event(p_job uuid,p_contact text,p_status text,p_candidates uuid[],p_at timestamptz,p_body text,
 p_source text DEFAULT 'f1_contract') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE new_id uuid;
BEGIN
 INSERT INTO public.business_events(job_id,match_method,payload,occurred_at,contact_id,direction,source)
  VALUES(p_job,'direct_job_id',jsonb_build_object('body',p_body),p_at,p_contact,'inbound',p_source) RETURNING business_events.id INTO new_id;
 UPDATE public.business_events SET job_id=p_job,contact_id=p_contact,attribution_status=p_status,candidate_job_ids=p_candidates,
  event_at=p_at,attribution_confidence=CASE WHEN p_job IS NULL THEN NULL ELSE 1 END,source=p_source
 WHERE business_events.id=new_id;
 RETURN new_id;
END $$;

BEGIN;

-- 1. Grants: no PUBLIC, anon or authenticated execute on any callable context_*
-- function or on record_capture_run; service_role holds every F1 function.
DO $$
DECLARE f regprocedure;
BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND (p.proname LIKE 'context\_%' OR p.proname='record_capture_run') AND p.prorettype<>'trigger'::regtype LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE')
  THEN RAISE EXCEPTION 'f1 public execute on %',f; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_linked_status(text)','public.context_unplaced_for_job(uuid)',
  'public.context_source_freshness_policy()','public.context_in_business_hours(timestamptz)','public.context_business_minutes(timestamptz,timestamptz)',
  'public.context_source_freshness()','public.context_ready_jobs_count(integer)','public.context_core_status()','public.context_cadence_status()','public.context_ghl_capture_status()',
  'public.context_booking_capture_status()','public.context_parties_status()','public.context_pipeline_status()','public.record_capture_run(jsonb)']::regprocedure[] LOOP
  IF NOT has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'f1 service_role missing execute on %',f; END IF;
  -- The two per-row helpers deliberately carry no SET clause so they inline;
  -- they are SECURITY INVOKER SQL with every operator schema-qualified.
  IF f IN ('public.context_linked_status(text)'::regprocedure,'public.context_in_business_hours(timestamptz)'::regprocedure) THEN
   IF (SELECT proconfig IS NOT NULL OR prosecdef OR prolang<>(SELECT oid FROM pg_language WHERE lanname='sql') FROM pg_proc WHERE oid=f)
   THEN RAISE EXCEPTION 'f1 % must be inlinable invoker SQL without a SET clause',f; END IF;
  ELSIF (SELECT proconfig FROM pg_proc WHERE oid=f) IS NULL THEN RAISE EXCEPTION 'f1 function without fixed search_path %',f; END IF;
 END LOOP;
 -- context_capture_runs: RLS on; service_role reads but never writes directly.
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.context_capture_runs'::regclass) THEN RAISE EXCEPTION 'f1 capture runs RLS off'; END IF;
 IF has_table_privilege('anon','public.context_capture_runs','SELECT') OR has_table_privilege('authenticated','public.context_capture_runs','SELECT')
  OR has_table_privilege('anon','public.context_capture_runs','INSERT') OR has_table_privilege('authenticated','public.context_capture_runs','INSERT')
  OR has_table_privilege('service_role','public.context_capture_runs','INSERT') OR has_table_privilege('service_role','public.context_capture_runs','UPDATE')
  OR has_table_privilege('service_role','public.context_capture_runs','DELETE')
  OR NOT has_table_privilege('service_role','public.context_capture_runs','SELECT')
 THEN RAISE EXCEPTION 'f1 capture runs grants wrong'; END IF;
END $$;

-- 2. Statuses and the one linked definition.
DO $$
DECLARE s text; j uuid:=gen_random_uuid(); e uuid;
 linked text[]:=ARRAY['direct','thread','single_open','single_line','luna','content_ref','party'];
 not_linked text[]:=ARRAY['pending_luna','unplaced','admin_bucket','empty','automated','luna_undecided','bogus'];
BEGIN
 FOREACH s IN ARRAY linked LOOP
  IF public.context_linked_status(s) IS DISTINCT FROM true THEN RAISE EXCEPTION 'f1 % should be linked',s; END IF;
 END LOOP;
 FOREACH s IN ARRAY not_linked LOOP
  IF public.context_linked_status(s) IS DISTINCT FROM false THEN RAISE EXCEPTION 'f1 % should not be linked',s; END IF;
 END LOOP;
 IF public.context_linked_status(NULL) IS DISTINCT FROM false THEN RAISE EXCEPTION 'f1 null status must read false, never null'; END IF;

 INSERT INTO public.jobs(id,org_id,status,type,job_number) VALUES(j,'00000000-0000-0000-0000-000000000001','accepted','fencing','F1-STATUS-'||j);
 FOREACH s IN ARRAY ARRAY['content_ref','party','unplaced'] LOOP
  e:=pg_temp.f1_event(CASE WHEN s='unplaced' THEN NULL ELSE j END,'f1-status-contact',s,CASE WHEN s='unplaced' THEN ARRAY[j] END,now(),'status '||s);
  IF (SELECT attribution_status FROM public.business_events WHERE id=e) IS DISTINCT FROM s THEN RAISE EXCEPTION 'f1 status % not stored',s; END IF;
 END LOOP;
 -- The cadence review's other name for unplaced is not a status (X2: one name).
 BEGIN
  UPDATE public.business_events SET attribution_status='luna_undecided' WHERE id=e;
  RAISE EXCEPTION 'f1 luna_undecided accepted' USING ERRCODE='ZX001';
 EXCEPTION WHEN check_violation THEN NULL; END;

 -- candidate_job_ids is uuid[] behind a partial GIN index.
 IF (SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attrelid='public.business_events'::regclass AND attname='candidate_job_ids') IS DISTINCT FROM 'uuid[]'
 THEN RAISE EXCEPTION 'f1 candidate_job_ids type'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='business_events' AND indexname='business_events_candidate_job_ids'
  AND indexdef ILIKE '%USING gin (candidate_job_ids)%' AND indexdef ILIKE '%WHERE (candidate_job_ids IS NOT NULL)%')
 THEN RAISE EXCEPTION 'f1 candidate GIN index missing'; END IF;
END $$;

-- 3. Named row: status output identical to today's for existing keys. Fixtures
-- cover every core section, including rows in the new statuses.
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; j uuid:=gen_random_uuid(); k uuid:=gen_random_uuid();
 legacy jsonb; composed jsonb; core jsonb; key text; d date:=(now() AT TIME ZONE 'Australia/Perth')::date;
 new_keys text[]:=ARRAY['cadence','capture_sources','ghl_capture','booking_capture','parties','alarms'];
BEGIN
 -- F1b (same owner, 20260924152100) adds four blocks to the composer; the
 -- runner applies it before this contract. Its own contract checks them.
 IF to_regprocedure('public.context_bucket_status()') IS NOT NULL THEN
  new_keys:=new_keys||ARRAY['email_capture','transcript_capture','money','bucket'];
 END IF;
 -- F-ACT (same owner, 20260924201000) adds one core key, actor_missing; its
 -- own contract checks it. Every other core key must still be the 17 Sep value.
 IF to_regprocedure('public.context_actor_missing_status()') IS NOT NULL THEN
  new_keys:=new_keys||ARRAY['actor_missing'];
 END IF;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id) VALUES
  (j,org,'accepted','fencing','F1-SAME-A-'||j,'f1-same-contact'),(k,org,'accepted','fencing','F1-SAME-B-'||k,'f1-same-contact');
 INSERT INTO public.xero_invoices(org_id,xero_invoice_id,invoice_number,invoice_type,status,amount_due,job_id,updated_at)
  VALUES(org,'f1-'||j,'F1-INV-'||j,'ACCREC','AUTHORISED',50,j,now());
 PERFORM pg_temp.f1_event(j,'f1-same-contact','direct',NULL,now()-interval '3 days','Can you confirm the start date?');
 PERFORM pg_temp.f1_event(j,'f1-same-contact','content_ref',NULL,now()-interval '2 days','Is the price still the same?');
 PERFORM pg_temp.f1_event(NULL,'f1-same-contact','pending_luna',ARRAY[j,k],now()-interval '1 day','Which quote is which?');
 PERFORM pg_temp.f1_event(NULL,'f1-same-contact','unplaced',ARRAY[j,k],now()-interval '5 hours','Got both, thanks');
 PERFORM pg_temp.f1_event(NULL,'f1-same-contact','admin_bucket',NULL,now()-interval '4 hours','Hello');
 INSERT INTO public.context_extraction_runs(job_id,run_date,phase,status,error) VALUES
  (j,d,'extraction','failed','process_failed'),(k,d,'extraction','done',NULL);

 legacy:=pg_temp.legacy_context_pipeline_status();
 composed:=public.context_pipeline_status();
 core:=public.context_core_status()-'actor_missing';
 IF core IS DISTINCT FROM legacy THEN RAISE EXCEPTION 'f1 core differs from the 17 Sep body: % vs %',core,legacy; END IF;
 FOR key IN SELECT jsonb_object_keys(legacy) LOOP
  IF NOT composed ? key OR composed->key IS DISTINCT FROM legacy->key
  THEN RAISE EXCEPTION 'f1 existing key % changed: % vs %',key,composed->key,legacy->key; END IF;
 END LOOP;
 IF (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(composed) x) IS DISTINCT FROM
    (SELECT array_agg(x ORDER BY x) FROM (SELECT jsonb_object_keys(legacy) x UNION SELECT unnest(new_keys)) u)
 THEN RAISE EXCEPTION 'f1 composer keys: %',(SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(composed) x); END IF;
 -- A block is null exactly while its F1 stub stands; an owning slice that has
 -- replaced its stub (the runner applies every later migration first) returns
 -- an object instead.
 IF EXISTS(SELECT 1 FROM (VALUES ('cadence','context_cadence_status'),('ghl_capture','context_ghl_capture_status'),
   ('booking_capture','context_booking_capture_status'),('parties','context_parties_status')) b(block,fn)
  WHERE CASE WHEN (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.'||b.fn||'()'))='155104bfb08b8b3c2f98bdec089d4ee4'
   THEN composed->b.block<>'null'::jsonb ELSE jsonb_typeof(composed->b.block)<>'object' END)
 THEN RAISE EXCEPTION 'f1 unbuilt blocks must be null %',composed; END IF;
 IF jsonb_typeof(composed->'alarms')<>'array' OR jsonb_typeof(composed->'capture_sources')<>'object'
 THEN RAISE EXCEPTION 'f1 alarms or capture_sources shape %',composed; END IF;
 -- The new statuses are visible in the existing queue count, exactly as the old body counts them.
 IF coalesce((composed#>>'{evidence_by_attribution_status,unplaced}')::int,0)<1 OR coalesce((composed#>>'{evidence_by_attribution_status,content_ref}')::int,0)<1
 THEN RAISE EXCEPTION 'f1 new statuses missing from the queue count %',composed->'evidence_by_attribution_status'; END IF;
END $$;

-- 4. Composer: block alarms concatenate with their block; a failing block is
-- isolated and reported; a failing core still fails the read.
DO $$
DECLARE composed jsonb; legacy jsonb; key text;
BEGIN
 CREATE OR REPLACE FUNCTION public.context_cadence_status() RETURNS jsonb LANGUAGE sql STABLE AS
  $f$ SELECT '{"due_jobs":3,"alarms":[{"key":"cadence_breach","severity":"warning","since":"2026-09-23T00:00:00Z","what_to_do":"x"}]}'::jsonb $f$;
 CREATE OR REPLACE FUNCTION public.context_parties_status() RETURNS jsonb LANGUAGE plpgsql STABLE AS
  $f$ BEGIN RAISE EXCEPTION 'broken block'; END $f$;
 composed:=public.context_pipeline_status();
 legacy:=pg_temp.legacy_context_pipeline_status();
 FOR key IN SELECT jsonb_object_keys(legacy) LOOP
  IF composed->key IS DISTINCT FROM legacy->key THEN RAISE EXCEPTION 'f1 a failing block changed core key %',key; END IF;
 END LOOP;
 IF composed#>>'{cadence,due_jobs}'<>'3' THEN RAISE EXCEPTION 'f1 cadence block not composed %',composed->'cadence'; END IF;
 IF composed->'parties'<>'{"error":"P0001"}'::jsonb THEN RAISE EXCEPTION 'f1 failing block not isolated %',composed->'parties'; END IF;
 IF NOT composed->'alarms' @> '[{"block":"cadence","key":"cadence_breach"}]'::jsonb
  OR NOT composed->'alarms' @> '[{"block":"parties","key":"status_block_failed","code":"P0001"}]'::jsonb
 THEN RAISE EXCEPTION 'f1 alarms not concatenated %',composed->'alarms'; END IF;
 CREATE OR REPLACE FUNCTION public.context_core_status() RETURNS jsonb LANGUAGE plpgsql STABLE AS
  $f$ BEGIN RAISE EXCEPTION 'broken core'; END $f$;
 BEGIN
  PERFORM public.context_pipeline_status();
  RAISE EXCEPTION 'f1 core failure hidden' USING ERRCODE='ZX001';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'broken core' THEN RAISE; END IF; END;
END $$;
ROLLBACK;

BEGIN;
-- 5. context_unplaced_for_job, on the design's rows.
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001';
 r1_a uuid:=gen_random_uuid(); r1_b uuid:=gen_random_uuid(); other uuid:=gen_random_uuid();
 r6 uuid:=gen_random_uuid(); r13 uuid:=gen_random_uuid(); holding uuid:=gen_random_uuid();
 e_r1 uuid; e_r17a uuid; e_r17b uuid; e_bucket uuid; e_hold uuid; e_hold_empty uuid; e_direct uuid; e_luna uuid; e_other_bucket uuid; e_r6 uuid;
 got uuid[];
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,metadata) VALUES
  (r1_a,org,'quoted','fencing','F1-R1-A','f1-r1-contact','{}'),
  (r1_b,org,'quoted','fencing','F1-R1-B','f1-r1-contact','{}'),
  (other,org,'quoted','fencing','F1-R1-OTHER','f1-other-contact','{}'),
  (r6,org,'draft','patio','F1-R6',NULL,'{}'),
  (r13,org,'accepted','fencing','F1-R13','f1-r13-contact','{}'),
  (holding,org,'archived','fencing','F1-HOLDING',NULL,'{"do_not_schedule":true,"purpose":"pdf_unlock_bucket"}');
 -- sms R1: one customer message, two open fencing quotes, under review with both stored.
 e_r1:=pg_temp.f1_event(NULL,'f1-r1-contact','pending_luna',ARRAY[r1_a,r1_b],now()-interval '3 hours','Have not received all the quotes yet?');
 -- sms R17: two messages Luna left unplaced across both option quotes.
 e_r17a:=pg_temp.f1_event(NULL,'f1-r1-contact','unplaced',ARRAY[r1_a,r1_b],now()-interval '2 days','Confirming receipt of both quote emails');
 e_r17b:=pg_temp.f1_event(NULL,'f1-r1-contact','unplaced',ARRAY[r1_a,r1_b],now()-interval '1 day','We prefer the neighbour option');
 -- The same contact's admin-bucket row counts for every job of that contact.
 e_bucket:=pg_temp.f1_event(NULL,'f1-r1-contact','admin_bucket',NULL,now()-interval '1 hour','Call me back please');
 -- Not included: a row already on the job, a placed luna row whose old
 -- candidates named the job, another contact's bucket.
 e_direct:=pg_temp.f1_event(r1_a,'f1-r1-contact','direct',NULL,now()-interval '30 minutes','About F1-R1-A');
 e_luna:=pg_temp.f1_event(r1_b,'f1-r1-contact','luna',ARRAY[r1_a,r1_b],now()-interval '20 minutes','Placed by Luna');
 e_other_bucket:=pg_temp.f1_event(NULL,'f1-other-contact','admin_bucket',NULL,now()-interval '10 minutes','Someone else');
 -- cadence R13: the customer's texts parked on the holding job; an empty row there is not a message.
 e_hold:=pg_temp.f1_event(holding,'f1-r13-contact','single_open',NULL,now()-interval '4 days','When are you starting?');
 e_hold_empty:=pg_temp.f1_event(holding,'f1-r13-contact','empty',NULL,now()-interval '4 days','');
 -- cadence R6: a draft with no contact still sees rows that name it as a candidate.
 e_r6:=pg_temp.f1_event(NULL,'f1-r6-contact','pending_luna',ARRAY[r6,r1_a],now()-interval '5 days','Patio or fence?');

 SELECT array_agg(id) INTO got FROM public.context_unplaced_for_job(r1_a);
 IF got IS DISTINCT FROM ARRAY[e_bucket,e_r1,e_r17b,e_r17a,e_r6] THEN RAISE EXCEPTION 'f1 R1 job A lane (newest first) %',got; END IF;
 SELECT array_agg(id) INTO got FROM public.context_unplaced_for_job(r1_b);
 IF got IS DISTINCT FROM ARRAY[e_bucket,e_r1,e_r17b,e_r17a] THEN RAISE EXCEPTION 'f1 R1 job B lane %',got; END IF;
 SELECT array_agg(id) INTO got FROM public.context_unplaced_for_job(other);
 IF got IS DISTINCT FROM ARRAY[e_other_bucket] THEN RAISE EXCEPTION 'f1 other contact lane %',got; END IF;
 SELECT array_agg(id) INTO got FROM public.context_unplaced_for_job(r13);
 IF got IS DISTINCT FROM ARRAY[e_hold] THEN RAISE EXCEPTION 'f1 R13 holding-job arm %',got; END IF;
 SELECT array_agg(id) INTO got FROM public.context_unplaced_for_job(r6);
 IF got IS DISTINCT FROM ARRAY[e_r6] THEN RAISE EXCEPTION 'f1 R6 contactless job %',got; END IF;
 IF EXISTS(SELECT 1 FROM public.context_unplaced_for_job(holding)) THEN RAISE EXCEPTION 'f1 holding job reads itself'; END IF;
 IF EXISTS(SELECT 1 FROM public.context_unplaced_for_job(NULL)) OR EXISTS(SELECT 1 FROM public.context_unplaced_for_job(gen_random_uuid()))
 THEN RAISE EXCEPTION 'f1 unknown job returned rows'; END IF;
 -- Once placed, a row leaves every lane.
 UPDATE public.business_events SET job_id=r1_a,attribution_status='luna',attribution_confidence=0.9 WHERE id=e_r1;
 IF EXISTS(SELECT 1 FROM public.context_unplaced_for_job(r1_b) WHERE id=e_r1) THEN RAISE EXCEPTION 'f1 placed row still unplaced'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 6. Luna custody accepts content_ref and party sources, still refuses
-- unplaced, and the current-facts view agrees with the writer.
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; d date:=(now() AT TIME ZONE 'Australia/Perth')::date;
 j uuid; s text; e uuid; ev jsonb; claimed jsonb; run uuid; tok uuid; result jsonb; fact uuid;
BEGIN
 FOREACH s IN ARRAY ARRAY['content_ref','party'] LOOP
  j:=gen_random_uuid();
  INSERT INTO public.jobs(id,org_id,status,type,job_number) VALUES(j,org,'quoted','fencing','F1-CUSTODY-'||s);
  e:=pg_temp.f1_event(j,'f1-custody-contact',s,NULL,now()-interval '1 hour','We would like to go ahead with the quote.');
  SELECT to_jsonb(b) INTO ev FROM public.business_events b WHERE b.id=e;
  claimed:=public.claim_context_extraction_run(j,d,'extraction'); run:=(claimed->'run'->>'id')::uuid; tok:=(claimed->'run'->>'lease_token')::uuid;
  result:=public.persist_luna_context_revision(run,tok,j,jsonb_build_array(ev),
   jsonb_build_array(jsonb_build_object('kind','note','text','Customer wants to proceed.','confidence',0.9,'source_event_ids',jsonb_build_array(e))),'[]','[]');
  IF result->>'outcome'<>'inserted' THEN RAISE EXCEPTION 'f1 % source refused by custody %',s,result; END IF;
  fact:=(result->'fact_ids'->>0)::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE id=fact) THEN RAISE EXCEPTION 'f1 % fact persisted but hidden by the view',s; END IF;
  -- The view re-checks the source: a row that leaves the job's linked set hides its facts.
  -- Retraction is still read from the event's metadata (the view now reads
  -- b.metadata instead of serialising the whole row): each marker hides the
  -- fact, and clearing it shows the fact again.
  UPDATE public.business_events SET metadata=coalesce(metadata,'{}'::jsonb)||'{"retracted_at":"2026-09-23T10:00:00Z"}' WHERE id=e;
  IF EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE id=fact) THEN RAISE EXCEPTION 'f1 % fact visible after metadata.retracted_at',s; END IF;
  UPDATE public.business_events SET metadata=(metadata-'retracted_at')||'{"retracted":true}' WHERE id=e;
  IF EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE id=fact) THEN RAISE EXCEPTION 'f1 % fact visible after metadata.retracted',s; END IF;
  UPDATE public.business_events SET metadata=metadata-'retracted' WHERE id=e;
  IF NOT EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE id=fact) THEN RAISE EXCEPTION 'f1 % fact hidden after retraction cleared',s; END IF;
  UPDATE public.business_events SET attribution_status='unplaced' WHERE id=e;
  IF EXISTS(SELECT 1 FROM public.current_job_context_facts WHERE id=fact) THEN RAISE EXCEPTION 'f1 % fact visible after its source became unplaced',s; END IF;
 END LOOP;
 j:=gen_random_uuid();
 INSERT INTO public.jobs(id,org_id,status,type,job_number) VALUES(j,org,'quoted','fencing','F1-CUSTODY-UNPLACED');
 e:=pg_temp.f1_event(j,'f1-custody-contact','unplaced',ARRAY[j],now()-interval '1 hour','Thanks.');
 SELECT to_jsonb(b) INTO ev FROM public.business_events b WHERE b.id=e;
 claimed:=public.claim_context_extraction_run(j,d,'extraction'); run:=(claimed->'run'->>'id')::uuid; tok:=(claimed->'run'->>'lease_token')::uuid;
 BEGIN
  PERFORM public.persist_luna_context_revision(run,tok,j,jsonb_build_array(ev),
   jsonb_build_array(jsonb_build_object('kind','note','text','Thanks.','confidence',0.9,'source_event_ids',jsonb_build_array(e))),'[]','[]');
  RAISE EXCEPTION 'f1 unplaced source accepted' USING ERRCODE='ZX001';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'luna_source_attribution_rejected' THEN RAISE; END IF; END;
END $$;
ROLLBACK;

BEGIN;
-- 7. Capture freshness and the capture_quiet alarm.
DO $$
DECLARE snap jsonb; composed jsonb; src jsonb; quiet_at timestamptz; busy_rows int;
BEGIN
 -- Business-minute arithmetic: Sat 09:00 to Mon 09:00 Perth is 540 (Sat) + 0 (Sun) + 120 (Mon).
 IF public.context_business_minutes('2026-09-19 09:00+08','2026-09-21 09:00+08')<>660
  OR public.context_business_minutes('2026-09-23 17:00+08','2026-09-24 08:00+08')<>120
  OR public.context_business_minutes('2026-09-20 08:00+08','2026-09-20 17:00+08')<>0
  OR public.context_business_minutes('2026-09-23 12:00+08','2026-09-23 11:00+08')<>0
  OR public.context_business_minutes(NULL,now())<>0
 THEN RAISE EXCEPTION 'f1 business minutes arithmetic'; END IF;
 IF NOT public.context_in_business_hours('2026-09-19 07:00+08') OR public.context_in_business_hours('2026-09-19 18:00+08')
  OR public.context_in_business_hours('2026-09-20 12:00+08') THEN RAISE EXCEPTION 'f1 business hours edges'; END IF;

 -- f1_busy_quiet: six rows an hour through business hours, then nothing for ten days.
 quiet_at:=now()-interval '10 days';
 INSERT INTO public.business_events(match_method,payload,occurred_at,source)
  SELECT 'none',jsonb_build_object('body','busy '||g),g,'f1_busy_quiet'
  FROM generate_series(quiet_at-interval '14 days',quiet_at,interval '10 minutes') g WHERE public.context_in_business_hours(g);
 UPDATE public.business_events SET context_captured_at=occurred_at WHERE source='f1_busy_quiet';
 GET DIAGNOSTICS busy_rows=ROW_COUNT;
 IF busy_rows<300 THEN RAISE EXCEPTION 'f1 busy fixture too small %',busy_rows; END IF;
 -- f1_busy_live: the same rate, still writing now.
 INSERT INTO public.business_events(match_method,payload,occurred_at,source)
  SELECT 'none',jsonb_build_object('body','live '||g),g,'f1_busy_live'
  FROM generate_series(now()-interval '14 days',now(),interval '10 minutes') g WHERE public.context_in_business_hours(g) OR g=now();
 INSERT INTO public.business_events(match_method,payload,occurred_at,source) VALUES('none','{"body":"latest"}',now(),'f1_busy_live');
 UPDATE public.business_events SET context_captured_at=occurred_at WHERE source='f1_busy_live';
 -- f1_sparse: one row a day, silent ten days: never normally active, never alarms.
 INSERT INTO public.business_events(match_method,payload,occurred_at,source)
  SELECT 'none','{"body":"sparse"}',g,'f1_sparse' FROM generate_series(quiet_at-interval '14 days',quiet_at,interval '1 day') g;
 UPDATE public.business_events SET context_captured_at=occurred_at WHERE source='f1_sparse';
 -- f1_backfill_only: a history load is not capture, whatever its volume.
 INSERT INTO public.business_events(match_method,payload,occurred_at,source,metadata)
  SELECT 'none','{"body":"history"}',g,'f1_backfill_only','{"capture_mode":"backfill"}'
  FROM generate_series(quiet_at-interval '14 days',quiet_at,interval '10 minutes') g WHERE public.context_in_business_hours(g);
 UPDATE public.business_events SET context_captured_at=occurred_at WHERE source='f1_backfill_only';

 snap:=public.context_source_freshness();
 IF snap->'policy'<>public.context_source_freshness_policy() OR (snap#>>'{policy,quiet_business_minutes}')::int<>120
 THEN RAISE EXCEPTION 'f1 freshness policy not published %',snap->'policy'; END IF;
 SELECT value INTO src FROM jsonb_array_elements(snap->'sources') WHERE value->>'source'='f1_busy_quiet';
 IF src IS NULL OR (src->>'normally_active')::boolean IS NOT TRUE OR (src->>'quiet')::boolean IS NOT TRUE
  OR (src->>'quiet_business_minutes')::int<120 OR (src->>'rows_per_business_hour')::numeric<5
 THEN RAISE EXCEPTION 'f1 busy quiet source %',src; END IF;
 SELECT value INTO src FROM jsonb_array_elements(snap->'sources') WHERE value->>'source'='f1_busy_live';
 IF src IS NULL OR (src->>'normally_active')::boolean IS NOT TRUE OR (src->>'quiet')::boolean IS NOT FALSE
 THEN RAISE EXCEPTION 'f1 live source %',src; END IF;
 SELECT value INTO src FROM jsonb_array_elements(snap->'sources') WHERE value->>'source'='f1_sparse';
 IF src IS NULL OR (src->>'normally_active')::boolean IS NOT FALSE OR (src->>'quiet')::boolean IS NOT FALSE
 THEN RAISE EXCEPTION 'f1 sparse source %',src; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(snap->'sources') WHERE value->>'source'='f1_backfill_only')
 THEN RAISE EXCEPTION 'f1 backfill rows counted as capture'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(snap->'alarms') WHERE value->>'source' LIKE 'f1\_%')<>1
  OR NOT snap->'alarms' @> jsonb_build_array(jsonb_build_object('key','capture_quiet','source','f1_busy_quiet','severity','warning'))
 THEN RAISE EXCEPTION 'f1 capture_quiet alarm %',snap->'alarms'; END IF;
 IF (SELECT (value->>'since')::timestamptz FROM jsonb_array_elements(snap->'alarms') WHERE value->>'source'='f1_busy_quiet')
    IS DISTINCT FROM (SELECT max(context_captured_at) FROM public.business_events WHERE source='f1_busy_quiet')
 THEN RAISE EXCEPTION 'f1 capture_quiet since is not the last capture'; END IF;
 -- The alarm reaches the composer, tagged with its block.
 composed:=public.context_pipeline_status();
 IF NOT composed->'alarms' @> '[{"block":"capture_sources","key":"capture_quiet","source":"f1_busy_quiet"}]'::jsonb
 THEN RAISE EXCEPTION 'f1 capture_quiet missing from composer alarms %',composed->'alarms'; END IF;
END $$;
ROLLBACK;

BEGIN;
-- 8. record_capture_run: the one writer of context_capture_runs.
DO $$
DECLARE r jsonb; run uuid; given uuid:=gen_random_uuid(); rec public.context_capture_runs; bad jsonb; expected text;
 before_runs bigint:=(SELECT count(*) FROM public.context_capture_runs);
BEGIN
 r:=public.record_capture_run('{"source":"ghl_message_reconcile","window_from":"2026-09-23T01:00:00Z","window_to":"2026-09-23T01:15:00Z"}');
 IF r->>'outcome'<>'created' OR r->>'status'<>'running' THEN RAISE EXCEPTION 'f1 run create %',r; END IF;
 run:=(r->>'run_id')::uuid;
 -- A page: cursor, watermark and counts saved; untouched keys kept.
 r:=public.record_capture_run(jsonb_build_object('run_id',run,'source','ghl_message_reconcile','cursor',jsonb_build_object('last_message_date','2026-09-23T01:10:00Z','conversation_id','c-1'),
  'watermark','2026-09-23T00:45:00Z','counts',jsonb_build_object('conversations_read',20,'items_seen',41,'inserted',3,'duplicates',38,'webhook_misses',3,'backlog_conversations',0)));
 SELECT * INTO rec FROM public.context_capture_runs WHERE id=run;
 IF r->>'outcome'<>'updated' OR rec.status<>'running' OR rec.window_from<>'2026-09-23T01:00:00Z' OR rec.watermark<>'2026-09-23T00:45:00Z'
  OR rec.counts->>'webhook_misses'<>'3' OR rec.cursor->>'conversation_id'<>'c-1' OR rec.finished_at IS NOT NULL
 THEN RAISE EXCEPTION 'f1 run page update % %',r,to_jsonb(rec); END IF;
 r:=public.record_capture_run(jsonb_build_object('run_id',run,'source','ghl_message_reconcile','status','succeeded'));
 SELECT * INTO rec FROM public.context_capture_runs WHERE id=run;
 IF rec.status<>'succeeded' OR rec.finished_at IS NULL OR rec.counts->>'inserted'<>'3' THEN RAISE EXCEPTION 'f1 run finish %',to_jsonb(rec); END IF;
 -- A finished run is immutable; an identical repeat is harmless.
 r:=public.record_capture_run(jsonb_build_object('run_id',run,'source','ghl_message_reconcile','status','succeeded'));
 IF r->>'outcome'<>'unchanged' THEN RAISE EXCEPTION 'f1 identical repeat %',r; END IF;
 FOR bad, expected IN SELECT payload, code FROM (VALUES
   (jsonb_build_object('run_id',run,'source','ghl_message_reconcile','status','failed','error_code','late_change'),'capture_run_finished'),
   (jsonb_build_object('run_id',run,'source','scope_booking'),'capture_run_source_mismatch'),
   ('{"source":"ghl_message_reconcile","body":"customer text"}'::jsonb,'capture_run_invalid'),
   ('{"source":"Bad Source"}'::jsonb,'capture_run_source_invalid'),
   ('{"source":"scope_booking","status":"done"}'::jsonb,'capture_run_status_invalid'),
   ('{"source":"scope_booking","counts":{"inserted":-1}}'::jsonb,'capture_run_counts_invalid'),
   ('{"source":"scope_booking","counts":{"inserted":1.5}}'::jsonb,'capture_run_counts_invalid'),
   ('{"source":"scope_booking","counts":{"inserted":"3"}}'::jsonb,'capture_run_counts_invalid'),
   ('{"source":"scope_booking","status":"failed"}'::jsonb,'capture_run_error_code_required'),
   ('{"source":"scope_booking","status":"failed","error_code":"Graph said: token expired for bob"}'::jsonb,'capture_run_error_code_invalid'),
   ('{"source":"scope_booking","window_from":"2026-09-23T02:00:00Z","window_to":"2026-09-23T01:00:00Z"}'::jsonb,'capture_run_invalid'),
   ('{"source":"scope_booking","watermark":"not a time"}'::jsonb,'capture_run_invalid'),
   ('[1]'::jsonb,'capture_run_invalid')) AS t(payload,code) LOOP
  BEGIN
   PERFORM public.record_capture_run(bad);
   RAISE EXCEPTION 'f1 run accepted %',bad USING ERRCODE='ZX001';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>expected THEN RAISE; END IF; END;
 END LOOP;
 -- A caller-chosen id creates exactly that run, so a retried first call converges.
 r:=public.record_capture_run(jsonb_build_object('run_id',given,'source','scope_booking','status','failed','error_code','graph_timeout'));
 IF r->>'run_id'<>given::text OR r->>'outcome'<>'created' OR r->>'status'<>'failed' THEN RAISE EXCEPTION 'f1 caller id %',r; END IF;
 r:=public.record_capture_run(jsonb_build_object('run_id',given,'source','scope_booking','status','failed','error_code','graph_timeout'));
 IF r->>'outcome'<>'unchanged' THEN RAISE EXCEPTION 'f1 caller id repeat %',r; END IF;
 IF (SELECT count(*) FROM public.context_capture_runs)-before_runs<>2 THEN RAISE EXCEPTION 'f1 refused calls wrote rows'; END IF;
END $$;
ROLLBACK;

-- 9. Only the intended objects moved. The other persist_luna_context_revision
-- overload is still the production body, the 9-arg writer is the production
-- body with the one linked-status predicate changed, the heartbeat body lives
-- on unchanged as context_core_status(), and every live attribution status is
-- still allowed.
BEGIN;
DO $$
DECLARE s text; j uuid:=gen_random_uuid(); e uuid;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.persist_luna_context_revision(text,text,jsonb,text,jsonb)'))
    IS DISTINCT FROM 'f8c4bd29bba0878396ee7626c21ee65d'
 THEN RAISE EXCEPTION 'f1 touched the 5-arg persist_luna_context_revision overload'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.persist_luna_context_revision(uuid,uuid,uuid,jsonb,jsonb,jsonb,jsonb,text,integer)'))
    IS DISTINCT FROM '2ef95a949f0aae99cc323abde10f2ee7'
 THEN RAISE EXCEPTION 'f1 9-arg persist_luna_context_revision is not the expected F1 body'; END IF;
 -- The core body is the production heartbeat body with exactly one line
 -- changed: the ready_jobs read.
 IF md5(replace(replace((SELECT prosrc FROM pg_proc WHERE oid=to_regprocedure('public.context_core_status()')),
    ' ready:=public.context_ready_jobs_count(400);',' SELECT count(*) INTO ready FROM public.context_extraction_candidates(400);'),
    -- F-ACT's one added key (20260924201000), when that migration has run.
    E',\n  ''actor_missing'',public.context_actor_missing_status());',');'))
    IS DISTINCT FROM '0fa6842cebf236e47b608a520c6c9fd1'
 THEN RAISE EXCEPTION 'f1 context_core_status() differs from the production heartbeat body beyond the ready_jobs read'; END IF;
 IF (SELECT count(*) FROM pg_proc WHERE proname='persist_luna_context_revision' AND pronamespace='public'::regnamespace)<>2
 THEN RAISE EXCEPTION 'f1 changed the number of persist_luna_context_revision overloads'; END IF;
 IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid='public.business_events'::regclass AND c.conname='business_events_attribution_status_check')
    IS DISTINCT FROM 'CHECK ((attribution_status = ANY (ARRAY[''direct''::text, ''thread''::text, ''single_open''::text, ''single_line''::text, ''luna''::text, ''admin_bucket''::text, ''pending_luna''::text, ''empty''::text, ''automated''::text, ''content_ref''::text, ''party''::text, ''unplaced''::text])))'
 THEN RAISE EXCEPTION 'f1 attribution status check is not the nine live values plus content_ref, party, unplaced'; END IF;
 INSERT INTO public.jobs(id,org_id,status,type,job_number) VALUES(j,'00000000-0000-0000-0000-000000000001','accepted','fencing','F1-LIVE-'||j);
 e:=pg_temp.f1_event(j,'f1-live-contact','direct',NULL,now(),'live status row');
 FOREACH s IN ARRAY ARRAY['direct','thread','single_open','single_line','luna','admin_bucket','pending_luna','empty','automated'] LOOP
  UPDATE public.business_events SET attribution_status=s WHERE id=e;
 END LOOP;
END $$;
ROLLBACK;

-- 10. Heartbeat cost guards (the live heartbeat hit the API statement timeout).
-- Both per-row helpers inline, and coverage's invoice filter has expression
-- statistics.
DO $$
DECLARE line text; plan text:='';
BEGIN
 FOR line IN EXECUTE 'EXPLAIN (VERBOSE, COSTS OFF) SELECT public.context_linked_status(x), public.context_in_business_hours(now()) FROM (VALUES (''direct''::text)) v(x)' LOOP
  plan:=plan||line||chr(10);
 END LOOP;
 IF plan LIKE '%context_linked_status%' OR plan LIKE '%context_in_business_hours%' THEN RAISE EXCEPTION 'f1 helpers not inlined: %',plan; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_statistic_ext WHERE stxname='xero_invoices_context_open_ar' AND stxrelid='public.xero_invoices'::regclass)
 THEN RAISE EXCEPTION 'f1 coverage invoice statistics missing'; END IF;
END $$;

BEGIN;
-- 11. ready_jobs equals the candidates read it replaces. One job per admission
-- rule, plus two ready jobs; context_ready_jobs_count must equal
-- least(count(context_extraction_candidates(cap)), cap) for every cap, with the
-- extraction lane on and off.
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; d date:=(now() AT TIME ZONE 'Australia/Perth')::date;
 ready1 uuid:=gen_random_uuid(); ready2 uuid:=gen_random_uuid(); holding uuid:=gen_random_uuid(); outbound_only uuid:=gen_random_uuid();
 blank uuid:=gen_random_uuid(); not_captured uuid:=gen_random_uuid(); receipted uuid:=gen_random_uuid(); done_today uuid:=gen_random_uuid();
 bucket uuid:=gen_random_uuid(); e uuid; claimed jsonb; cap int; base int; want int; got int;
BEGIN
 UPDATE public.automation_switches SET extraction=true WHERE id=1;
 base:=(SELECT count(*) FROM public.context_extraction_candidates(400));
 INSERT INTO public.jobs(id,org_id,status,type,job_number,metadata) VALUES
  (ready1,org,'quoted','fencing','F1-READY-1','{}'),(ready2,org,'quoted','fencing','F1-READY-2','{}'),
  (holding,org,'quoted','fencing','F1-READY-HOLD','{"do_not_schedule":"true"}'),(outbound_only,org,'quoted','fencing','F1-READY-OUT','{}'),
  (blank,org,'quoted','fencing','F1-READY-BLANK','{}'),(not_captured,org,'quoted','fencing','F1-READY-NOCAP','{}'),
  (receipted,org,'quoted','fencing','F1-READY-RCPT','{}'),(done_today,org,'quoted','fencing','F1-READY-DONE','{}'),
  (bucket,org,'quoted','fencing','F1-READY-BUCKET','{}');
 PERFORM pg_temp.f1_event(ready1,'f1-ready','direct',NULL,now()-interval '2 hours','Can you come Tuesday?');
 PERFORM pg_temp.f1_event(ready2,'f1-ready','single_open',NULL,now()-interval '3 hours','Gate should be 1.2 m.');
 PERFORM pg_temp.f1_event(holding,'f1-ready','direct',NULL,now()-interval '2 hours','Parked text.');
 e:=pg_temp.f1_event(outbound_only,'f1-ready','direct',NULL,now()-interval '2 hours','Our reply.');
 UPDATE public.business_events SET direction='outbound' WHERE id=e;
 PERFORM pg_temp.f1_event(blank,'f1-ready','direct',NULL,now()-interval '2 hours','   ');
 e:=pg_temp.f1_event(not_captured,'f1-ready','direct',NULL,now()-interval '2 hours','Not captured yet.');
 UPDATE public.business_events SET context_captured_at=NULL WHERE id=e;
 e:=pg_temp.f1_event(receipted,'f1-ready','direct',NULL,now()-interval '2 hours','Already read.');
 claimed:=public.claim_context_extraction_run(receipted,d,'extraction');
 INSERT INTO public.context_extraction_event_receipts(event_id,job_id,extractor_version,run_id) VALUES(e,receipted,'luna_v2',(claimed->'run'->>'id')::uuid);
 PERFORM pg_temp.f1_event(done_today,'f1-ready','direct',NULL,now()-interval '2 hours','Done today.');
 INSERT INTO public.context_extraction_runs(job_id,run_date,phase,status,finished_at) VALUES(done_today,d,'extraction','done',now());
 PERFORM pg_temp.f1_event(bucket,'f1-ready','admin_bucket',NULL,now()-interval '2 hours','Bucket text.');
 UPDATE public.business_events SET context_captured_at=coalesce(context_captured_at,now()) WHERE job_id IN (ready1,ready2,holding,outbound_only,blank,receipted,done_today,bucket);
 -- K1 (20260924030000) replaced the candidates rule and made ready_jobs the
 -- candidates read itself; its contract owns the due-rule fixtures. The
 -- equality below still holds at every cap.
 FOREACH cap IN ARRAY ARRAY[400,base+2,base+1,1,0] LOOP
  want:=(SELECT count(*) FROM public.context_extraction_candidates(cap)); got:=public.context_ready_jobs_count(cap);
  IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'f1 ready_jobs % differs from candidates % at cap %',got,want,cap; END IF;
 END LOOP;
 IF (public.context_pipeline_status()->>'ready_jobs')::int IS DISTINCT FROM (SELECT count(*) FROM public.context_extraction_candidates(400))::int
 THEN RAISE EXCEPTION 'f1 heartbeat ready_jobs differs from the candidates read'; END IF;
 UPDATE public.automation_switches SET extraction=false WHERE id=1;
 IF public.context_ready_jobs_count(400)<>0 OR (SELECT count(*) FROM public.context_extraction_candidates(400))<>0
 THEN RAISE EXCEPTION 'f1 ready_jobs with the extraction lane off'; END IF;
END $$;
ROLLBACK;
