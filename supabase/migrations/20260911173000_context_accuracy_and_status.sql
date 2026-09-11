-- B4: deterministic human-review samples, separate coverage and fail-closed stop signals.
CREATE TABLE public.context_accuracy_weeks (
 week_start date PRIMARY KEY CHECK(extract(isodow FROM week_start)=1),
 drawn_at timestamptz, n_sampled integer NOT NULL DEFAULT 0, n_true integer NOT NULL DEFAULT 0,
 n_false integer NOT NULL DEFAULT 0, n_wrong_job integer NOT NULL DEFAULT 0,
 missing_by_bucket jsonb NOT NULL DEFAULT '{}', coverage_jobs jsonb, coverage_invoices jsonb,
 published_at timestamptz, tripwire_reason text
);
CREATE TABLE public.context_accuracy_samples (
 week_start date NOT NULL REFERENCES public.context_accuracy_weeks(week_start),
 fact_id uuid NOT NULL, fact_store text NOT NULL CHECK(fact_store IN ('job_context','job_temporary_context')),
 bucket text NOT NULL CHECK(bucket IN ('scope','time_bound','repeat','random')),
 excerpt text NOT NULL, event_date date NOT NULL, fact_snapshot jsonb NOT NULL,
 source_event_ids uuid[] NOT NULL, verdict text CHECK(verdict IN ('true','false','wrong_job')),
 judged_by text, judged_user_id uuid REFERENCES public.users(id), judged_at timestamptz,
 invented_payment boolean NOT NULL DEFAULT false CHECK(NOT invented_payment OR verdict='false'),
 PRIMARY KEY(week_start,fact_id,fact_store),
 CHECK((verdict IS NULL AND judged_by IS NULL AND judged_user_id IS NULL AND judged_at IS NULL)
   OR (verdict IS NOT NULL AND judged_by IS NOT NULL AND judged_user_id IS NOT NULL AND judged_at IS NOT NULL))
);
CREATE TABLE public.context_accuracy_alerts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),week_start date NOT NULL REFERENCES public.context_accuracy_weeks(week_start),
 reason text NOT NULL CHECK(reason IN ('invented_payment','accuracy_two_weeks')),
 created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz,
 UNIQUE(week_start,reason)
);
ALTER TABLE public.context_accuracy_weeks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.context_accuracy_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.context_accuracy_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.context_accuracy_weeks,public.context_accuracy_samples,public.context_accuracy_alerts FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.context_accuracy_weeks,public.context_accuracy_samples,public.context_accuracy_alerts TO service_role;
GRANT UPDATE(delivered_at) ON public.context_accuracy_alerts TO service_role;

-- Source-backed sample population. Store the source excerpt at draw time so a
-- later correction cannot alter what the human reviewed. No client writes.
CREATE VIEW public.context_accuracy_population WITH(security_invoker=true) AS
SELECT f.id,f.job_id,f.kind,f._context_store,f.created_at,f.event_date,f.source_event_ids,
 to_jsonb(f)||jsonb_build_object('job_number',j.job_number,'job_type',j.type,'site_suburb',to_jsonb(j)->>'site_suburb') AS fact_snapshot,source.excerpt,
 EXISTS(SELECT 1 FROM public.jobs sibling WHERE sibling.id<>j.id AND nullif(j.ghl_contact_id,'') IS NOT NULL AND sibling.ghl_contact_id=j.ghl_contact_id) AS repeat_customer
FROM (
 SELECT id,job_id,kind,value,provenance,created_at,event_date,source_event_ids,extractor_version,'job_context'::text AS _context_store FROM public.job_context
 UNION ALL
 SELECT id,job_id,kind,value,provenance,created_at,event_date,source_event_ids,extractor_version,'job_temporary_context'::text AS _context_store FROM public.job_temporary_context
) f JOIN public.jobs j ON j.id=f.job_id
CROSS JOIN LATERAL (
 SELECT string_agg(public.context_event_text(b),E'\n\n' ORDER BY b.event_at,b.id) AS excerpt
 FROM public.business_events b WHERE b.id=ANY(f.source_event_ids) AND b.event_at IS NOT NULL
) source
WHERE f.extractor_version='luna_v2' AND f.event_date IS NOT NULL AND nullif(btrim(source.excerpt),'') IS NOT NULL;
REVOKE ALL ON public.context_accuracy_population FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.context_accuracy_population TO service_role;

CREATE FUNCTION public.context_coverage() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH facts AS (SELECT DISTINCT job_id FROM public.current_job_context_facts),
 open_jobs AS (SELECT j.id FROM public.jobs j WHERE coalesce(j.status::text,'unknown') NOT IN ('cancelled','archived','lost','closed','complete','completed')),
 open_invoices AS (SELECT i.job_id FROM public.xero_invoices i WHERE upper(coalesce(i.status,''))='AUTHORISED' AND i.amount_due>0 AND upper(coalesce(i.type,'ACCREC'))='ACCREC')
 SELECT jsonb_build_object(
  'jobs',jsonb_build_object('total',(SELECT count(*) FROM open_jobs),'with_current_fact',(SELECT count(*) FROM open_jobs j JOIN facts f ON f.job_id=j.id),
   'no_evidence_yet',(SELECT count(*) FROM open_jobs j WHERE NOT EXISTS(SELECT 1 FROM facts f WHERE f.job_id=j.id))),
  'invoices',jsonb_build_object('total',(SELECT count(*) FROM open_invoices),'with_current_fact',(SELECT count(*) FROM open_invoices i JOIN facts f ON f.job_id=i.job_id),
   'no_evidence_yet',(SELECT count(*) FROM open_invoices i WHERE i.job_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM facts f WHERE f.job_id=i.job_id)),
   'unlinked',(SELECT count(*) FROM open_invoices WHERE job_id IS NULL)))
$$;

CREATE FUNCTION public.context_accuracy_draw(p_week_start date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE bucket_name text; first_day date:=(date_trunc('week',now() AT TIME ZONE 'Australia/Perth'))::date; n integer; gaps jsonb:='{}'; existing public.context_accuracy_weeks;
BEGIN
 IF p_week_start IS NULL OR extract(isodow FROM p_week_start)<>1 OR p_week_start>=first_day THEN RAISE EXCEPTION 'context_accuracy_completed_week_required'; END IF;
 PERFORM pg_advisory_xact_lock(20260911,4);
 SELECT * INTO existing FROM public.context_accuracy_weeks WHERE week_start=p_week_start FOR UPDATE;
 IF FOUND AND existing.drawn_at IS NOT NULL THEN RETURN jsonb_build_object('outcome','idempotent','week',to_jsonb(existing)); END IF;
 INSERT INTO public.context_accuracy_weeks(week_start) VALUES(p_week_start) ON CONFLICT DO NOTHING;
 FOREACH bucket_name IN ARRAY ARRAY['scope','time_bound','repeat','random'] LOOP
  INSERT INTO public.context_accuracy_samples(week_start,fact_id,fact_store,bucket,excerpt,event_date,fact_snapshot,source_event_ids)
  SELECT p_week_start,p.id,p._context_store,bucket_name,p.excerpt,p.event_date,p.fact_snapshot,p.source_event_ids
  FROM public.context_accuracy_population p
  WHERE p.created_at >= (p_week_start::timestamp AT TIME ZONE 'Australia/Perth')
   AND p.created_at < ((p_week_start+7)::timestamp AT TIME ZONE 'Australia/Perth')
   AND (bucket_name='random' OR (bucket_name='scope' AND p.kind='scope_spec')
    OR (bucket_name='time_bound' AND p.kind IN ('current_state','pending_action','quote_issue')) OR (bucket_name='repeat' AND p.repeat_customer))
   AND NOT EXISTS(SELECT 1 FROM public.context_accuracy_samples s WHERE s.week_start=p_week_start AND s.fact_id=p.id AND s.fact_store=p._context_store)
  -- Save repeat-customer candidates for their own stratum where possible.
  ORDER BY CASE WHEN bucket_name IN ('scope','time_bound') THEN p.repeat_customer ELSE false END,
   md5(p_week_start::text||p._context_store||p.id::text) LIMIT 10;
  GET DIAGNOSTICS n=ROW_COUNT;
  gaps:=gaps||jsonb_build_object(bucket_name,10-n);
 END LOOP;
 UPDATE public.context_accuracy_weeks SET drawn_at=now(),n_sampled=(SELECT count(*) FROM public.context_accuracy_samples WHERE week_start=p_week_start),missing_by_bucket=gaps
 WHERE week_start=p_week_start RETURNING * INTO existing;
 RETURN jsonb_build_object('outcome','drawn','week',to_jsonb(existing));
END $$;

CREATE FUNCTION public.context_accuracy_publish(p_week_start date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE w public.context_accuracy_weeks; prior public.context_accuracy_weeks; coverage jsonb; bad boolean; reason text; n integer;
BEGIN
 PERFORM pg_advisory_xact_lock(20260911,4);
 SELECT * INTO w FROM public.context_accuracy_weeks WHERE week_start=p_week_start FOR UPDATE;
 IF NOT FOUND OR w.drawn_at IS NULL THEN RAISE EXCEPTION 'context_accuracy_draw_required'; END IF;
 SELECT count(*) FILTER(WHERE verdict='true'),count(*) FILTER(WHERE verdict='false'),count(*) FILTER(WHERE verdict='wrong_job'),count(*)
 INTO w.n_true,w.n_false,w.n_wrong_job,n FROM public.context_accuracy_samples WHERE week_start=p_week_start;
 coverage:=public.context_coverage();
 IF EXISTS(SELECT 1 FROM public.context_accuracy_samples WHERE week_start=p_week_start AND invented_payment AND verdict='false') THEN reason:='invented_payment'; END IF;
 bad:=w.n_wrong_job>2 OR (n=40 AND w.n_true+w.n_false+w.n_wrong_job=40 AND w.n_true<36);
 SELECT * INTO prior FROM public.context_accuracy_weeks WHERE week_start=p_week_start-7;
 IF reason IS NULL AND bad AND (prior.n_wrong_job>2 OR (prior.n_sampled=40 AND prior.n_true+prior.n_false+prior.n_wrong_job=40 AND prior.n_true<36))
 THEN reason:='accuracy_two_weeks'; END IF;
 UPDATE public.context_accuracy_weeks SET n_sampled=n,n_true=w.n_true,n_false=w.n_false,n_wrong_job=w.n_wrong_job,
  coverage_jobs=coverage->'jobs',coverage_invoices=coverage->'invoices',
  published_at=CASE WHEN n>0 AND w.n_true+w.n_false+w.n_wrong_job=n THEN coalesce(published_at,now()) ELSE NULL END,
  tripwire_reason=coalesce(reason,tripwire_reason) WHERE week_start=p_week_start RETURNING * INTO w;
 IF reason IS NOT NULL THEN
  -- Missing switch remains off; never recreate a deleted operator switch row.
  UPDATE public.automation_switches SET extraction=false,updated_at=now(),updated_by='context_accuracy_publish',note='accuracy tripwire '||p_week_start::text WHERE id=1;
  INSERT INTO public.context_accuracy_alerts(week_start,reason) VALUES(p_week_start,reason) ON CONFLICT DO NOTHING;
 END IF;
 RETURN jsonb_build_object('week',to_jsonb(w),'accuracy',CASE WHEN w.published_at IS NOT NULL THEN w.n_true::numeric/n ELSE NULL END,
  'reviewed',w.n_true+w.n_false+w.n_wrong_job,'requested',40,'missing',40-n,
  'review_complete',w.published_at IS NOT NULL,'sample_sufficient',n=40,'complete',n=40 AND w.published_at IS NOT NULL,'extraction_stopped',reason IS NOT NULL);
END $$;

CREATE FUNCTION public.record_context_accuracy_verdict(p_week_start date,p_fact_id uuid,p_fact_store text,p_verdict text,p_actor_id uuid,p_invented_payment boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor_name text;
BEGIN
 -- p_actor_id comes ONLY from the API's verified human JWT, never judged_by input.
 SELECT name INTO actor_name FROM public.users WHERE id=p_actor_id AND role IN ('admin','owner','ops_manager');
 IF nullif(btrim(actor_name),'') IS NULL THEN RAISE EXCEPTION 'context_accuracy_human_actor_required'; END IF;
 IF p_verdict IS NULL OR p_verdict NOT IN ('true','false','wrong_job') OR p_invented_payment IS NULL OR (p_invented_payment AND p_verdict<>'false') THEN RAISE EXCEPTION 'context_accuracy_verdict_invalid'; END IF;
 PERFORM pg_advisory_xact_lock(20260911,4);
 IF EXISTS(SELECT 1 FROM public.context_accuracy_samples WHERE week_start=p_week_start AND fact_id=p_fact_id AND fact_store=p_fact_store
   AND verdict=p_verdict AND judged_user_id=p_actor_id AND invented_payment=p_invented_payment) THEN RETURN public.context_accuracy_publish(p_week_start); END IF;
 UPDATE public.context_accuracy_samples SET verdict=p_verdict,judged_by=actor_name,judged_user_id=p_actor_id,judged_at=now(),invented_payment=p_invented_payment
 WHERE week_start=p_week_start AND fact_id=p_fact_id AND fact_store=p_fact_store;
 IF NOT FOUND THEN RAISE EXCEPTION 'context_accuracy_sample_missing'; END IF;
 RETURN public.context_accuracy_publish(p_week_start);
END $$;

CREATE FUNCTION public.context_pipeline_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d date:=(now() AT TIME ZONE 'Australia/Perth')::date; switches jsonb; queue jsonb; calls integer; call_state text:='available'; ready integer;
BEGIN
 SELECT to_jsonb(s) INTO switches FROM public.automation_switches s WHERE id=1;
 SELECT jsonb_object_agg(status,n) INTO queue FROM (SELECT coalesce(e.attribution_status,'unknown') status,count(*) n
 FROM public.business_events e WHERE NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r WHERE r.event_id=e.id AND r.job_id=e.job_id AND r.extractor_version='luna_v2')
 GROUP BY e.attribution_status) q;
 BEGIN
  EXECUTE 'SELECT count(*) FROM public.context_model_call_reservations WHERE run_date=$1' INTO calls USING d;
 EXCEPTION WHEN OTHERS THEN calls:=NULL;call_state:='unavailable'; END;
 SELECT count(*) INTO ready FROM public.context_extraction_candidates(400);
 RETURN jsonb_build_object('as_of',now(),'run_date',d,'switches',switches,
  'lanes',jsonb_build_object('capture',public.automation_lane_enabled('capture'),'attribution',public.automation_lane_enabled('attribution'),'extraction',public.automation_lane_enabled('extraction')),
  'runs_used',(SELECT count(*) FROM public.context_extraction_runs WHERE run_date=d AND phase='extraction'),'run_cap',400,
  'model_calls_used',calls,'model_call_cap',400,'model_call_budget_state',call_state,
  'evidence_by_attribution_status',coalesce(queue,'{}'::jsonb),'ready_jobs',ready,'ready_jobs_is_lower_bound',ready=400,
  'admin_bucket_size',(SELECT count(*) FROM public.business_events WHERE attribution_status='admin_bucket'),
  'missing_event_time',(SELECT count(*) FROM public.business_events WHERE event_at IS NULL AND attribution_status NOT IN ('empty','automated')),
  'oldest_pending_event_at',(SELECT min(e.event_at) FROM public.business_events e WHERE e.attribution_status NOT IN ('empty','automated') AND NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r WHERE r.event_id=e.id AND r.job_id=e.job_id AND r.extractor_version='luna_v2')),
  'last_pass_finished_at',(SELECT max(finished_at) FROM public.context_pass_days WHERE status='done'),
  'today_pass',(SELECT to_jsonb(p) FROM public.context_pass_days p WHERE run_date=d),
  'coverage',public.context_coverage(),
  'latest_accuracy_week',(SELECT to_jsonb(w)||jsonb_build_object('requested',40,'missing',40-w.n_sampled,
    'reviewed',w.n_true+w.n_false+w.n_wrong_job,'sample_sufficient',w.n_sampled=40,
    'review_complete',w.n_sampled>0 AND w.n_true+w.n_false+w.n_wrong_job=w.n_sampled,
    'accuracy',CASE WHEN w.n_sampled>0 AND w.n_true+w.n_false+w.n_wrong_job=w.n_sampled THEN w.n_true::numeric/w.n_sampled ELSE NULL END)
   FROM public.context_accuracy_weeks w ORDER BY week_start DESC LIMIT 1),
  'accuracy_alerts',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY created_at),'[]'::jsonb) FROM public.context_accuracy_alerts a WHERE delivered_at IS NULL));
END $$;
REVOKE ALL ON FUNCTION public.context_coverage(),public.context_accuracy_draw(date),public.context_accuracy_publish(date),public.record_context_accuracy_verdict(date,uuid,text,text,uuid,boolean),public.context_pipeline_status() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_coverage(),public.context_accuracy_draw(date),public.context_accuracy_publish(date),public.record_context_accuracy_verdict(date,uuid,text,text,uuid,boolean),public.context_pipeline_status() TO service_role;
