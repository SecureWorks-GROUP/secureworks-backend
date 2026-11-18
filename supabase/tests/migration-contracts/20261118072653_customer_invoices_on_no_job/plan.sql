-- Standalone private cluster. Explain the function's own SELECT: an EXPLAIN
-- of the SECURITY DEFINER call itself shows only a Function Scan.
BEGIN;
INSERT INTO public.organisations VALUES ('f3030001-0000-4000-8000-000000000001','ZZTEST plan');
INSERT INTO public.jobs VALUES ('f3030001-0000-4000-8000-000000000003',
  'f3030001-0000-4000-8000-000000000001','ZZTEST-P3031','in_progress','fencing');
INSERT INTO public.xero_invoices(org_id,xero_invoice_id,job_id,invoice_type,invoice_date,status,line_items)
SELECT 'f3030001-0000-4000-8000-000000000001','ZZTEST-'||i,
       CASE WHEN i>3 THEN 'f3030001-0000-4000-8000-000000000003'::uuid END,
       'ACCREC','2026-07-01','AUTHORISED','[{"LineItemID":"line"}]'
FROM generate_series(1,10000) i;
INSERT INTO public.bookkeeping_evidence_revisions
  (revision,stream,schema,emitted_at,sha256,facts_in_file,facts_sent,status)
SELECT 'ZZTEST-'||i,'ZZTEST','ZZTEST',now(),repeat('0',64),1,1,
       CASE WHEN i%2=0 THEN 'current' ELSE 'superseded' END
FROM generate_series(1,10000) i;
INSERT INTO public.bookkeeping_line_evidence
  (revision,xero_invoice_id,xero_line_item_id,allocation,evidenced,job_id,fact)
SELECT 'ZZTEST-'||i,'ZZTEST-'||i,'line','job',true,'f3030001-0000-4000-8000-000000000003','{}'
FROM generate_series(1,10000) i;
ANALYZE public.xero_invoices;
ANALYZE public.bookkeeping_evidence_revisions;
ANALYZE public.bookkeeping_line_evidence;
DO $plan$
DECLARE
  query text;
  plan jsonb;
  source text;
BEGIN
  SELECT prosrc INTO STRICT query FROM pg_proc
  WHERE oid='public.customer_invoices_on_no_job(uuid,date,date)'::regprocedure;
  query := replace(replace(replace(query,'p_as_of','$2'),'p_from','$3'),'p_org_id','$1');
  EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON) ' || query INTO plan
    USING 'f3030001-0000-4000-8000-000000000001'::uuid,'2026-07-02'::date,'2026-07-01'::date;
  RAISE DEBUG 'P3-03.1 plan: %', plan;
  FOREACH source IN ARRAY ARRAY['xero_invoices','bookkeeping_line_evidence','bookkeeping_evidence_revisions'] LOOP
    IF NOT EXISTS (
      SELECT FROM jsonb_path_query(plan,'strict $.** ? (@."Relation Name" == $table)',
                                   jsonb_build_object('table',source)) AS n
      WHERE n->>'Node Type' IN ('Index Scan','Index Only Scan','Bitmap Heap Scan')
        AND ((n->>'Actual Rows')::numeric + coalesce((n->>'Rows Removed by Filter')::numeric,0))
            * (n->>'Actual Loops')::numeric <= 6
    ) OR EXISTS (
      SELECT FROM jsonb_path_query(plan,'strict $.** ? (@."Relation Name" == $table)',
                                   jsonb_build_object('table',source)) AS n
      WHERE n->>'Node Type'='Seq Scan'
    ) THEN RAISE EXCEPTION 'unbounded % read: %', source, plan; END IF;
  END LOOP;
  RAISE NOTICE 'PASS: bounded index reads on three 10000-row tables for three candidates';
END $plan$;
ROLLBACK;
