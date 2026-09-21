-- Booking-lane context hangar: draft jobs pin, one job_brief kind, callable draft mint.
-- Option A (21 Sep): a worked lead gets a draft job at intake; the attribution
-- ladder includes drafts so evidence can hang before a card is scoped.
-- No trigger, cron, backfill, or live job write. Callable only.
-- Merge to main auto-applies this migration via the edge deploy lane.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. Ladder includes draft. Coverage already counts draft as open
-- (context_coverage excludes cancelled/archived/lost/closed/complete/completed
-- only). Single-match / multi-match / none stays in resolve_context_attribution.
CREATE OR REPLACE FUNCTION public.context_contact_jobs(p_contact_id text) RETURNS SETOF public.jobs
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT j.* FROM public.jobs j WHERE p_contact_id IS NOT NULL
 AND j.status::text NOT IN ('cancelled','archived','lost','closed','complete','completed')
 AND (j.ghl_contact_id=p_contact_id OR EXISTS (SELECT 1 FROM public.contact_matches m
 WHERE m.job_id=j.id AND (m.ghl_contact_id=p_contact_id OR to_jsonb(m)->>'xero_contact_id'=p_contact_id)))
$$;
REVOKE ALL ON FUNCTION public.context_contact_jobs(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_contact_jobs(text) TO service_role;
COMMENT ON FUNCTION public.context_contact_jobs(text) IS
 'Open jobs for a GHL/Xero contact, including draft. Terminal statuses stay out. Identity is contact id only.';

-- 2. One new kind for the whole where-is-it-at brief. Ten-section text lives
-- in value.text; do not split into site/availability/promise kinds. Permanent
-- store, no auto-expiry (superseded by the next per-job persist).
ALTER TABLE public.job_context DROP CONSTRAINT IF EXISTS job_context_kind_check;
ALTER TABLE public.job_context ADD CONSTRAINT job_context_kind_check
 CHECK (trust='legacy' OR kind IN ('scope_spec','access_note','alternative_contact','client_preference','note','proposal','current_state','pending_action','quote_issue','job_brief'));

CREATE OR REPLACE FUNCTION public.context_fact_expiry(p_kind text,p_event_at timestamptz,p_due_date date DEFAULT NULL)
RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
 IF p_event_at IS NULL OR p_kind IS NULL OR p_kind NOT IN ('scope_spec','access_note','alternative_contact','client_preference','note','proposal','current_state','pending_action','quote_issue','job_brief')
 THEN RAISE EXCEPTION 'luna_fact_expiry_invalid'; END IF;
 IF p_due_date IS NOT NULL AND p_kind<>'pending_action' THEN RAISE EXCEPTION 'luna_fact_due_date_invalid'; END IF;
 RETURN CASE p_kind
  WHEN 'current_state' THEN (((p_event_at AT TIME ZONE 'Australia/Perth')::date+1)::timestamp AT TIME ZONE 'Australia/Perth')
  WHEN 'pending_action' THEN CASE WHEN p_due_date IS NOT NULL THEN ((p_due_date+1)::timestamp AT TIME ZONE 'Australia/Perth') ELSE p_event_at+interval '168 hours' END
  WHEN 'quote_issue' THEN p_event_at+interval '336 hours'
  WHEN 'proposal' THEN p_event_at+interval '504 hours'
  ELSE NULL END;
END $$;
REVOKE ALL ON FUNCTION public.context_fact_expiry(text,timestamptz,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_fact_expiry(text,timestamptz,date) TO service_role;

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
   OR actual->>'attribution_status' NOT IN ('direct','thread','single_open','single_line','luna')
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


-- Display columns the mint copies from p_client. Production already has them;
-- IF NOT EXISTS keeps the contract fixture and a second apply as no-ops.
ALTER TABLE public.jobs
 ADD COLUMN IF NOT EXISTS client_name text,
 ADD COLUMN IF NOT EXISTS client_phone text,
 ADD COLUMN IF NOT EXISTS client_email text,
 ADD COLUMN IF NOT EXISTS site_address text,
 ADD COLUMN IF NOT EXISTS site_suburb text,
 ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 ADD COLUMN IF NOT EXISTS ghl_contact_id text;

-- 3. Idempotent draft hangar for a GHL contact. Never runs on its own.
-- Existing 549 drafts come from ghl-webhook form intake and ghl-proxy create_job.
-- This RPC is the booking-lane equivalent, keyed only on ghl_contact_id.
-- Returns an existing open job (including draft) rather than inserting a twin.
CREATE OR REPLACE FUNCTION public.ensure_booking_draft_job(
 p_ghl_contact_id text,
 p_type text DEFAULT 'fencing',
 p_org_id uuid DEFAULT '00000000-0000-0000-0000-000000000001',
 p_client jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
 contact_id text:=nullif(btrim(p_ghl_contact_id),'');
 job_type text:=coalesce(nullif(btrim(p_type),''),'fencing');
 org uuid:=coalesce(p_org_id,'00000000-0000-0000-0000-000000000001'::uuid);
 client jsonb:=CASE WHEN jsonb_typeof(p_client)='object' THEN p_client ELSE '{}'::jsonb END;
 ids uuid[]; statuses text[]; n int; created_row public.jobs; assigned_job_number text;
BEGIN
 IF contact_id IS NULL OR contact_id !~ '^\S{8,64}$' THEN RAISE EXCEPTION 'booking_draft_contact_required'; END IF;
 IF job_type NOT IN ('fencing','patio','combo') THEN RAISE EXCEPTION 'booking_draft_type_invalid'; END IF;
 -- Serialize creates for one contact so two callers cannot insert two drafts.
 PERFORM pg_advisory_xact_lock(hashtextextended('ensure_booking_draft_job:'||contact_id, 0));
 SELECT array_agg(j.id ORDER BY j.id), array_agg(j.status::text ORDER BY j.id)
  INTO ids, statuses FROM public.context_contact_jobs(contact_id) j;
 n:=coalesce(cardinality(ids),0);
 IF n=1 THEN
  RETURN jsonb_build_object('outcome','existing','created',false,'job_id',ids[1],'status',statuses[1],'open_job_ids',to_jsonb(ids));
 ELSIF n>1 THEN
  RETURN jsonb_build_object('outcome','ambiguous','created',false,'job_id',null,'status',null,'open_job_ids',to_jsonb(ids));
 END IF;
 -- Set job_number here. trg_auto_job_number calls unqualified next_job_number,
 -- which is invisible under this function's search_path=pg_catalog.
 IF to_regprocedure('public.next_job_number(text)') IS NOT NULL THEN
  assigned_job_number:=public.next_job_number(job_type);
 ELSE
  assigned_job_number:='BK-'||substr(md5(contact_id),1,16);
 END IF;
 BEGIN
  INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id,metadata,client_name,client_phone,client_email,site_address,site_suburb)
  VALUES(gen_random_uuid(),org,'draft',job_type,assigned_job_number,contact_id,
   jsonb_build_object('booking_intake_draft',true,'source','ensure_booking_draft_job'),
   nullif(btrim(client->>'client_name'),''),nullif(btrim(client->>'client_phone'),''),
   nullif(btrim(client->>'client_email'),''),nullif(btrim(client->>'site_address'),''),
   nullif(btrim(client->>'site_suburb'),''))
  RETURNING * INTO created_row;
 EXCEPTION WHEN unique_violation THEN
  SELECT array_agg(j.id ORDER BY j.id), array_agg(j.status::text ORDER BY j.id)
   INTO ids, statuses FROM public.context_contact_jobs(contact_id) j;
  IF coalesce(cardinality(ids),0)=1 THEN
   RETURN jsonb_build_object('outcome','existing','created',false,'job_id',ids[1],'status',statuses[1],'open_job_ids',to_jsonb(ids));
  ELSIF coalesce(cardinality(ids),0)>1 THEN
   RETURN jsonb_build_object('outcome','ambiguous','created',false,'job_id',null,'status',null,'open_job_ids',to_jsonb(ids));
  END IF;
  RAISE EXCEPTION 'booking_draft_create_conflict';
 END;
 RETURN jsonb_build_object('outcome','created','created',true,'job_id',created_row.id,'status',created_row.status,'open_job_ids',jsonb_build_array(created_row.id));
END $$;
REVOKE ALL ON FUNCTION public.ensure_booking_draft_job(text,text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_booking_draft_job(text,text,uuid,jsonb) TO service_role;
COMMENT ON FUNCTION public.ensure_booking_draft_job(text,text,uuid,jsonb) IS
 'Idempotent booking-lane draft job for one GHL contact id. Does not run on its own. Identity is ghl_contact_id only; p_client display fields are never used to match.';

-- Unique only for drafts this RPC stamps. Existing ghl-webhook drafts are
-- not in this set, so apply cannot collide with the 549 live drafts.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_booking_intake_draft_ghl_contact_id
 ON public.jobs (ghl_contact_id)
 WHERE status = 'draft'
   AND ghl_contact_id IS NOT NULL
   AND coalesce(metadata->>'booking_intake_draft','') = 'true';
