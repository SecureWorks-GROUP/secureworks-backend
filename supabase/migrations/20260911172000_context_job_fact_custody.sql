-- B3: additive job fact lifecycle + source-CAS revision custody. No model/provider calls.
-- Preserve the five-argument legacy RPC; the new nine-argument overload is v2-only.
DO $$
DECLARE t text; c record;
BEGIN
 FOREACH t IN ARRAY ARRAY['job_context','job_temporary_context'] LOOP
  EXECUTE format('ALTER TABLE public.%I
   ADD COLUMN IF NOT EXISTS lifecycle text NOT NULL DEFAULT ''current'',
   ADD COLUMN IF NOT EXISTS event_date date,
   ADD COLUMN IF NOT EXISTS expires_at timestamptz,
   ADD COLUMN IF NOT EXISTS review_at timestamptz,
   ADD COLUMN IF NOT EXISTS source_event_ids uuid[],
   ADD COLUMN IF NOT EXISTS attribution_confidence numeric,
   ADD COLUMN IF NOT EXISTS extractor_version text,
   ADD COLUMN IF NOT EXISTS superseded_by uuid,
   ADD COLUMN IF NOT EXISTS lifecycle_reason text,
   ADD COLUMN IF NOT EXISTS trust text NOT NULL DEFAULT ''legacy'',
   ADD COLUMN IF NOT EXISTS validity_basis text NOT NULL DEFAULT ''unknown_end'',
   ADD COLUMN IF NOT EXISTS last_verified_at timestamptz,
   ADD COLUMN IF NOT EXISTS source_event_at timestamptz',t);
  -- Replace only kind-only checks, retaining every unrelated production guard.
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid=format('public.%I',t)::regclass AND contype='c'
   AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=format('public.%I',t)::regclass AND attname='kind')] LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',t,c.conname);
  END LOOP;
  -- Retain original taxonomy in provenance. A removed org offer is audit history,
  -- never silently promoted to a new current job fact or physically deleted.
  EXECUTE format($q$UPDATE public.%I SET lifecycle='retracted',lifecycle_reason='taxonomy_removed',
   provenance=provenance||jsonb_build_object('original_kind',kind,'lifecycle','retracted'),kind='note'
   WHERE kind NOT IN ('scope_spec','access_note','alternative_contact','client_preference','note','proposal','current_state','pending_action','quote_issue')$q$,t);
  EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (kind IN (''scope_spec'',''access_note'',''alternative_contact'',''client_preference'',''note'',''proposal'',''current_state'',''pending_action'',''quote_issue''))',t,t||'_kind_check');
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=format('public.%I',t)::regclass AND conname=t||'_lifecycle_v2_check') THEN
   EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (lifecycle IN (''current'',''superseded'',''retracted''))',t,t||'_lifecycle_v2_check');
   EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (trust IN (''luna'',''legacy''))',t,t||'_trust_v2_check');
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=format('public.%I',t)::regclass AND conname=t||'_validity_basis_v2_check') THEN
   EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (validity_basis IN (''explicit_end'',''ongoing'',''uncertain'',''unknown_end''))',t,t||'_validity_basis_v2_check');
  END IF;
 END LOOP;
 -- Unknown/ongoing ends stay null. Temporary rows no longer require an invented TTL.
 ALTER TABLE public.job_temporary_context ALTER COLUMN expires_at DROP NOT NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.luna_context_job_revisions (
 run_id uuid PRIMARY KEY REFERENCES public.context_extraction_runs(id),
 request_sha256 text NOT NULL, source_revisions jsonb NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.luna_context_fact_custody (
 fact_store text NOT NULL CHECK(fact_store IN ('job_context','job_temporary_context')),
 fact_id uuid NOT NULL, fact_sha256 text NOT NULL,
 run_id uuid NOT NULL REFERENCES public.context_extraction_runs(id),
 PRIMARY KEY(fact_store,fact_id)
);
ALTER TABLE public.luna_context_job_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.luna_context_fact_custody ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.luna_context_job_revisions,public.luna_context_fact_custody FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.luna_context_job_revisions,public.luna_context_fact_custody TO service_role;

-- Evidence-led validity: no invented midnight / 7 / 14 / 21 day TTLs.
-- Due date is a deadline, never an expiry. Unknown end stays null.
CREATE OR REPLACE FUNCTION public.context_fact_expiry(p_kind text,p_event_at timestamptz,p_due_date date DEFAULT NULL)
RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
 IF p_event_at IS NULL OR p_kind IS NULL OR p_kind NOT IN ('scope_spec','access_note','alternative_contact','client_preference','note','proposal','current_state','pending_action','quote_issue')
 THEN RAISE EXCEPTION 'luna_fact_expiry_invalid'; END IF;
 IF p_due_date IS NOT NULL AND p_kind<>'pending_action' THEN RAISE EXCEPTION 'luna_fact_due_date_invalid'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.context_fact_expiry(text,timestamptz,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_fact_expiry(text,timestamptz,date) TO service_role;

-- Exclusive Perth midnight after a cited calendar date is a representation of
-- that date, not an invented duration. Only explicit_end may return a timestamp.
CREATE OR REPLACE FUNCTION public.context_supported_validity_end(p_basis text, p_end date)
RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
 IF p_basis IS NULL OR p_basis NOT IN ('explicit_end','ongoing','uncertain','unknown_end')
 THEN RAISE EXCEPTION 'luna_validity_basis_invalid'; END IF;
 IF p_basis='explicit_end' THEN
  IF p_end IS NULL THEN RAISE EXCEPTION 'luna_validity_end_required'; END IF;
  RETURN ((p_end+1)::timestamp AT TIME ZONE 'Australia/Perth');
 END IF;
 IF p_end IS NOT NULL THEN RAISE EXCEPTION 'luna_validity_end_without_basis'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.context_supported_validity_end(text,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_supported_validity_end(text,date) TO service_role;

-- Deterministic calendar evidence only; never infer from the extraction clock.
CREATE OR REPLACE FUNCTION public.context_supported_due_date(p_text text,p_event_at timestamptz)
RETURNS date LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $due$
DECLARE
 s text:=lower(regexp_replace(replace(coalesce(p_text,''),',',' '),'\s+',' ','g')); pattern text; m text[];
 anchor date:=(p_event_at AT TIME ZONE 'Australia/Perth')::date;
 candidates date[]:='{}'; candidate date; y integer; mo integer; dy integer; no_year boolean;
 month_names constant text[]:=ARRAY['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
 weekdays constant text[]:=ARRAY['mon','tue','wed','thu','fri','sat','sun'];
 weekday_text text;
BEGIN
 IF p_event_at IS NULL THEN RAISE EXCEPTION 'luna_due_date_source_time_missing'; END IF;
 IF btrim(s)='' THEN RETURN NULL; END IF;
 IF s ~ '\m(next|last|this)\s+(mon(day)?|tue(sday)?|wed(nesday)?|thu(rsday)?|fri(day)?|sat(urday)?|sun(day)?)\M'
  OR s ~ '\m(day after tomorrow|yesterday|next year|last year)\M'
  OR s ~ '\m(not|except)\s+(today|tomorrow)\M'
 THEN RAISE EXCEPTION 'luna_due_date_ambiguous'; END IF;
 -- A written year cannot be silently dropped by the optional-year grammar.
 FOR m IN SELECT regexp_matches(s,'\m[0-9]{1,2}[/-][0-9]{1,2}[/-]([0-9]+)\M','g') LOOP
  IF length(m[1])<>4 THEN RAISE EXCEPTION 'luna_due_date_ambiguous_year'; END IF;
 END LOOP;
 FOR m IN SELECT regexp_matches(s,'\m[0-9]{1,2}(st|nd|rd|th)?\s+(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\.?\s+([0-9]+)\M','g') LOOP
  IF length(m[3])<>4 THEN RAISE EXCEPTION 'luna_due_date_ambiguous_year'; END IF;
 END LOOP;
 FOR m IN SELECT regexp_matches(s,'\m(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\.?\s+[0-9]{1,2}(st|nd|rd|th)?,?\s+([0-9]+)\M','g') LOOP
  IF length(m[3])<>4 THEN RAISE EXCEPTION 'luna_due_date_ambiguous_year'; END IF;
 END LOOP;
 -- Consume full ISO dates first so their suffix cannot be mistaken for DD-MM.
 pattern:='\m([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})\M';
 FOR m IN SELECT regexp_matches(s,pattern,'g') LOOP
  BEGIN candidate:=make_date(m[1]::integer,m[2]::integer,m[3]::integer);
  EXCEPTION WHEN datetime_field_overflow THEN RAISE EXCEPTION 'luna_due_date_invalid_calendar'; END;
  candidates:=array_append(candidates,candidate);
 END LOOP;
 s:=regexp_replace(s,pattern,' ','g');
 -- Australian day-first numeric dates. Missing years must be a forward date
 -- within the event's own year; a year rollover needs an explicit source year.
 FOREACH pattern IN ARRAY ARRAY['\m([0-9]{1,2})/([0-9]{1,2})(/([0-9]{4}))?\M','\m([0-9]{1,2})-([0-9]{1,2})(-([0-9]{4}))?\M'] LOOP
  FOR m IN SELECT regexp_matches(s,pattern,'g') LOOP
   no_year:=m[4] IS NULL;y:=coalesce(m[4]::integer,extract(year FROM anchor)::integer);
   BEGIN candidate:=make_date(y,m[2]::integer,m[1]::integer);
   EXCEPTION WHEN datetime_field_overflow THEN RAISE EXCEPTION 'luna_due_date_invalid_calendar'; END;
   IF no_year AND candidate<anchor THEN RAISE EXCEPTION 'luna_due_date_ambiguous_year'; END IF;
   candidates:=array_append(candidates,candidate);
  END LOOP;
  s:=regexp_replace(s,pattern,' ','g');
 END LOOP;
 pattern:='\m([0-9]{1,2})(st|nd|rd|th)?\s+(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\.?(\s+([0-9]{4}))?\M';
 FOR m IN SELECT regexp_matches(s,pattern,'g') LOOP
  no_year:=m[5] IS NULL;y:=coalesce(m[5]::integer,extract(year FROM anchor)::integer);mo:=array_position(month_names,left(m[3],3));dy:=m[1]::integer;
  BEGIN candidate:=make_date(y,mo,dy);
  EXCEPTION WHEN datetime_field_overflow THEN RAISE EXCEPTION 'luna_due_date_invalid_calendar'; END;
  IF no_year AND candidate<anchor THEN RAISE EXCEPTION 'luna_due_date_ambiguous_year'; END IF;
  candidates:=array_append(candidates,candidate);
 END LOOP;
 s:=regexp_replace(s,pattern,' ','g');
 pattern:='\m(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\.?\s+([0-9]{1,2})(st|nd|rd|th)?(,?\s+([0-9]{4}))?\M';
 FOR m IN SELECT regexp_matches(s,pattern,'g') LOOP
  no_year:=m[5] IS NULL;y:=coalesce(m[5]::integer,extract(year FROM anchor)::integer);mo:=array_position(month_names,left(m[1],3));dy:=m[2]::integer;
  BEGIN candidate:=make_date(y,mo,dy);
  EXCEPTION WHEN datetime_field_overflow THEN RAISE EXCEPTION 'luna_due_date_invalid_calendar'; END;
  IF no_year AND candidate<anchor THEN RAISE EXCEPTION 'luna_due_date_ambiguous_year'; END IF;
  candidates:=array_append(candidates,candidate);
 END LOOP;
 s:=regexp_replace(s,pattern,' ','g');
 IF s ~ '\mtoday\M' THEN candidates:=array_append(candidates,anchor); END IF;
 IF s ~ '\mtomorrow\M' THEN candidates:=array_append(candidates,anchor+1); END IF;
 IF (SELECT count(DISTINCT d) FROM unnest(candidates) d)>1 THEN RAISE EXCEPTION 'luna_due_date_conflicting_dates'; END IF;
 candidate:=candidates[1];
 -- Bare weekdays are ambiguous. A weekday decorating a concrete date is a
 -- consistency check, not permission to choose a future occurrence.
 FOR m IN SELECT regexp_matches(s,'\m(mon(day)?|tue(sday)?|wed(nesday)?|thu(rsday)?|fri(day)?|sat(urday)?|sun(day)?)\M','g') LOOP
  weekday_text:=left(m[1],3);
  IF candidate IS NULL OR extract(isodow FROM candidate)::integer<>array_position(weekdays,weekday_text)
   THEN RAISE EXCEPTION 'luna_due_date_ambiguous_weekday'; END IF;
 END LOOP;
 RETURN candidate;
END $due$;
REVOKE ALL ON FUNCTION public.context_supported_due_date(text,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_supported_due_date(text,timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.persist_luna_context_revision(
 p_run_id uuid,p_lease_token uuid,p_job_id uuid,p_events jsonb,p_new jsonb,p_supersedes jsonb,p_retracts jsonb,
 p_extractor_version text DEFAULT 'luna_v2',p_tokens_in integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
 r public.context_extraction_runs; ev jsonb; actual jsonb; f jsonb; transition jsonb; previous jsonb;
 event_ids uuid[]:='{}'; refs uuid[]; new_ids uuid[]:='{}'; transition_ids uuid[]:='{}';
 target text; kind text; fact_id uuid; ref uuid; old_id uuid; new_index integer; link uuid;
 event_time timestamptz; confidence numeric; due date; expiry timestamptz; review_time timestamptz;
 validity_end date; validity_basis text; incoming_event_at timestamptz; existing_event_at timestamptz;
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
 SELECT * INTO r FROM public.context_extraction_runs WHERE id=p_run_id FOR UPDATE;
 IF NOT FOUND OR r.job_id IS DISTINCT FROM p_job_id OR r.phase<>'extraction' THEN RAISE EXCEPTION 'luna_run_identity_invalid'; END IF;
 SELECT * INTO receipt FROM public.luna_context_job_revisions WHERE run_id=p_run_id;
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
   OR actual->>'event_at' IS NULL OR actual->>'attribution_confidence' IS NULL
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
   -- Event time, not write time, decides recency. Late older evidence cannot supersede.
   SELECT max((value->>'event_at')::timestamptz) INTO incoming_event_at
    FROM jsonb_array_elements(p_events) WHERE (value->>'id')::uuid=ANY(refs);
   existing_event_at:=coalesce((previous->>'source_event_at')::timestamptz,(previous#>>'{provenance,event_at}')::timestamptz);
   IF existing_event_at IS NULL AND previous->>'event_date' IS NOT NULL THEN
    existing_event_at:=((previous->>'event_date')::date)::timestamp AT TIME ZONE 'Australia/Perth';
   END IF;
   IF existing_event_at IS NOT NULL AND incoming_event_at IS NOT NULL AND incoming_event_at<existing_event_at
    THEN RAISE EXCEPTION 'luna_stale_event_override'; END IF;
   transition_ids:=array_append(transition_ids,old_id);
  END LOOP;
 END LOOP;
 FOR f IN SELECT value FROM jsonb_array_elements(p_new) LOOP
  kind:=f->>'kind';
  IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR kind IS NULL
   OR kind NOT IN ('scope_spec','access_note','alternative_contact','client_preference','note','proposal','current_state','pending_action','quote_issue')
   OR nullif(btrim(f->>'text'),'') IS NULL OR length(f->>'text')>4000
   OR jsonb_typeof(f->'confidence') IS DISTINCT FROM 'number' OR (f->>'confidence')::numeric NOT BETWEEN 0 AND 1
   OR jsonb_typeof(f->'source_event_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(f->'source_event_ids')=0
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(f) k WHERE k NOT IN ('kind','text','confidence','source_event_ids','evidence_excerpt','due_date','validity_end','validity_basis'))
  THEN RAISE EXCEPTION 'luna_fact_shape_invalid'; END IF;
  SELECT array_agg(DISTINCT value::uuid ORDER BY value::uuid) INTO refs FROM jsonb_array_elements_text(f->'source_event_ids');
  IF NOT refs <@ event_ids THEN RAISE EXCEPTION 'luna_fact_source_mismatch'; END IF;
  SELECT max((value->>'event_at')::timestamptz),min((value->>'attribution_confidence')::numeric),
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
    supported_date:=public.context_supported_due_date(source_text,(source_event->>'event_at')::timestamptz);
    IF supported_date IS NULL OR supported_date IS DISTINCT FROM due THEN RAISE EXCEPTION 'luna_due_date_unsupported'; END IF;
    supported_dates:=array_append(supported_dates,supported_date);
   END LOOP;
   IF cardinality(supported_dates)=0 THEN RAISE EXCEPTION 'luna_due_date_unsupported'; END IF;
  END IF;
  validity_basis:=coalesce(nullif(btrim(f->>'validity_basis'),''), CASE WHEN f->>'validity_end' IS NOT NULL THEN 'explicit_end' ELSE 'unknown_end' END);
  IF validity_basis NOT IN ('explicit_end','ongoing','uncertain','unknown_end') THEN RAISE EXCEPTION 'luna_validity_basis_invalid'; END IF;
  IF f->>'validity_end' IS NOT NULL AND f->>'validity_end' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE EXCEPTION 'luna_validity_end_shape_invalid'; END IF;
  validity_end:=(f->>'validity_end')::date;
  IF due IS NOT NULL AND validity_end IS NOT NULL AND due IS DISTINCT FROM validity_end THEN RAISE EXCEPTION 'luna_validity_end_unsupported'; END IF;
  IF validity_end IS NOT NULL THEN
   IF validity_basis<>'explicit_end' THEN RAISE EXCEPTION 'luna_validity_end_without_basis'; END IF;
   supported_dates:='{}';
   FOR source_event IN SELECT value FROM jsonb_array_elements(p_events) WHERE (value->>'id')::uuid=ANY(refs) LOOP
    source_text:=public.context_event_text(jsonb_populate_record(NULL::public.business_events,source_event));
    IF excerpt IS NOT NULL THEN
     IF position(excerpt in source_text)=0 THEN CONTINUE; END IF;
     source_text:=excerpt;
    ELSIF cardinality(refs)<>1 THEN RAISE EXCEPTION 'luna_validity_end_excerpt_required'; END IF;
    supported_date:=public.context_supported_due_date(source_text,(source_event->>'event_at')::timestamptz);
    IF supported_date IS NULL OR supported_date IS DISTINCT FROM validity_end THEN RAISE EXCEPTION 'luna_validity_end_unsupported'; END IF;
    supported_dates:=array_append(supported_dates,supported_date);
   END LOOP;
   IF cardinality(supported_dates)=0 THEN RAISE EXCEPTION 'luna_validity_end_unsupported'; END IF;
  ELSIF validity_basis='explicit_end' THEN RAISE EXCEPTION 'luna_validity_end_required'; END IF;
  -- Refuse any restored invented midnight/7/14/21-day helper. Due date is not expiry.
  IF public.context_fact_expiry(kind,event_time,due) IS NOT NULL THEN RAISE EXCEPTION 'luna_invented_expiry'; END IF;
  expiry:=public.context_supported_validity_end(validity_basis,validity_end);
  review_time:=CASE WHEN kind='client_preference' THEN ((event_time AT TIME ZONE 'Australia/Perth')+interval '1 year') AT TIME ZONE 'Australia/Perth' ELSE NULL END;
  target:=CASE WHEN kind IN ('current_state','pending_action','quote_issue') THEN 'job_temporary_context' ELSE 'job_context' END;
  fact_id:=md5(p_run_id::text||':luna_v2:'||n::text)::uuid;
  SELECT jsonb_agg(jsonb_build_object('table','business_events','id',id::text) ORDER BY id) INTO source_refs FROM unnest(refs) id;
  EXECUTE format('INSERT INTO public.%I(id,job_id,kind,value,provenance,correlation_id,lifecycle,event_date,expires_at,review_at,source_event_ids,attribution_confidence,extractor_version,trust,validity_basis,last_verified_at,source_event_at)
   VALUES($1,$2,$3,$4,$5,$6,''current'',$7,$8,$9,$10,$11,''luna_v2'',''luna'',$12,NULL,$13) RETURNING to_jsonb(%I)',target,target)
  INTO actual USING fact_id,p_job_id,kind,
   jsonb_strip_nulls(jsonb_build_object('text',f->>'text','confidence',(f->>'confidence')::numeric,'source_refs',source_refs,'evidence_excerpt',f->>'evidence_excerpt','due_date',due,'validity_end',validity_end)),
   jsonb_build_object('extractor','luna_v2','writer_role','classifier','untrusted',false,'lifecycle','active','source_event_ids',to_jsonb(refs),
    'event_at',event_time,'validity_basis',validity_basis,'source_event_at',event_time,'safety',jsonb_build_object('memory_trusted',true,'action_safe',false,'state_change_safe',false,'outbound_safe',false)),
   p_run_id,(event_time AT TIME ZONE 'Australia/Perth')::date,expiry,review_time,refs,confidence,validity_basis,event_time;
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

-- Preserve existing reader columns/order and append the v2 fields.
CREATE OR REPLACE VIEW public.current_job_context_facts WITH (security_invoker=true) AS
SELECT visible.* FROM (
 SELECT id,job_id,kind,value,provenance,correlation_id,created_at,updated_at,expires_at,'job_context'::text AS _context_store,
  lifecycle,event_date,source_event_ids,attribution_confidence,extractor_version,superseded_by,lifecycle_reason,trust,review_at,
  validity_basis,last_verified_at,source_event_at
 FROM public.job_context
 UNION ALL
 SELECT id,job_id,kind,value,provenance,correlation_id,created_at,updated_at,expires_at,'job_temporary_context'::text AS _context_store,
  lifecycle,event_date,source_event_ids,attribution_confidence,extractor_version,superseded_by,lifecycle_reason,trust,review_at,
  validity_basis,last_verified_at,source_event_at
 FROM public.job_temporary_context
) visible
WHERE lifecycle='current' AND (expires_at IS NULL OR expires_at>now())
 AND (extractor_version='luna_v2' OR kind NOT IN ('current_state','pending_action','quote_issue','proposal') OR expires_at IS NOT NULL)
 AND (extractor_version IS DISTINCT FROM 'luna_v2' OR (
  cardinality(source_event_ids)>0 AND NOT EXISTS (
   SELECT 1 FROM unnest(visible.source_event_ids) source_id
   LEFT JOIN public.business_events b ON b.id=source_id
   WHERE b.id IS NULL OR b.job_id::text IS DISTINCT FROM visible.job_id::text
    OR b.attribution_status IS NULL OR b.attribution_status NOT IN ('direct','thread','single_open','single_line','luna')
    OR b.event_at IS NULL OR b.attribution_confidence IS NULL OR b.attribution_confidence NOT BETWEEN 0 AND 1
    OR to_jsonb(b)->>'retracted_at' IS NOT NULL
    OR to_jsonb(b)#>>'{metadata,retracted_at}' IS NOT NULL OR to_jsonb(b)->>'retracted'='true' OR to_jsonb(b)#>>'{metadata,retracted}'='true'
  )))
 AND provenance#>'{safety,memory_trusted}' IS DISTINCT FROM 'false'::jsonb
 AND coalesce(CASE WHEN jsonb_typeof(provenance->'lifecycle')='object' THEN provenance#>>'{lifecycle,state}' ELSE provenance->>'lifecycle' END,'active') NOT IN ('superseded','retracted')
 AND nullif(provenance->>'superseded_by','') IS NULL AND nullif(provenance->>'retracted_at','') IS NULL
 AND (kind<>'quote_issue' OR NOT EXISTS(SELECT 1 FROM public.jobs j WHERE j.id=visible.job_id
   AND (to_jsonb(j)->>'quoted_at')::timestamptz >= coalesce((visible.provenance->>'event_at')::timestamptz,visible.event_date::timestamp AT TIME ZONE 'Australia/Perth',visible.created_at))
 AND NOT EXISTS(SELECT 1 FROM public.job_events je WHERE je.job_id=visible.job_id AND je.event_type='quote_sent'
   AND je.created_at >= coalesce((visible.provenance->>'event_at')::timestamptz,visible.event_date::timestamp AT TIME ZONE 'Australia/Perth',visible.created_at)));
REVOKE ALL ON public.current_job_context_facts FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.current_job_context_facts TO service_role;
