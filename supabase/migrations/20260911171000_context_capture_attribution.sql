-- B2: retained capture, deterministic attribution, atomic subscription-worker binding.
ALTER TABLE public.business_events
 ADD COLUMN IF NOT EXISTS attribution_status text,
 ADD COLUMN IF NOT EXISTS attribution_step smallint,
 ADD COLUMN IF NOT EXISTS attribution_confidence numeric,
 ADD COLUMN IF NOT EXISTS attributed_at timestamptz,
 ADD COLUMN IF NOT EXISTS event_at timestamptz,
 ADD COLUMN IF NOT EXISTS provider_message_id text,
 ADD COLUMN IF NOT EXISTS thread_key text,
 ADD COLUMN IF NOT EXISTS attribution_checked_at timestamptz,
 ADD COLUMN IF NOT EXISTS context_captured_at timestamptz;
-- Existing rows stay dormant until a fresh event reaches their job.
ALTER TABLE public.business_events ALTER COLUMN context_captured_at SET DEFAULT now();
ALTER TABLE public.business_events ADD CONSTRAINT business_events_attribution_status_check
 CHECK (attribution_status IN ('direct','thread','single_open','single_line','luna','admin_bucket','pending_luna','empty','automated'));
CREATE UNIQUE INDEX business_events_provider_message_unique ON public.business_events(provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX business_events_context_bucket ON public.business_events(attribution_checked_at,occurred_at,id) WHERE job_id IS NULL;
CREATE INDEX business_events_context_job ON public.business_events(job_id,event_at,id) WHERE job_id IS NOT NULL;
CREATE TABLE public.event_threads (
 thread_key text PRIMARY KEY, job_id uuid NOT NULL REFERENCES public.jobs(id),
 bound_by text NOT NULL CHECK(bound_by IN ('ladder','luna','human')),
 bound_at timestamptz NOT NULL DEFAULT now(), source_event_id uuid
);
ALTER TABLE public.event_threads ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON public.event_threads TO service_role;

-- Closed-list body fields: identifiers/metadata alone are not extractable words.
CREATE FUNCTION public.context_event_text(e public.business_events) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT coalesce(nullif(e.payload->>'body',''), nullif(e.payload->>'message_text',''),
 nullif(e.payload->>'text',''),nullif(e.payload->>'note_text',''),nullif(e.payload->>'note',''),nullif(e.payload->>'transcript',''),e.body_preview,'')
$$;

CREATE FUNCTION public.context_contact_jobs(p_contact_id text) RETURNS SETOF public.jobs
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT j.* FROM public.jobs j WHERE p_contact_id IS NOT NULL
 AND j.status::text NOT IN ('draft','cancelled','archived','lost','closed','complete','completed')
 AND (j.ghl_contact_id=p_contact_id OR EXISTS (SELECT 1 FROM public.contact_matches m
 WHERE m.job_id=j.id AND (m.ghl_contact_id=p_contact_id OR to_jsonb(m)->>'xero_contact_id'=p_contact_id)))
$$;

CREATE FUNCTION public.context_attribution_jobs(p_contact_id text)
RETURNS TABLE(id uuid,job_number text,type text,status text,site_suburb text,updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT j.id,j.job_number,j.type::text,j.status::text,to_jsonb(j)->>'site_suburb',(to_jsonb(j)->>'updated_at')::timestamptz FROM public.context_contact_jobs(p_contact_id) j
$$;
REVOKE ALL ON FUNCTION public.context_attribution_jobs(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_attribution_jobs(text) TO service_role;

-- A composite-row helper is callable; trigger functions cannot be invoked through RPC.
CREATE FUNCTION public.resolve_context_attribution(e public.business_events) RETURNS public.business_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE words text; ids uuid[]; candidate uuid; n int; line text; contact_ids text[]; prior_status text; source_method text;
BEGIN
 prior_status:=e.attribution_status;
 source_method:=e.match_method;
 IF e.job_id IS NOT NULL AND coalesce(source_method,'none') NOT IN ('direct_job_id','direct_reference','manual') THEN
   e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('attribution_hint',jsonb_build_object('job_id',e.job_id,'match_method',source_method,'match_confidence',e.match_confidence));
   e.job_id:=NULL;
 END IF;
 e.attribution_checked_at:=clock_timestamp();
 -- Provider evidence without a source timestamp stays undated; ingestion is not occurrence.
 words:=public.context_event_text(e);
 e.attribution_status:='admin_bucket'; e.attribution_step:=6;
 e.attribution_confidence:=NULL; e.attributed_at:=NULL;
 e.match_status:='unresolved'; e.match_method:='none'; e.match_confidence:=NULL;
 IF NOT public.automation_lane_enabled('attribution') THEN e.job_id:=NULL; RETURN e; END IF;
 IF to_jsonb(e)->>'channel' IN ('system','audit') THEN e.attribution_status:='automated'; RETURN e; END IF;
 IF btrim(words)='' THEN e.attribution_status:='empty'; RETURN e; END IF;
 IF prior_status='automated' OR e.payload->>'automated'='true' OR e.payload->>'auto_submitted' IN ('auto-generated','auto-replied')
 THEN e.attribution_status:='automated'; RETURN e; END IF;
 -- Direct ids are checked against jobs, never interpreted as job numbers.
 SELECT id INTO candidate FROM public.jobs WHERE id=e.job_id;
 IF candidate IS NULL THEN
   SELECT array_agg(DISTINCT id) INTO ids FROM (
     SELECT j.id FROM public.jobs j WHERE j.job_number IS NOT NULL
      AND strpos(' '||upper(regexp_replace(words,'[^a-zA-Z0-9-]+',' ','g'))||' ', ' '||upper(j.job_number)||' ')>0
     UNION SELECT x.job_id FROM public.xero_invoices x WHERE x.job_id IS NOT NULL AND x.invoice_number IS NOT NULL
      AND strpos(' '||upper(regexp_replace(words,'[^a-zA-Z0-9-]+',' ','g'))||' ', ' '||upper(x.invoice_number)||' ')>0
     UNION SELECT po.job_id FROM public.purchase_orders po WHERE po.job_id IS NOT NULL AND po.po_number IS NOT NULL
      AND strpos(' '||upper(regexp_replace(words,'[^a-zA-Z0-9-]+',' ','g'))||' ', ' '||upper(po.po_number)||' ')>0
   ) refs;
   IF cardinality(ids)=1 THEN candidate:=ids[1];
   ELSIF cardinality(ids)>1 THEN e.job_id:=NULL; RETURN e; END IF;
 END IF;
 IF candidate IS NOT NULL THEN e.attribution_status:='direct'; e.attribution_step:=1;
 ELSE
  SELECT job_id INTO candidate FROM public.event_threads WHERE thread_key=e.thread_key;
  IF candidate IS NOT NULL THEN e.attribution_status:='thread'; e.attribution_step:=2;
  ELSE
   -- Resolve phone/email only when they identify one contact. Multiple identities remain in bucket.
   IF e.contact_id IS NULL THEN
    SELECT array_agg(DISTINCT j.ghl_contact_id) INTO contact_ids FROM public.jobs j
    WHERE j.ghl_contact_id IS NOT NULL AND (
      (nullif(e.payload->>'email','') IS NOT NULL AND lower(to_jsonb(j)->>'client_email')=lower(e.payload->>'email')) OR
      (length(regexp_replace(coalesce(e.payload->>'phone',''),'[^0-9]','','g'))>=8 AND
       right(regexp_replace(coalesce(to_jsonb(j)->>'client_phone',to_jsonb(j)->>'phone',''),'[^0-9]','','g'),9)=right(regexp_replace(e.payload->>'phone','[^0-9]','','g'),9)));
    IF cardinality(contact_ids)=1 THEN e.contact_id:=contact_ids[1]; END IF;
   END IF;
   SELECT array_agg(id) INTO ids FROM public.context_contact_jobs(e.contact_id);
   n:=coalesce(cardinality(ids),0);
   IF n=1 THEN candidate:=ids[1]; e.attribution_status:='single_open'; e.attribution_step:=3;
   ELSIF n>1 THEN
    line:=lower(coalesce(e.payload->>'line',e.payload->>'business_line',''));
    SELECT array_agg(id) INTO ids FROM public.context_contact_jobs(e.contact_id) WHERE type::text=line AND line IN ('fencing','patio');
    IF cardinality(ids)=1 THEN candidate:=ids[1]; e.attribution_status:='single_line'; e.attribution_step:=4;
    ELSE e.attribution_status:='pending_luna'; e.attribution_step:=5; END IF;
   END IF;
  END IF;
 END IF;
 e.job_id:=candidate;
 IF candidate IS NOT NULL THEN
  -- First successful binder wins. Conflicting explicit ids remain bucketed, never relink a thread.
  IF nullif(e.thread_key,'') IS NOT NULL THEN
   INSERT INTO public.event_threads(thread_key,job_id,bound_by,source_event_id) VALUES(e.thread_key,candidate,'ladder',e.id) ON CONFLICT DO NOTHING;
   IF NOT EXISTS (SELECT 1 FROM public.event_threads WHERE thread_key=e.thread_key AND job_id=candidate) THEN
    e.job_id:=NULL; e.attribution_status:='admin_bucket'; e.attribution_step:=6;
    e.payload:=coalesce(e.payload,'{}')||jsonb_build_object('attribution_error','thread_conflict'); RETURN e;
   END IF;
  END IF;
  e.attribution_confidence:=1; e.attributed_at:=clock_timestamp();
  e.match_status:='matched'; e.match_method:=CASE WHEN e.attribution_status='direct' THEN 'direct_job_id' ELSE 'contact_id' END; e.match_confidence:=1;
 ELSE e.match_status:='unresolved'; e.match_method:='none'; e.match_confidence:=NULL;
 END IF;
 RETURN e;
EXCEPTION WHEN OTHERS THEN
 e.job_id:=NULL; e.attribution_status:='admin_bucket'; e.attribution_step:=6;
 e.attribution_confidence:=NULL; e.attributed_at:=NULL;
 e.match_status:='unresolved'; e.match_method:='none'; e.match_confidence:=NULL;
 e.payload:=coalesce(e.payload,'{}')||jsonb_build_object('attribution_error',SQLERRM);
 RETURN e;
END $$;
CREATE FUNCTION public.attribute_business_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN NEW:=public.resolve_context_attribution(NEW); RETURN NEW; END $$;
CREATE TRIGGER context_attribute_business_event BEFORE INSERT ON public.business_events FOR EACH ROW EXECUTE FUNCTION public.attribute_business_event();

CREATE FUNCTION public.rerun_context_attribution(p_limit integer DEFAULT 250,p_contact_id text DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e public.business_events; resolved public.business_events; n int:=0;
BEGIN
 IF NOT public.automation_lane_enabled('attribution') THEN RETURN 0; END IF;
 FOR e IN SELECT * FROM public.business_events
 WHERE (attribution_status='admin_bucket' OR attribution_status IS NULL)
 AND job_id IS NULL AND (p_contact_id IS NULL OR contact_id=p_contact_id)
 AND (event_at IS NULL OR event_at>now()-interval '90 days')
 ORDER BY attribution_checked_at NULLS FIRST,occurred_at,id
 LIMIT greatest(0,least(coalesce(p_limit,250),1000)) FOR UPDATE SKIP LOCKED LOOP
  resolved:=public.resolve_context_attribution(e);
  UPDATE public.business_events SET job_id=resolved.job_id,contact_id=resolved.contact_id,
   attribution_status=resolved.attribution_status,attribution_step=resolved.attribution_step,
   attribution_confidence=resolved.attribution_confidence,attributed_at=resolved.attributed_at,
   attribution_checked_at=resolved.attribution_checked_at,event_at=resolved.event_at,
   match_status=resolved.match_status,match_method=resolved.match_method,match_confidence=resolved.match_confidence,
   payload=resolved.payload,metadata=resolved.metadata WHERE id=e.id;
  n:=n+1;
 END LOOP;
 RETURN n;
END $$;
CREATE FUNCTION public.context_job_created_reconsider() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 -- Bounded deterministic work only; unresolved repeat customers become pending_luna.
 PERFORM public.rerun_context_attribution(250,NEW.ghl_contact_id); RETURN NEW;
EXCEPTION WHEN OTHERS THEN RAISE WARNING 'context job reconsideration failed: %',SQLERRM; RETURN NEW;
END $$;
CREATE TRIGGER context_job_created_reconsider AFTER INSERT ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.context_job_created_reconsider();

CREATE FUNCTION public.attribute_context_event_with_luna(p_event_id uuid,p_job_id uuid,p_confidence numeric)
RETURNS public.business_events LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e public.business_events; chosen uuid;
BEGIN
 IF NOT public.automation_lane_enabled('attribution') THEN RAISE EXCEPTION 'attribution disabled'; END IF;
 SELECT * INTO e FROM public.business_events WHERE id=p_event_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'event not found'; END IF;
 IF e.attribution_status IS DISTINCT FROM 'pending_luna' THEN RAISE EXCEPTION 'event is not pending Luna'; END IF;
 IF p_job_id IS NOT NULL THEN
  IF p_confidence IS NULL OR p_confidence<0 OR p_confidence>1 OR p_confidence='NaN'::numeric THEN RAISE EXCEPTION 'invalid confidence'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.context_contact_jobs(e.contact_id) WHERE id=p_job_id) THEN RAISE EXCEPTION 'job is not a contact candidate'; END IF;
  chosen:=p_job_id;
  IF nullif(e.thread_key,'') IS NOT NULL THEN
   INSERT INTO public.event_threads(thread_key,job_id,bound_by,source_event_id) VALUES(e.thread_key,p_job_id,'luna',e.id) ON CONFLICT DO NOTHING;
   SELECT job_id INTO chosen FROM public.event_threads WHERE thread_key=e.thread_key;
   -- A racing reply follows the thread winner; it never overwrites that binding.
   IF chosen<>p_job_id THEN p_confidence:=1; END IF;
  END IF;
 END IF;
 UPDATE public.business_events SET job_id=chosen,
 attribution_status=CASE WHEN chosen IS NULL THEN 'admin_bucket' WHEN chosen<>p_job_id THEN 'thread' ELSE 'luna' END,
 attribution_step=CASE WHEN chosen IS NULL THEN 6 WHEN chosen<>p_job_id THEN 2 ELSE 5 END,
 attribution_confidence=CASE WHEN chosen IS NOT NULL THEN p_confidence END,
 attributed_at=CASE WHEN chosen IS NOT NULL THEN clock_timestamp() END,
 attribution_checked_at=clock_timestamp(),match_status=CASE WHEN chosen IS NULL THEN 'unresolved' ELSE 'matched' END,
 match_method=CASE WHEN chosen IS NULL THEN 'none' ELSE 'contact_id' END,
 match_confidence=CASE WHEN chosen IS NOT NULL THEN p_confidence END
 WHERE id=e.id RETURNING * INTO e;
 RETURN e;
END $$;

-- An unreceipted fresh capture activates history for that job without mass historical extraction.
CREATE FUNCTION public.context_extraction_events(p_job_id uuid,p_limit integer DEFAULT 25) RETURNS SETOF public.business_events
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH eligible AS (
 SELECT e.* FROM public.business_events e WHERE public.automation_lane_enabled('extraction') AND e.job_id=p_job_id
 AND e.attribution_status IN ('direct','thread','single_open','single_line','luna')
 AND btrim(public.context_event_text(e))<>''
 AND NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r WHERE r.event_id=e.id AND r.job_id=p_job_id AND r.extractor_version='luna_v2')
 AND EXISTS(SELECT 1 FROM public.business_events fresh WHERE fresh.job_id=p_job_id AND fresh.context_captured_at IS NOT NULL
  AND fresh.attribution_status IN ('direct','thread','single_open','single_line','luna') AND fresh.direction IS DISTINCT FROM 'outbound')
 ), anchor AS (
 SELECT e.* FROM public.business_events e WHERE e.job_id=p_job_id
 AND e.direction IS DISTINCT FROM 'outbound' AND e.attribution_status IN ('direct','thread','single_open','single_line','luna')
 AND btrim(public.context_event_text(e))<>''
 ORDER BY CASE WHEN EXISTS(SELECT 1 FROM eligible u WHERE u.id=e.id) THEN 0 ELSE 1 END,coalesce(e.event_at,e.occurred_at),e.id LIMIT 1
 ), combined AS (
 SELECT * FROM eligible UNION SELECT * FROM anchor WHERE EXISTS(SELECT 1 FROM eligible)
 ), selected AS (
 SELECT e.* FROM combined e WHERE EXISTS(SELECT 1 FROM anchor)
 ORDER BY CASE WHEN e.id=(SELECT id FROM anchor) THEN 0 ELSE 1 END,coalesce(e.event_at,e.occurred_at),e.id
 LIMIT greatest(0,least(coalesce(p_limit,25),25))
 ) SELECT * FROM selected ORDER BY coalesce(event_at,occurred_at),id
$$;
CREATE FUNCTION public.context_extraction_candidates(p_limit integer DEFAULT 400) RETURNS TABLE(job_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT e.job_id FROM public.business_events e WHERE public.automation_lane_enabled('extraction') AND e.job_id IS NOT NULL
 AND btrim(public.context_event_text(e))<>''
 AND EXISTS(SELECT 1 FROM public.business_events fresh WHERE fresh.job_id=e.job_id AND fresh.context_captured_at IS NOT NULL AND fresh.attribution_status IN ('direct','thread','single_open','single_line','luna') AND fresh.direction IS DISTINCT FROM 'outbound')
 AND e.attribution_status IN ('direct','thread','single_open','single_line','luna')
 AND NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r WHERE r.event_id=e.id AND r.job_id=e.job_id AND r.extractor_version='luna_v2')
 AND NOT EXISTS(SELECT 1 FROM public.context_extraction_runs r WHERE r.job_id=e.job_id AND r.run_date=(now() AT TIME ZONE 'Australia/Perth')::date AND r.phase='extraction' AND r.status IN ('done','skipped'))
 GROUP BY e.job_id ORDER BY EXISTS(SELECT 1 FROM public.context_extraction_runs retry WHERE retry.job_id=e.job_id AND retry.run_date=(now() AT TIME ZONE 'Australia/Perth')::date AND retry.phase='extraction' AND retry.status IN ('running','failed')) DESC,min(coalesce(e.event_at,e.occurred_at)),e.job_id LIMIT greatest(0,least(coalesce(p_limit,400),400))
$$;

REVOKE ALL ON FUNCTION public.context_event_text(public.business_events),public.context_contact_jobs(text),public.resolve_context_attribution(public.business_events),public.attribute_business_event(),public.rerun_context_attribution(integer,text),public.context_job_created_reconsider(),public.attribute_context_event_with_luna(uuid,uuid,numeric),public.context_extraction_events(uuid,integer),public.context_extraction_candidates(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_event_text(public.business_events),public.context_contact_jobs(text),public.rerun_context_attribution(integer,text),public.attribute_context_event_with_luna(uuid,uuid,numeric),public.context_extraction_events(uuid,integer),public.context_extraction_candidates(integer) TO service_role;
-- Attribute retained unmatched history in bounded batches without marking a fresh capture.
DO $$
DECLARE e public.business_events; resolved public.business_events; cursor_id uuid; batch_count integer;
BEGIN
 LOOP
  batch_count:=0;
  FOR e IN SELECT * FROM public.business_events WHERE attribution_status IS NULL
    AND btrim(public.context_event_text(business_events))<>'' AND (cursor_id IS NULL OR id>cursor_id)
    ORDER BY id LIMIT 250 LOOP
   resolved:=public.resolve_context_attribution(e);
   UPDATE public.business_events SET job_id=resolved.job_id,contact_id=resolved.contact_id,
    attribution_status=resolved.attribution_status,attribution_step=resolved.attribution_step,
    attribution_confidence=resolved.attribution_confidence,attributed_at=resolved.attributed_at,
    attribution_checked_at=resolved.attribution_checked_at,event_at=resolved.event_at,
    match_status=resolved.match_status,match_method=resolved.match_method,match_confidence=resolved.match_confidence,payload=resolved.payload,metadata=resolved.metadata WHERE id=e.id;
   cursor_id:=e.id; batch_count:=batch_count+1;
  END LOOP;
  EXIT WHEN batch_count=0;
 END LOOP;
END $$;
