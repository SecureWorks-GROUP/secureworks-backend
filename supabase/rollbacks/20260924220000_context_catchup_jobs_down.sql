-- Down migration for 20260924220000_context_catchup_jobs.
--
-- Restores the four replaced functions to K1's bodies (20260924030000), byte
-- for byte (md5 checked at the end), and drops the catch-up writer, its row
-- readers and both triggers. Kept on purpose (no data is lost):
-- public.context_catchup_jobs and public.context_catchup_reads with their
-- rows, the record of which jobs were listed, which rows were read and when.
-- Nothing reads it after this rollback, and a re-apply resumes from it.
-- Immediate stop needs no rollback: switch the extraction lane off.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$
DECLARE live text;
BEGIN
 SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid=to_regprocedure('public.persist_luna_context_revision(uuid,uuid,uuid,jsonb,jsonb,jsonb,jsonb,text,integer)');
 IF live IS DISTINCT FROM '5e2f351da5fbf4fcb0c69c3d841f5e3d' THEN RAISE EXCEPTION 'catch-up rollback: persistence body is %',live; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.persist_luna_context_revision(
 p_run_id uuid,p_lease_token uuid,p_job_id uuid,p_events jsonb,p_new jsonb,p_supersedes jsonb,p_retracts jsonb,
 p_extractor_version text DEFAULT 'luna_v2',p_tokens_in integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
 r public.context_extraction_runs; ev jsonb; actual jsonb; f jsonb; transition jsonb; previous jsonb;
 event_ids uuid[]:='{}'; refs uuid[]; new_ids uuid[]:='{}'; transition_ids uuid[]:='{}';
 target text; kind text; fact_id uuid; ref uuid; old_id uuid; new_index integer; link uuid;
 event_time timestamptz; confidence numeric; due date; expiry timestamptz; review_time timestamptz;
 source_text text; source_refs jsonb; source_event jsonb; supported_date date; supported_dates date[]; excerpt text; digest text; request_hash text; receipt public.luna_context_job_revisions;
 result jsonb; n integer:=0; ns integer:=0; nr integer:=0; mode text; now_time timestamptz:=clock_timestamp();
BEGIN
 IF p_run_id IS NULL OR p_lease_token IS NULL OR p_job_id IS NULL OR p_extractor_version IS DISTINCT FROM 'luna_v2'
 OR jsonb_typeof(p_events) IS DISTINCT FROM 'array' OR jsonb_array_length(p_events) NOT BETWEEN 1 AND 25
 OR jsonb_typeof(p_new) IS DISTINCT FROM 'array' OR jsonb_typeof(p_supersedes) IS DISTINCT FROM 'array'
 OR jsonb_typeof(p_retracts) IS DISTINCT FROM 'array' OR p_tokens_in IS NULL OR p_tokens_in<0
 THEN RAISE EXCEPTION 'luna_job_revision_invalid'; END IF;
 request_hash:=encode(sha256(convert_to(jsonb_build_object('job',p_job_id,'events',p_events,'new',p_new,
   'supersedes',p_supersedes,'retracts',p_retracts,'version',p_extractor_version)::text,'UTF8')),'hex');
 -- Serialize the whole revision and its receipt before examining source rows.
 SELECT run.* INTO r FROM public.context_extraction_runs run WHERE run.id=p_run_id FOR UPDATE;
 IF NOT FOUND OR r.job_id IS DISTINCT FROM p_job_id OR r.phase<>'extraction' THEN RAISE EXCEPTION 'luna_run_identity_invalid'; END IF;
 SELECT rev.* INTO receipt FROM public.luna_context_job_revisions rev WHERE rev.run_id=p_run_id;
 IF FOUND THEN
  IF receipt.request_sha256=request_hash THEN RETURN receipt.result||jsonb_build_object('outcome','idempotent'); END IF;
  RETURN jsonb_build_object('outcome','held','reason','run_already_committed');
 END IF;
 IF r.status<>'running' OR r.lease_token IS DISTINCT FROM p_lease_token OR r.lease_expires_at<=now_time OR r.lease_expires_at IS NULL
  OR NOT public.automation_lane_enabled('extraction') THEN RETURN jsonb_build_object('outcome','held','reason','lease_or_lane'); END IF;
 -- All expected source bytes are checked under row locks. Sort locks to avoid
 -- inter-job source swaps creating inconsistent lock order.
 FOR ev IN SELECT value FROM jsonb_array_elements(p_events) ORDER BY value->>'id' LOOP
  IF jsonb_typeof(ev) IS DISTINCT FROM 'object' OR ev->>'id' IS NULL THEN RAISE EXCEPTION 'luna_source_identity_invalid'; END IF;
  ref:=(ev->>'id')::uuid;
  IF ref=ANY(event_ids) THEN RAISE EXCEPTION 'luna_duplicate_source'; END IF;
  SELECT to_jsonb(b) INTO actual FROM public.business_events b WHERE b.id=ref FOR UPDATE;
  IF actual IS NULL OR actual IS DISTINCT FROM ev THEN RAISE EXCEPTION 'luna_source_revision_stale'; END IF;
  IF actual->>'job_id' IS DISTINCT FROM p_job_id::text OR actual->>'attribution_status' IS NULL
   OR NOT public.context_linked_status(actual->>'attribution_status')
   OR (actual#>>'{payload,job_id}' IS NOT NULL AND actual#>>'{payload,job_id}' IS DISTINCT FROM p_job_id::text)
   OR coalesce(actual->>'event_at',actual->>'occurred_at') IS NULL OR actual->>'attribution_confidence' IS NULL
   OR (actual->>'attribution_confidence')::numeric NOT BETWEEN 0 AND 1
   OR actual->>'retracted_at' IS NOT NULL OR actual#>>'{metadata,retracted_at}' IS NOT NULL
   OR actual->>'retracted'='true' OR actual#>>'{metadata,retracted}'='true'
  THEN RAISE EXCEPTION 'luna_source_attribution_rejected'; END IF;
  IF EXISTS(SELECT 1 FROM public.context_extraction_event_receipts e WHERE e.event_id=ref AND e.job_id=p_job_id AND e.extractor_version='luna_v2')
   THEN RETURN jsonb_build_object('outcome','held','reason','source_already_processed'); END IF;
  event_ids:=array_append(event_ids,ref);
 END LOOP;
 -- Validate every transition BEFORE any insert/update. Expected view snapshots
 -- protect concurrent edits; the custody hash additionally protects v2 history.
 FOREACH mode IN ARRAY ARRAY['superseded','retracted'] LOOP
  FOR transition IN SELECT value FROM jsonb_array_elements(CASE WHEN mode='superseded' THEN p_supersedes ELSE p_retracts END) LOOP
   target:=transition->>'fact_store'; old_id:=(transition->>'fact_id')::uuid;
   IF target IS NULL OR target NOT IN ('job_context','job_temporary_context') OR old_id IS NULL
    OR nullif(btrim(transition->>'reason'),'') IS NULL OR jsonb_typeof(transition->'source_event_ids') IS DISTINCT FROM 'array'
    OR jsonb_array_length(transition->'source_event_ids')=0 OR old_id=ANY(transition_ids)
   THEN RAISE EXCEPTION 'luna_transition_invalid'; END IF;
   SELECT array_agg(value::uuid) INTO refs FROM jsonb_array_elements_text(transition->'source_event_ids');
   IF NOT refs <@ event_ids THEN RAISE EXCEPTION 'luna_transition_source_mismatch'; END IF;
   new_index:=(transition->>'new_fact_index')::integer;
   IF new_index IS NOT NULL AND (mode<>'superseded' OR new_index<0 OR new_index>=jsonb_array_length(p_new)) THEN RAISE EXCEPTION 'luna_transition_link_invalid'; END IF;
   EXECUTE format('SELECT to_jsonb(f) FROM public.%I f WHERE id=$1 FOR UPDATE',target) INTO previous USING old_id;
   SELECT c.fact_sha256 INTO digest FROM public.luna_context_fact_custody c WHERE c.fact_store=target AND c.fact_id=old_id;
   SELECT to_jsonb(v) INTO actual FROM public.current_job_context_facts v WHERE v.id=old_id AND v._context_store=target;
   IF previous IS NULL OR previous->>'job_id' IS DISTINCT FROM p_job_id::text OR previous->>'lifecycle' IS DISTINCT FROM 'current'
    OR actual IS NULL OR transition->'expected_fact' IS DISTINCT FROM actual
   THEN RETURN jsonb_build_object('outcome','held','reason','fact_custody_changed'); END IF;
   IF previous->>'extractor_version'='luna_v2' AND previous->>'trust'='luna' THEN
    IF digest IS NULL OR digest IS DISTINCT FROM encode(sha256(convert_to(previous::text,'UTF8')),'hex')
     THEN RETURN jsonb_build_object('outcome','held','reason','fact_custody_changed'); END IF;
   ELSIF coalesce(previous->>'extractor_version',previous#>>'{provenance,extractor}',previous#>>'{provenance,extractor_version}','')
     NOT IN ('context-fact-extractor:v1','context-fact-extractor:v1.5','context-fact-extractor:v2','context-fact-extractor.ts','context-luna-subscription:v1')
     OR coalesce(previous#>>'{provenance,writer_role}','classifier')<>'classifier' THEN
    RETURN jsonb_build_object('outcome','held','reason','human_fact');
   END IF;
   transition_ids:=array_append(transition_ids,old_id);
  END LOOP;
 END LOOP;
 FOR f IN SELECT value FROM jsonb_array_elements(p_new) LOOP
  kind:=f->>'kind';
  IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR kind IS NULL
   OR kind NOT IN ('scope_spec','access_note','alternative_contact','client_preference','note','proposal','current_state','pending_action','quote_issue','job_brief')
   OR nullif(btrim(f->>'text'),'') IS NULL OR (kind='job_brief' AND length(f->>'text')>16000) OR (kind<>'job_brief' AND length(f->>'text')>4000)
   OR jsonb_typeof(f->'confidence') IS DISTINCT FROM 'number' OR (f->>'confidence')::numeric NOT BETWEEN 0 AND 1
   OR jsonb_typeof(f->'source_event_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(f->'source_event_ids')=0
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(f) k WHERE k NOT IN ('kind','text','confidence','source_event_ids','evidence_excerpt','due_date'))
  THEN RAISE EXCEPTION 'luna_fact_shape_invalid'; END IF;
  SELECT array_agg(DISTINCT value::uuid ORDER BY value::uuid) INTO refs FROM jsonb_array_elements_text(f->'source_event_ids');
  IF NOT refs <@ event_ids THEN RAISE EXCEPTION 'luna_fact_source_mismatch'; END IF;
  SELECT max(coalesce((value->>'event_at')::timestamptz,(value->>'occurred_at')::timestamptz)),min((value->>'attribution_confidence')::numeric),
    string_agg(public.context_event_text(jsonb_populate_record(NULL::public.business_events,value)),' ')
   INTO event_time,confidence,source_text FROM jsonb_array_elements(p_events) WHERE (value->>'id')::uuid=ANY(refs);
  IF f->>'due_date' IS NOT NULL AND f->>'due_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE EXCEPTION 'luna_due_date_shape_invalid'; END IF;
  due:=(f->>'due_date')::date;
  excerpt:=nullif(f->>'evidence_excerpt','');
  IF excerpt IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_events) cited
   WHERE (cited->>'id')::uuid=ANY(refs) AND position(excerpt in public.context_event_text(jsonb_populate_record(NULL::public.business_events,cited)))>0)
   THEN RAISE EXCEPTION 'luna_excerpt_unsupported'; END IF;
  IF due IS NOT NULL THEN
   IF kind<>'pending_action' THEN RAISE EXCEPTION 'luna_due_date_unsupported'; END IF;
   supported_dates:='{}';
   FOR source_event IN SELECT value FROM jsonb_array_elements(p_events) WHERE (value->>'id')::uuid=ANY(refs) LOOP
    source_text:=public.context_event_text(jsonb_populate_record(NULL::public.business_events,source_event));
    IF excerpt IS NOT NULL THEN
     IF position(excerpt in source_text)=0 THEN CONTINUE; END IF;
     source_text:=excerpt;
    ELSIF cardinality(refs)<>1 THEN RAISE EXCEPTION 'luna_due_date_excerpt_required'; END IF;
    supported_date:=public.context_supported_due_date(source_text,coalesce((source_event->>'event_at')::timestamptz,(source_event->>'occurred_at')::timestamptz));
    IF supported_date IS NULL OR supported_date IS DISTINCT FROM due THEN RAISE EXCEPTION 'luna_due_date_unsupported'; END IF;
    supported_dates:=array_append(supported_dates,supported_date);
   END LOOP;
   IF cardinality(supported_dates)=0 THEN RAISE EXCEPTION 'luna_due_date_unsupported'; END IF;
  END IF;
  expiry:=public.context_fact_expiry(kind,event_time,due);
  review_time:=CASE WHEN kind='client_preference' THEN ((event_time AT TIME ZONE 'Australia/Perth')+interval '1 year') AT TIME ZONE 'Australia/Perth' ELSE NULL END;
  target:=CASE WHEN kind IN ('current_state','pending_action','quote_issue') THEN 'job_temporary_context' ELSE 'job_context' END;
  fact_id:=md5(p_run_id::text||':luna_v2:'||n::text)::uuid;
  SELECT jsonb_agg(jsonb_build_object('table','business_events','id',cited.source_event_id::text) ORDER BY cited.source_event_id) INTO source_refs FROM unnest(refs) AS cited(source_event_id);
  EXECUTE format('INSERT INTO public.%I(id,job_id,kind,value,provenance,correlation_id,lifecycle,event_date,expires_at,review_at,source_event_ids,attribution_confidence,extractor_version,trust)
   VALUES($1,$2,$3,$4,$5,$6,''current'',$7,$8,$9,$10,$11,''luna_v2'',''luna'') RETURNING to_jsonb(%I)',target,target)
  INTO actual USING fact_id,p_job_id,kind,
   jsonb_strip_nulls(jsonb_build_object('text',f->>'text','confidence',(f->>'confidence')::numeric,'source_refs',source_refs,'evidence_excerpt',f->>'evidence_excerpt','due_date',due)),
   jsonb_build_object('extractor','luna_v2','writer_role','classifier','untrusted',false,'lifecycle','active','source_event_ids',to_jsonb(refs),
    'event_at',event_time,'safety',jsonb_build_object('memory_trusted',true,'action_safe',false,'state_change_safe',false,'outbound_safe',false)),
   p_run_id,(event_time AT TIME ZONE 'Australia/Perth')::date,expiry,review_time,refs,confidence;
  INSERT INTO public.luna_context_fact_custody(fact_store,fact_id,fact_sha256,run_id)
   VALUES(target,fact_id,encode(sha256(convert_to(actual::text,'UTF8')),'hex'),p_run_id);
  new_ids:=array_append(new_ids,fact_id);n:=n+1;
 END LOOP;
 FOREACH mode IN ARRAY ARRAY['superseded','retracted'] LOOP
  FOR transition IN SELECT value FROM jsonb_array_elements(CASE WHEN mode='superseded' THEN p_supersedes ELSE p_retracts END) LOOP
   target:=transition->>'fact_store';old_id:=(transition->>'fact_id')::uuid;new_index:=(transition->>'new_fact_index')::integer;
   link:=CASE WHEN new_index IS NULL THEN NULL ELSE new_ids[new_index+1] END;
   EXECUTE format('UPDATE public.%I SET lifecycle=$2,lifecycle_reason=$3,superseded_by=$4,updated_at=$5,
    provenance=provenance||jsonb_build_object(''lifecycle'',$2,''retirement_source_event_ids'',$6,''retirement_run_id'',$7,''safety'',coalesce(provenance->''safety'',''{}''::jsonb)||''{"memory_trusted":false}''::jsonb)
    WHERE id=$1 RETURNING to_jsonb(%I)',target,target) INTO actual USING old_id,mode,transition->>'reason',link,now_time,transition->'source_event_ids',p_run_id;
   UPDATE public.luna_context_fact_custody c SET fact_sha256=encode(sha256(convert_to(actual::text,'UTF8')),'hex'),run_id=p_run_id WHERE c.fact_store=target AND c.fact_id=old_id;
   IF mode='superseded' THEN ns:=ns+1;ELSE nr:=nr+1;END IF;
  END LOOP;
 END LOOP;
 IF NOT public.finish_context_extraction_run(p_run_id,p_lease_token,'done',event_ids,p_tokens_in,n,ns,nr,NULL,NULL)
 THEN RAISE EXCEPTION 'luna_run_lease_lost'; END IF;
 result:=jsonb_build_object('outcome','inserted','facts_new',n,'facts_superseded',ns,'facts_retracted',nr,'fact_ids',to_jsonb(new_ids));
 INSERT INTO public.luna_context_job_revisions(run_id,request_sha256,source_revisions,result)
  SELECT p_run_id,request_hash,jsonb_object_agg(value->>'id',encode(sha256(convert_to(value::text,'UTF8')),'hex')),result FROM jsonb_array_elements(p_events);
 RETURN result;
EXCEPTION WHEN OTHERS THEN
 IF SQLERRM LIKE 'luna\_%' ESCAPE '\' THEN RAISE; END IF;
 RAISE EXCEPTION 'luna_job_revision_failed';
END $$;
REVOKE ALL ON FUNCTION public.persist_luna_context_revision(uuid,uuid,uuid,jsonb,jsonb,jsonb,jsonb,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.persist_luna_context_revision(uuid,uuid,uuid,jsonb,jsonb,jsonb,jsonb,text,integer) TO service_role;

DROP TRIGGER IF EXISTS context_catchup_mark_done ON public.context_extraction_runs;
DROP FUNCTION IF EXISTS public.context_catchup_mark_done();
DROP FUNCTION IF EXISTS public.context_catchup_request(boolean);
DROP TRIGGER IF EXISTS context_catchup_record_read ON public.context_extraction_event_receipts;
DROP FUNCTION IF EXISTS public.context_catchup_record_read();

-- The cadence judgement (cadence.md 5.1), set-based so the tick and the
-- heartbeat judge every job in one query. The one definition: the claim,
-- candidates, freshness and status all take their answer from here.
CREATE OR REPLACE FUNCTION public.context_jobs_cadence(p_job_ids uuid[]) RETURNS TABLE(job_id uuid, cadence jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH k AS (
  SELECT pol.p, now() AS now_t, (now() AT TIME ZONE 'Australia/Perth') AS local_now, (now() AT TIME ZONE 'Australia/Perth')::date AS today,
   (pol.p->>'live_since')::timestamptz AS live_from,
   (((now() AT TIME ZONE 'Australia/Perth')::date)::timestamp+(pol.p->>'status_only_after')::time) AT TIME ZONE 'Australia/Perth' AS evening,
   public.automation_lane_enabled('extraction') AS lane,
   (SELECT count(*) FROM public.context_model_call_reservations r WHERE r.run_date=(now() AT TIME ZONE 'Australia/Perth')::date)::integer AS calls
  FROM (SELECT public.context_cadence_policy() AS p) pol
 ), j AS (
  SELECT jb.id, jb.created_at, coalesce(jb.metadata->>'do_not_schedule','') NOT IN ('true','1') AS extractable
  FROM public.jobs jb WHERE jb.id=ANY(p_job_ids)
 ), u AS MATERIALIZED (
  -- Live evidence: captured since live_from, capture_mode live, written as
  -- service_role, and not the early relink case (a contact-rule placement,
  -- ladder step 3 or 4, of a row older than the job).
  SELECT x.job_id, x.id, greatest(x.context_captured_at,x.attributed_at) AS landed, public.context_event_status_only(x) AS so,
   (x.context_captured_at>=k.live_from AND coalesce(x.metadata->>'capture_mode','live')='live' AND x.metadata->>'written_as'='service_role'
    AND NOT (coalesce(x.attribution_step,0) IN (3,4) AND coalesce(x.event_at,x.occurred_at)<j.created_at)) AS live
  FROM public.context_unread_rows(p_job_ids) x JOIN j ON j.id=x.job_id CROSS JOIN k
 ), ev AS (
  SELECT u.job_id, count(*) AS unread_n, min(u.landed) AS oldest_unread,
   count(*) FILTER (WHERE u.live AND NOT u.so) AS wake_n,
   max(u.landed) FILTER (WHERE u.live AND NOT u.so) AS newest_wake, min(u.landed) FILTER (WHERE u.live AND NOT u.so) AS oldest_wake,
   (array_agg(u.id ORDER BY u.landed DESC NULLS LAST, u.id DESC) FILTER (WHERE u.live AND NOT u.so))[1] AS newest_wake_id,
   count(*) FILTER (WHERE u.live AND u.so) AS so_n, min(u.landed) FILTER (WHERE u.live AND u.so) AS oldest_so
  FROM u GROUP BY u.job_id
 ), runs AS (
  SELECT r.job_id, count(*) FILTER (WHERE r.run_date=k.today) AS runs_today, max(r.started_at) AS last_started,
   max(r.finished_at) FILTER (WHERE r.status='done') AS last_finished,
   bool_or(r.status='running' AND r.lease_expires_at>k.now_t) AS run_live,
   max(r.retry_at) FILTER (WHERE r.status='failed' AND r.retry_at>k.now_t) AS retry_until,
   bool_or(r.run_date=k.today AND r.started_at>=k.evening) AS ran_evening
  FROM public.context_extraction_runs r CROSS JOIN k WHERE r.job_id=ANY(p_job_ids) AND r.phase='extraction' GROUP BY r.job_id
 ), base AS (
  SELECT j.id AS job_id, j.extractable, k.*,
   coalesce(ev.unread_n,0)::integer AS unread_n, ev.oldest_unread, coalesce(ev.wake_n,0)::integer AS wake_n, ev.newest_wake, ev.oldest_wake,
   coalesce(ev.so_n,0)::integer AS so_n, ev.oldest_so,
   coalesce((SELECT b.direction='inbound' AND NOT public.context_event_is_ours(b) FROM public.business_events b WHERE b.id=ev.newest_wake_id),false) AS customer,
   coalesce(runs.runs_today,0)::integer AS runs_today, runs.last_started, runs.last_finished, coalesce(runs.run_live,false) AS run_live,
   runs.retry_until, coalesce(runs.ran_evening,false) AS ran_evening
  FROM j CROSS JOIN k LEFT JOIN ev ON ev.job_id=j.id LEFT JOIN runs ON runs.job_id=j.id
 ), limits AS (
  SELECT b.*,
   b.local_now::time<(b.p->>'morning_until')::time AND b.calls>=(b.p->>'morning_cap')::integer AS pacing,
   b.calls>=(b.p->>'model_call_cap')::integer AS capped,
   (b.p->>'runs_per_job_day')::integer+CASE WHEN b.customer AND public.context_in_business_hours(b.newest_wake) THEN (b.p->>'inbound_extra_runs')::integer ELSE 0 END AS run_limit,
   CASE WHEN b.wake_n>0 THEN least(b.newest_wake+make_interval(mins=>(b.p->>'quiet_min')::integer),b.oldest_wake+make_interval(mins=>(b.p->>'ceiling_min')::integer))
        WHEN b.so_n>0 THEN CASE WHEN b.ran_evening THEN b.evening+interval '1 day' ELSE b.evening END END AS evidence_due,
   b.last_started+make_interval(mins=>(b.p->>'cooldown_min')::integer) AS cooldown_until
  FROM base b
 ), timed AS (
  SELECT l.*, greatest(l.evidence_due,l.cooldown_until,l.retry_until) AS due_at FROM limits l
 ), judged AS (
  SELECT t.*,
   (t.lane AND t.extractable AND t.evidence_due IS NOT NULL AND NOT t.run_live AND t.runs_today<t.run_limit AND NOT t.pacing AND NOT t.capped AND t.due_at<=t.now_t) AS due,
   CASE WHEN NOT t.lane THEN 'lane_off' WHEN NOT t.extractable THEN 'holding_job' WHEN t.evidence_due IS NULL OR t.run_live THEN NULL
    WHEN t.runs_today>=t.run_limit THEN 'daily_ceiling' WHEN t.retry_until IS NOT NULL THEN 'retry_wait'
    WHEN t.capped THEN 'model_cap' WHEN t.pacing THEN 'pacing_reserve' END AS reason,
   CASE WHEN t.lane AND t.extractable AND t.evidence_due IS NOT NULL AND NOT t.run_live THEN
    greatest(t.due_at,t.now_t,
     CASE WHEN t.runs_today>=t.run_limit OR t.capped THEN (t.today+1)::timestamp AT TIME ZONE 'Australia/Perth' END,
     CASE WHEN t.pacing THEN (t.today::timestamp+(t.p->>'morning_until')::time) AT TIME ZONE 'Australia/Perth' END) END AS next_due
  FROM timed t
 )
 SELECT g.job_id, jsonb_build_object('job_id',g.job_id,'due',g.due,'due_since',CASE WHEN g.due THEN g.due_at END,'blocked_reason',g.reason,'next_due_at',g.next_due,
  'lane_on',g.lane,'extractable',g.extractable,'unread_count',g.unread_n,'oldest_unread_landed_at',g.oldest_unread,
  'waking_count',g.wake_n,'newest_waking_landed_at',g.newest_wake,'oldest_waking_landed_at',g.oldest_wake,'newest_waking_is_customer',g.customer,
  'status_only_count',g.so_n,'order_at',coalesce(g.oldest_wake,g.oldest_so),
  'runs_today',g.runs_today,'run_limit',g.run_limit,'run_live',g.run_live,'retry_at',g.retry_until,'cooldown_until',g.cooldown_until,
  'last_run_started_at',g.last_started,'last_run_finished_at',g.last_finished,
  'model_calls_today',g.calls,'pacing_held',g.pacing,'model_cap_reached',g.capped)
 FROM judged g
$$;
COMMENT ON FUNCTION public.context_jobs_cadence(uuid[]) IS
 'K1: the one cadence judgement (cadence.md 5.1) for a set of jobs: due, blocked_reason, next_due_at and the facts behind them. Read by the claim, candidates, freshness and status.';

-- Jobs that can be due at all: some unread live row captured at or after live_since.
CREATE OR REPLACE FUNCTION public.context_cadence_pool() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH pol AS (SELECT public.context_cadence_policy() AS p)
 SELECT DISTINCT u.job_id FROM public.context_unread_rows(NULL) u, pol
 WHERE u.context_captured_at>=(pol.p->>'live_since')::timestamptz
  AND coalesce(u.metadata->>'capture_mode','live')='live' AND u.metadata->>'written_as'='service_role'
$$;

-- 5. Due jobs, same signature: fewest runs today first, then oldest waking
-- evidence first.
CREATE OR REPLACE FUNCTION public.context_extraction_candidates(p_limit integer DEFAULT 400) RETURNS TABLE(job_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH lane AS (SELECT public.automation_lane_enabled('extraction') AS enabled),
 judged AS (SELECT x.job_id, x.cadence AS c
  FROM public.context_jobs_cadence(ARRAY(SELECT p.job_id FROM public.context_cadence_pool() AS p(job_id) WHERE (SELECT enabled FROM lane))) x)
 SELECT j.job_id FROM judged j WHERE (j.c->>'due')::boolean
 ORDER BY (j.c->>'runs_today')::integer, (j.c->>'order_at')::timestamptz NULLS LAST, j.job_id
 LIMIT greatest(0,least(coalesce(p_limit,400),400))
$$;

-- 9. The cadence status block, read by the F1 composer.
CREATE OR REPLACE FUNCTION public.context_cadence_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE pol jsonb:=public.context_cadence_policy(); now_t timestamptz:=now(); today date:=(now() AT TIME ZONE 'Australia/Perth')::date;
 lane boolean; attribution_lane boolean; calls integer; attribution_calls integer; judged jsonb; due_n integer; waiting_n integer;
 ceiling_n integer; pacing_n integer; oldest_unread timestamptz; oldest_wait numeric; breach boolean;
 runs integer; jobs_run integer; max_runs integer; takeovers integer; not_service integer; unplaced_n integer; oldest_unplaced timestamptz; alarms jsonb:='[]'::jsonb;
BEGIN
 lane:=public.automation_lane_enabled('extraction'); attribution_lane:=public.automation_lane_enabled('attribution');
 SELECT count(*), count(*) FILTER (WHERE phase='attribution') INTO calls, attribution_calls FROM public.context_model_call_reservations WHERE run_date=today;
 SELECT coalesce(jsonb_agg(x.cadence),'[]'::jsonb) INTO judged
  FROM public.context_jobs_cadence(ARRAY(SELECT p.job_id FROM public.context_cadence_pool() AS p(job_id))) x;
 SELECT count(*) FILTER (WHERE (c->>'due')::boolean),
  count(*) FILTER (WHERE NOT (c->>'due')::boolean AND (coalesce((c->>'waking_count')::integer,0)+coalesce((c->>'status_only_count')::integer,0))>0),
  count(*) FILTER (WHERE c->>'blocked_reason'='daily_ceiling'), count(*) FILTER (WHERE c->>'blocked_reason'='pacing_reserve'),
  min((c->>'order_at')::timestamptz),
  max(extract(epoch FROM now_t-(c->>'due_since')::timestamptz)/60) FILTER (WHERE (c->>'due')::boolean)
 INTO due_n, waiting_n, ceiling_n, pacing_n, oldest_unread, oldest_wait FROM jsonb_array_elements(judged) AS c;
 breach:=lane AND calls<(pol->>'model_call_cap')::integer AND coalesce(oldest_wait,0)>(pol->>'breach_wait_min')::integer;
 SELECT count(*), count(DISTINCT job_id), coalesce(max(n),0) INTO runs, jobs_run, max_runs
  FROM (SELECT job_id, count(*) OVER (PARTITION BY job_id) AS n FROM public.context_extraction_runs WHERE run_date=today AND phase='extraction') r;
 SELECT coalesce(sum(lease_takeovers),0) INTO takeovers FROM public.context_pass_days WHERE run_date=today;
 SELECT count(*) INTO not_service FROM public.business_events
  WHERE context_captured_at>now_t-interval '24 hours' AND metadata ? 'written_as' AND metadata->>'written_as'<>'service_role';
 SELECT count(*), min(coalesce(event_at,occurred_at)) INTO unplaced_n, oldest_unplaced FROM public.business_events WHERE attribution_status='unplaced';
 IF breach THEN
  alarms:=alarms||jsonb_build_array(jsonb_build_object('key','cadence_breach','severity','warning',
   'since',now_t-make_interval(secs=>oldest_wait*60),'oldest_due_wait_minutes',round(oldest_wait),
   'what_to_do','A job has been due for a read for more than 90 minutes with the extraction lane on and model budget left. Check that the Luna context worker is running and ticking.'));
 END IF;
 RETURN jsonb_build_object('as_of',now_t,'policy',pol,
  'lanes',jsonb_build_object('extraction',lane,'attribution',attribution_lane),
  'due_jobs',due_n,'waiting_jobs',waiting_n,'oldest_unread_landed_at',oldest_unread,
  'oldest_due_wait_minutes',CASE WHEN oldest_wait IS NULL THEN NULL ELSE round(oldest_wait) END,'cadence_breach',breach,
  'runs_today',runs,'jobs_run_today',jobs_run,'max_runs_one_job_today',max_runs,
  'jobs_at_daily_ceiling',ceiling_n,'pacing_held_jobs',pacing_n,'lease_takeovers_today',takeovers,
  'model_calls_today',calls,'attribution_calls_today',attribution_calls,
  'unplaced_count',unplaced_n,'oldest_unplaced_at',oldest_unplaced,
  'rows_not_service_role_24h',not_service,'alarms',alarms);
END $$;
COMMENT ON FUNCTION public.context_cadence_status() IS
 'Status block cadence, owned by cadence slice K1 (cadence.md 9.A item 9). Due and waiting jobs from context_job_cadence, runs today, ceiling and pacing holds, lease takeovers, unplaced rows, rows not written as service_role, and the cadence_breach alarm.';

-- 4. The batch: newest customer (not ours) row always included, then live
-- waking rows (the same live non-status-only predicate as context_jobs_cadence)
-- ahead of landed time so the rows that woke the job are always read, older
-- rows while space remains; returned in time order. Exact rows (note a).
CREATE OR REPLACE FUNCTION public.context_extraction_events(p_job_id uuid,p_limit integer DEFAULT 25) RETURNS SETOF public.business_events
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH admitted AS (
  SELECT public.automation_lane_enabled('extraction')
   AND EXISTS(SELECT 1 FROM public.jobs j WHERE j.id=p_job_id AND public.context_job_extractable(j)) AS ok
 ), unread AS MATERIALIZED (
  SELECT u.* FROM public.context_unread_rows(ARRAY[p_job_id]) u WHERE (SELECT ok FROM admitted)
 ), anchor AS (
  SELECT e.id FROM unread u JOIN public.business_events e ON e.id=u.id
  WHERE NOT public.context_event_is_ours(e)
  ORDER BY greatest(e.context_captured_at,e.attributed_at) DESC NULLS LAST, e.id DESC LIMIT 1
 ), live_key AS (
  SELECT (pol.p->>'live_since')::timestamptz AS live_since, j.created_at
  FROM (SELECT public.context_cadence_policy() AS p) pol
  JOIN public.jobs j ON j.id=p_job_id
 ), picked AS (
  SELECT u.* FROM unread u CROSS JOIN live_key k
  ORDER BY (u.id IN (SELECT id FROM anchor)) DESC,
   (u.context_captured_at>=k.live_since AND coalesce(u.metadata->>'capture_mode','live')='live' AND u.metadata->>'written_as'='service_role'
    AND NOT (coalesce(u.attribution_step,0) IN (3,4) AND coalesce(u.event_at,u.occurred_at)<k.created_at)
    AND NOT public.context_event_status_only(u)) DESC,
   greatest(u.context_captured_at,u.attributed_at) DESC NULLS LAST, u.id DESC
  LIMIT greatest(0,least(coalesce(p_limit,25),25))
 ) SELECT * FROM picked ORDER BY coalesce(event_at,occurred_at), id
$$;

-- The flags the worker passes to the model and the validator for a batch:
-- ours (context_event_is_ours) and older_context (older than the age window,
-- or older than the job's last completed read). Ids not on the job are ignored.
CREATE OR REPLACE FUNCTION public.context_extraction_event_flags(p_job_id uuid,p_event_ids uuid[])
RETURNS TABLE(event_id uuid, ours boolean, older_context boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH pol AS (SELECT public.context_cadence_policy() AS p),
 last_read AS (SELECT max(r.started_at) AS at FROM public.context_extraction_runs r
  WHERE r.job_id=p_job_id AND r.phase='extraction' AND r.status='done')
 SELECT e.id, public.context_event_is_ours(e),
  coalesce(coalesce(e.event_at,e.occurred_at)<now()-make_interval(days=>(pol.p->>'age_window_days')::integer)
   OR coalesce(e.event_at,e.occurred_at)<(SELECT at FROM last_read),false)
 FROM public.business_events e, pol
 WHERE p_job_id IS NOT NULL AND e.job_id=p_job_id AND e.id=ANY(coalesce(p_event_ids,'{}'::uuid[]))
 ORDER BY coalesce(e.event_at,e.occurred_at), e.id
$$;

DROP FUNCTION IF EXISTS public.context_catchup_pending_rows(uuid[]);
DROP FUNCTION IF EXISTS public.context_catchup_eligible_rows(uuid[]);

DO $$
DECLARE x record; live text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_jobs_cadence(uuid[])','71db787a8a80b5519b5a5c9b8d915d5c'),
  ('public.context_cadence_pool()','6943c7ed49e09cddc23a517255805fba'),
  ('public.context_extraction_candidates(integer)','0257dc0ea9c35a249b3b8adcb99a18d4'),
  ('public.context_cadence_status()','04a99b46fbdf6b6ac830602da6a92c3d'),
  ('public.context_extraction_events(uuid,integer)','b808f4b6fb24515a337c149a6353edf8'),
  ('public.context_extraction_event_flags(uuid,uuid[])','c384d748eca9b3b94ba6e54b26b781e5')) AS t(sig,md5) LOOP
  SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid=to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.md5 THEN RAISE EXCEPTION 'catch-up rollback: % is not K1''s body (%)',x.sig,live; END IF;
 END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.context_jobs_cadence(uuid[]),public.context_cadence_pool(),public.context_extraction_candidates(integer),public.context_cadence_status(),
 public.context_extraction_events(uuid,integer),public.context_extraction_event_flags(uuid,uuid[])
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_jobs_cadence(uuid[]),public.context_cadence_pool(),public.context_extraction_candidates(integer),public.context_cadence_status(),
 public.context_extraction_events(uuid,integer),public.context_extraction_event_flags(uuid,uuid[])
TO service_role;


DO $$
DECLARE live text;
BEGIN
 SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid=to_regprocedure('public.persist_luna_context_revision(uuid,uuid,uuid,jsonb,jsonb,jsonb,jsonb,text,integer)');
 IF live IS DISTINCT FROM '2ef95a949f0aae99cc323abde10f2ee7' THEN RAISE EXCEPTION 'catch-up rollback: persistence body was not restored (%)',live; END IF;
END $$;
