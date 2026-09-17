-- Heartbeat: coverage of current facts, and one pipeline-status read.
-- Copied from cio/context-b4-recovery's context_accuracy_and_status packet
-- without the weekly accuracy tables or review functions. Two corrections
-- against that draft, both live-schema:
--   * missing_event_time counts rows where BOTH event_at and occurred_at are
--     null. event_at-only would flag ~33k healthy rows (PR 854; production
--     source time is coalesce(event_at, occurred_at)).
--   * coverage filters xero_invoices.invoice_type, the live column. The draft
--     read i.type, which production does not have.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE OR REPLACE FUNCTION public.context_coverage() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH facts AS (SELECT DISTINCT job_id FROM public.current_job_context_facts),
 evidence AS (SELECT DISTINCT job_id FROM public.business_events WHERE job_id IS NOT NULL),
 open_jobs AS (SELECT j.id FROM public.jobs j WHERE coalesce(j.status::text,'unknown') NOT IN ('cancelled','archived','lost','closed','complete','completed')),
 open_invoices AS (SELECT i.job_id FROM public.xero_invoices i WHERE upper(coalesce(i.status,''))='AUTHORISED' AND i.amount_due>0 AND upper(coalesce(i.invoice_type,'ACCREC'))='ACCREC')
 SELECT jsonb_build_object(
  'jobs',jsonb_build_object('total',(SELECT count(*) FROM open_jobs),'with_current_fact',(SELECT count(*) FROM open_jobs j JOIN facts f ON f.job_id=j.id),
   'no_current_fact',(SELECT count(*) FROM open_jobs j WHERE NOT EXISTS(SELECT 1 FROM facts f WHERE f.job_id=j.id)),
   'evidence_without_current_fact',(SELECT count(*) FROM open_jobs j WHERE NOT EXISTS(SELECT 1 FROM facts f WHERE f.job_id=j.id) AND EXISTS(SELECT 1 FROM evidence e WHERE e.job_id=j.id)),
   'no_evidence_yet',(SELECT count(*) FROM open_jobs j WHERE NOT EXISTS(SELECT 1 FROM facts f WHERE f.job_id=j.id) AND NOT EXISTS(SELECT 1 FROM evidence e WHERE e.job_id=j.id))),
  'invoices',jsonb_build_object('total',(SELECT count(*) FROM open_invoices),'with_current_fact',(SELECT count(*) FROM open_invoices i JOIN facts f ON f.job_id=i.job_id),
   'no_current_fact',(SELECT count(*) FROM open_invoices i WHERE i.job_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM facts f WHERE f.job_id=i.job_id)),
   'evidence_without_current_fact',(SELECT count(*) FROM open_invoices i WHERE i.job_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM facts f WHERE f.job_id=i.job_id) AND EXISTS(SELECT 1 FROM evidence e WHERE e.job_id=i.job_id)),
   'no_evidence_yet',(SELECT count(*) FROM open_invoices i WHERE i.job_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM facts f WHERE f.job_id=i.job_id) AND NOT EXISTS(SELECT 1 FROM evidence e WHERE e.job_id=i.job_id)),
   'unlinked',(SELECT count(*) FROM open_invoices WHERE job_id IS NULL)))
$$;

CREATE OR REPLACE FUNCTION public.context_pipeline_status() RETURNS jsonb
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
  'missing_event_time',(SELECT count(*) FROM public.business_events WHERE event_at IS NULL AND occurred_at IS NULL AND attribution_status NOT IN ('empty','automated')),
  'oldest_pending_event_at',(SELECT min(coalesce(e.event_at, e.occurred_at)) FROM public.business_events e WHERE e.attribution_status NOT IN ('empty','automated') AND NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r WHERE r.event_id=e.id AND r.job_id=e.job_id AND r.extractor_version='luna_v2')),
  'last_pass_finished_at',(SELECT max(finished_at) FROM public.context_pass_days WHERE status='done'),
  'today_pass',(SELECT to_jsonb(p) FROM public.context_pass_days p WHERE run_date=d),
  'coverage',public.context_coverage());
END $$;

REVOKE ALL ON FUNCTION public.context_coverage(),public.context_pipeline_status() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_coverage(),public.context_pipeline_status() TO service_role;
