-- Down for 20260924213000 (P4): disable P4, restore the two live production
-- bodies byte for byte, and drop P4's functions. Rows placed, rested or stamped
-- under P4 keep what they have; event_threads keeps its retirement columns and
-- rows (P1a's ladder does not read them), and the flag row stays off.
--   resolve_context_attribution(business_events)  md5(prosrc) fe50f14f4ab28d4d6c9dbb70bc85e7df (P1a)
--   attribute_business_event()                    md5(prosrc) 7c1b8ffeeed8829288ee42c30e4314e5 (K1)
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

UPDATE public.feature_flags SET enabled=false,updated_at=clock_timestamp()
WHERE flag_name='context_unlinked_rules_v1';

-- Refuse to overwrite a later change: each body must be P4's (or already the
-- restored live body, for a repeated rollback).
DO $guard$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.attribute_context_event_with_luna(uuid,uuid,numeric)',ARRAY['fde44559c43dcc770d1c42909f4adeaf','62ed28cbcf041d7cdcda298907a756fa']),
  ('public.attribute_context_event_with_luna(uuid,uuid,numeric,text)',ARRAY['cbb46324b06a0f5b6c3f5ddf695ddb1a','11c9fb6fedce9cdd4a730e461d5a6fda']),
  ('public.resolve_context_attribution(public.business_events)',ARRAY['32365101d23dde1695707a0bddff640b','fe50f14f4ab28d4d6c9dbb70bc85e7df']),
  ('public.attribute_business_event()',ARRAY['d0036a1bc36f4b2a779f4a8b192cd687','7c1b8ffeeed8829288ee42c30e4314e5'])
 ) AS t(sig,accepted) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_unlinked_rules_rollback_mismatch: %; a later change must be rolled back first',array_to_string(problems,'; ');
 END IF;
END $guard$;

UPDATE public.event_threads SET thread_key='retired:'||thread_key
WHERE retired_at IS NOT NULL;

-- The trigger first, so no insert reaches a dropped function.
CREATE OR REPLACE FUNCTION public.attribute_business_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.context_captured_at IS NULL THEN
    NEW.context_captured_at := clock_timestamp();
  END IF;
  NEW := public.resolve_context_attribution(NEW);
  NEW.metadata := coalesce(NEW.metadata, '{}'::jsonb) || jsonb_build_object('written_as', public.context_request_role());
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.resolve_context_attribution(e public.business_events) RETURNS public.business_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE words text; tokens text; ids uuid[]; candidate uuid; n int; line text; contact_ids text[]; prior_status text; source_method text;
 v_at timestamptz; is_ghl boolean; line_ids uuid[]; guard_ids uuid[]; contactless_ids uuid[]; used_updated_at boolean; rule text;
BEGIN
 prior_status:=e.attribution_status;
 source_method:=e.match_method;
 IF e.job_id IS NOT NULL AND source_method IN ('direct_job_id','direct_reference','manual') THEN
   e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('source_job_binding',jsonb_build_object('job_id',e.job_id,'match_method',source_method));
 ELSIF e.job_id IS NULL AND e.metadata->'source_job_binding'->>'match_method' IN ('direct_job_id','direct_reference','manual') THEN
   SELECT id INTO e.job_id FROM public.jobs WHERE id::text=e.metadata->'source_job_binding'->>'job_id';
   source_method:=e.metadata->'source_job_binding'->>'match_method';
 END IF;
 IF e.job_id IS NOT NULL AND coalesce(source_method,'none') NOT IN ('direct_job_id','direct_reference','manual') THEN
   e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('attribution_hint',jsonb_build_object('job_id',e.job_id,'match_method',source_method,'match_confidence',e.match_confidence));
   e.job_id:=NULL;
 END IF;
 e.attribution_checked_at:=clock_timestamp();
 words:=public.context_event_text(e);
 e.attribution_status:='admin_bucket'; e.attribution_step:=6;
 e.attribution_confidence:=NULL; e.attributed_at:=NULL;
 e.match_status:='unresolved'; e.match_method:='none'; e.match_confidence:=NULL;
 e.candidate_job_ids:=NULL;
 IF e.metadata ?| ARRAY['placement_rule','placement_contactless_job_ids','placement_guard_job_ids'] THEN
  e.metadata:=e.metadata-'placement_rule'-'placement_contactless_job_ids'-'placement_guard_job_ids';
 END IF;
 IF e.payload ? 'terminal_time_source' THEN e.payload:=e.payload-'terminal_time_source'; END IF;
 IF NOT public.automation_lane_enabled('attribution') THEN e.job_id:=NULL; RETURN e; END IF;
 IF to_jsonb(e)->>'channel' IN ('system','audit') THEN e.attribution_status:='automated'; RETURN e; END IF;
 IF btrim(words)='' THEN e.attribution_status:='empty'; RETURN e; END IF;
 IF prior_status='automated' OR e.payload->>'automated'='true' OR e.payload->>'auto_submitted' IN ('auto-generated','auto-replied')
 THEN e.attribution_status:='automated'; RETURN e; END IF;
 is_ghl:=public.context_event_is_ghl(e);
 SELECT id INTO candidate FROM public.jobs WHERE id=e.job_id;
 IF candidate IS NULL THEN
   tokens:=' '||upper(regexp_replace(words,'[^a-zA-Z0-9-]+',' ','g'))||' ';
   SELECT array_agg(DISTINCT refs.job_id) INTO ids FROM (
     SELECT j.id AS job_id FROM public.jobs j WHERE length(btrim(j.job_number))>=5
      AND strpos(tokens,' '||upper(j.job_number)||' ')>0
     UNION SELECT x.job_id FROM public.xero_invoices x WHERE x.job_id IS NOT NULL
      AND x.invoice_type='ACCREC' AND upper(x.invoice_number) LIKE 'INV-%' AND length(btrim(x.invoice_number))>=5
      AND strpos(tokens,' '||upper(x.invoice_number)||' ')>0
     UNION SELECT po.job_id FROM public.purchase_orders po WHERE po.job_id IS NOT NULL AND length(btrim(po.po_number))>=5
      AND strpos(tokens,' '||upper(po.po_number)||' ')>0
   ) refs JOIN public.jobs ref_job ON ref_job.id=refs.job_id
   WHERE coalesce(to_jsonb(ref_job)->'metadata'->>'do_not_schedule','') NOT IN ('true','1');
   IF cardinality(ids)=1 THEN candidate:=ids[1];
   ELSIF cardinality(ids)>1 THEN e.job_id:=NULL; RETURN e; END IF;
 END IF;
 IF candidate IS NOT NULL THEN e.attribution_status:='direct'; e.attribution_step:=1;
 ELSE
  IF NOT is_ghl THEN
   SELECT job_id INTO candidate FROM public.event_threads WHERE thread_key=e.thread_key;
  END IF;
  IF candidate IS NOT NULL THEN e.attribution_status:='thread'; e.attribution_step:=2;
  ELSE
   IF e.contact_id IS NULL THEN
    SELECT array_agg(DISTINCT j.ghl_contact_id) INTO contact_ids FROM public.jobs j
    WHERE j.ghl_contact_id IS NOT NULL AND (
      (nullif(e.payload->>'email','') IS NOT NULL AND lower(to_jsonb(j)->>'client_email')=lower(e.payload->>'email')) OR
      (length(regexp_replace(coalesce(e.payload->>'phone',''),'[^0-9]','','g'))>=8 AND
       right(regexp_replace(coalesce(to_jsonb(j)->>'client_phone',to_jsonb(j)->>'phone',''),'[^0-9]','','g'),9)=right(regexp_replace(e.payload->>'phone','[^0-9]','','g'),9)));
    IF cardinality(contact_ids)=1 THEN e.contact_id:=contact_ids[1]; END IF;
   END IF;
   v_at:=coalesce(e.event_at,e.occurred_at,clock_timestamp());
   line:=lower(coalesce(e.payload->>'line',e.payload->>'business_line',''));
   SELECT coalesce(array_agg(t.job_id ORDER BY t.created_at,t.job_id) FILTER (WHERE t.candidate),'{}'),
    coalesce(array_agg(t.job_id ORDER BY t.created_at,t.job_id) FILTER (WHERE t.candidate AND t.type=line AND line IN ('fencing','patio')),'{}'),
    coalesce(array_agg(t.job_id ORDER BY t.terminal_at DESC,t.job_id) FILTER (WHERE NOT t.candidate AND t.terminal
     AND t.created_at<=v_at AND t.terminal_at<=v_at AND t.terminal_at>=v_at-interval '90 days'),'{}'),
    coalesce(array_agg(t.job_id ORDER BY t.job_id) FILTER (WHERE t.basis='contactless' AND (t.candidate OR (NOT t.candidate AND t.terminal
     AND t.created_at<=v_at AND t.terminal_at<=v_at AND t.terminal_at>=v_at-interval '90 days'))),'{}'),
    coalesce(bool_or(t.terminal_time_source='updated_at' AND (t.candidate OR (NOT t.candidate AND t.terminal
     AND t.created_at<=v_at AND t.terminal_at<=v_at AND t.terminal_at>=v_at-interval '90 days'))),false)
   INTO ids,line_ids,guard_ids,contactless_ids,used_updated_at
   FROM public.context_contact_job_timeline(e.contact_id,v_at) t;
   n:=cardinality(ids);
   IF n=1 AND cardinality(guard_ids)=0 THEN
    candidate:=ids[1]; e.attribution_status:='single_open'; e.attribution_step:=3; rule:='single_open';
   ELSIF n=1 THEN
    e.attribution_status:='pending_luna'; e.attribution_step:=5; rule:='review_recent_other_job';
    e.candidate_job_ids:=ids||guard_ids;
   ELSIF n>1 AND cardinality(line_ids)=1 THEN
    candidate:=line_ids[1]; e.attribution_status:='single_line'; e.attribution_step:=4; rule:='single_line';
   ELSIF n>1 THEN
    e.attribution_status:='pending_luna'; e.attribution_step:=5; rule:='review_several';
    e.candidate_job_ids:=ids;
   ELSE
    rule:=CASE WHEN e.contact_id IS NULL THEN 'no_contact' ELSE 'no_candidate_at_time' END;
   END IF;
   e.metadata:=coalesce(e.metadata,'{}'::jsonb)||jsonb_build_object('placement_rule',rule);
   IF cardinality(contactless_ids)>0 THEN
    e.metadata:=e.metadata||jsonb_build_object('placement_contactless_job_ids',to_jsonb(contactless_ids));
   END IF;
   IF rule='review_recent_other_job' THEN
    e.metadata:=e.metadata||jsonb_build_object('placement_guard_job_ids',to_jsonb(guard_ids));
   END IF;
   IF used_updated_at THEN e.payload:=coalesce(e.payload,'{}'::jsonb)||jsonb_build_object('terminal_time_source','updated_at'); END IF;
  END IF;
 END IF;
 e.job_id:=candidate;
 IF candidate IS NOT NULL THEN
  IF nullif(e.thread_key,'') IS NOT NULL AND NOT is_ghl THEN
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
 e.attribution_confidence:=NULL; e.attributed_at:=NULL; e.candidate_job_ids:=NULL;
 e.match_status:='unresolved'; e.match_method:='none'; e.match_confidence:=NULL;
 e.payload:=coalesce(e.payload,'{}')||jsonb_build_object('attribution_error',SQLERRM);
 RETURN e;
END $$;

-- The live entry carried no comment; P4's would outlive CREATE OR REPLACE.
COMMENT ON FUNCTION public.resolve_context_attribution(public.business_events) IS NULL;

DROP FUNCTION IF EXISTS public.context_attribution_preview(uuid,boolean);
DROP FUNCTION IF EXISTS public.resolve_context_attribution(public.business_events,boolean,boolean);
DROP FUNCTION IF EXISTS public.context_ladder_p1a(public.business_events,boolean);
DROP FUNCTION IF EXISTS public.context_contact_jobs_at(text,timestamptz,text,text);
DROP FUNCTION IF EXISTS public.context_contact_job_timeline(text,timestamptz,text,text);
DROP FUNCTION IF EXISTS public.context_job_unpaid_at(uuid,timestamptz);
DROP FUNCTION IF EXISTS public.context_sender_key(public.business_events);
DROP FUNCTION IF EXISTS public.context_supplier_order_tokens(text);
DROP FUNCTION IF EXISTS public.context_unlinked_rules_enabled();

-- The live ACL of the two restored objects (postgres and service_role).
REVOKE ALL ON FUNCTION public.resolve_context_attribution(public.business_events),public.attribute_business_event() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_context_attribution(public.business_events),public.attribute_business_event() TO service_role;

CREATE OR REPLACE FUNCTION public.attribute_context_event_with_luna(p_event_id uuid,p_job_id uuid,p_confidence numeric)
RETURNS public.business_events LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e public.business_events; chosen uuid;
BEGIN
 IF NOT public.automation_lane_enabled('attribution') THEN RAISE EXCEPTION 'attribution disabled'; END IF;
 SELECT * INTO e FROM public.business_events WHERE id=p_event_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'event not found'; END IF;
 IF e.attribution_status IS DISTINCT FROM 'pending_luna' THEN RAISE EXCEPTION 'event is not pending Luna'; END IF;
 IF p_job_id IS NOT NULL THEN
  IF p_confidence IS NULL OR p_confidence<0 OR p_confidence>1 OR p_confidence='NaN'::numeric THEN RAISE EXCEPTION 'invalid confidence'; END IF;
  IF NOT (p_job_id=ANY(coalesce(e.candidate_job_ids,ARRAY(SELECT c.job_id FROM public.context_contact_jobs_at(e.contact_id,coalesce(e.event_at,e.occurred_at)) c))))
  THEN RAISE EXCEPTION 'job is not a contact candidate'; END IF;
  chosen:=p_job_id;
  IF nullif(e.thread_key,'') IS NOT NULL AND NOT public.context_event_is_ghl(e) THEN
   INSERT INTO public.event_threads(thread_key,job_id,bound_by,source_event_id) VALUES(e.thread_key,p_job_id,'luna',e.id) ON CONFLICT DO NOTHING;
   SELECT job_id INTO chosen FROM public.event_threads WHERE thread_key=e.thread_key;
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

CREATE OR REPLACE FUNCTION public.attribute_context_event_with_luna(p_event_id uuid,p_job_id uuid,p_confidence numeric,p_outcome text)
RETURNS public.business_events LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e public.business_events; chosen uuid; v_outcome text:=p_outcome; v_now timestamptz:=clock_timestamp(); v_note jsonb;
BEGIN
 IF NOT public.automation_lane_enabled('attribution') THEN RAISE EXCEPTION 'attribution disabled'; END IF;
 IF p_outcome IS NULL OR p_outcome NOT IN ('job','several','undecided') THEN RAISE EXCEPTION 'invalid attribution outcome'; END IF;
 IF p_outcome='job' AND p_job_id IS NULL THEN RAISE EXCEPTION 'job outcome needs a job'; END IF;
 IF p_outcome<>'job' AND p_job_id IS NOT NULL THEN RAISE EXCEPTION 'several or undecided names no job'; END IF;
 SELECT * INTO e FROM public.business_events WHERE id=p_event_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'event not found'; END IF;
 IF e.attribution_status IS DISTINCT FROM 'pending_luna' THEN RAISE EXCEPTION 'event is not pending Luna'; END IF;
 v_note:=jsonb_build_object('luna_outcome',p_outcome,'luna_outcome_at',v_now);
 IF p_outcome='job' THEN
  IF p_confidence IS NULL OR p_confidence<0 OR p_confidence>1 OR p_confidence='NaN'::numeric THEN RAISE EXCEPTION 'invalid confidence'; END IF;
  IF NOT (p_job_id=ANY(coalesce(e.candidate_job_ids,ARRAY(SELECT c.job_id FROM public.context_contact_jobs_at(e.contact_id,coalesce(e.event_at,e.occurred_at)) c))))
  THEN RAISE EXCEPTION 'job is not a contact candidate'; END IF;
  IF p_confidence<0.8 THEN
   -- Below the floor: honestly unknown beats confidently wrong. Rest it.
   v_outcome:='undecided';
   v_note:=jsonb_build_object('luna_outcome','undecided','luna_outcome_at',v_now,
    'luna_below_floor',jsonb_build_object('job_id',p_job_id,'confidence',p_confidence));
  END IF;
 END IF;
 IF v_outcome='job' THEN
  chosen:=p_job_id;
  IF nullif(e.thread_key,'') IS NOT NULL AND NOT public.context_event_is_ghl(e) THEN
   INSERT INTO public.event_threads(thread_key,job_id,bound_by,source_event_id) VALUES(e.thread_key,p_job_id,'luna',e.id) ON CONFLICT DO NOTHING;
   SELECT job_id INTO chosen FROM public.event_threads WHERE thread_key=e.thread_key;
   -- A racing reply follows the thread winner; it never overwrites that binding.
   IF chosen<>p_job_id THEN p_confidence:=1; END IF;
  END IF;
  UPDATE public.business_events SET job_id=chosen,
   attribution_status=CASE WHEN chosen<>p_job_id THEN 'thread' ELSE 'luna' END,
   attribution_step=CASE WHEN chosen<>p_job_id THEN 2 ELSE 5 END,
   attribution_confidence=p_confidence,attributed_at=v_now,attribution_checked_at=v_now,
   match_status='matched',match_method='contact_id',match_confidence=p_confidence,
   metadata=coalesce(metadata,'{}'::jsonb)||v_note
  WHERE id=e.id RETURNING * INTO e;
 ELSE
  -- Resting: off every job, candidates kept, never selected again by the
  -- bucket re-run or the Luna page; shown in each candidate's not-yet-placed lane.
  UPDATE public.business_events SET job_id=NULL,attribution_status='unplaced',attribution_step=5,
   attribution_confidence=NULL,attributed_at=NULL,attribution_checked_at=v_now,
   match_status='unresolved',match_method='none',match_confidence=NULL,
   metadata=coalesce(metadata,'{}'::jsonb)||v_note
  WHERE id=e.id RETURNING * INTO e;
 END IF;
 PERFORM public.context_attribution_record_attempt(e,v_outcome,NULL);
 RETURN e;
END $$;
