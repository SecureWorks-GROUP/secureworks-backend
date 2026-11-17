BEGIN;
-- Twenty thousand unrelated lines (including ten thousand linked followers),
-- plus one selected bill and three candidate followers.
-- This is a scaling fixture, not a claim about production wall time.
INSERT INTO public.job_cost_lines
 (id,org_id,document_kind,document_id,line_key,kind,lane,amount_ex,state,source_hash,follows_line_id)
SELECT ('91000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 '91000000-0000-4000-8001-000000000001'::uuid,
 CASE WHEN n<=10000 THEN 'xero_bill' ELSE 'xero_credit_note' END,'ZZTEST-FU11-bulk-'||n,
 '1',CASE WHEN n<=10000 THEN 'supplier_bill' ELSE 'supplier_credit' END,
 'materials',1,'needs_person','ZZTEST-FU11-plan',
 CASE WHEN n>10000 THEN ('91000000-0000-4000-8000-'||lpad((n-9999)::text,12,'0'))::uuid ELSE NULL END
FROM generate_series(1,20000) n;
INSERT INTO public.job_cost_lines
 (id,org_id,document_kind,document_id,line_key,kind,lane,amount_ex,state,source_hash,
 follows_line_id,follows_document_kind,follows_document_id)
SELECT ('92000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 '91000000-0000-4000-8001-000000000001'::uuid,'xero_credit_note','ZZTEST-FU11-plan-credit-'||n,
 '1','supplier_credit','materials',-1,'needs_person','ZZTEST-FU11-plan',
 CASE WHEN n=2 THEN NULL ELSE '91000000-0000-4000-8000-000000000001'::uuid END,
 CASE WHEN n IN (2,3) THEN 'xero_bill' ELSE NULL END,
 CASE WHEN n IN (2,3) THEN 'ZZTEST-FU11-bulk-1' ELSE NULL END
FROM generate_series(1,3) n;
ANALYZE public.job_cost_lines;
DO $$ DECLARE query text; plan jsonb; mode text; BEGIN
 -- Explain the selector taken from the actual installed function, not a copy.
 query := split_part(split_part(pg_get_functiondef(
   'public.job_cost_lines_refollow(text,text)'::regprocedure), '  FOR f IN', 2), E'\n  LOOP', 1);
 IF query IS NULL THEN RAISE EXCEPTION 'FU11: selector not found'; END IF;
 query := replace(replace(query,'p_document_kind','$1'),'p_document_id','$2');
 EXECUTE 'PREPARE fu11_candidates(text,text) AS '||query;
 FOREACH mode IN ARRAY ARRAY['force_custom_plan','force_generic_plan'] LOOP
   PERFORM set_config('plan_cache_mode',mode,true);
   EXECUTE 'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) EXECUTE fu11_candidates(''xero_bill'',''ZZTEST-FU11-bulk-1'')'
     INTO plan;
   RAISE NOTICE 'FU11 EXPLAIN %: %',mode,plan;
   IF plan::text NOT LIKE '%job_cost_lines_follows_line_idx%'
     OR plan::text NOT LIKE '%job_cost_lines_document_idx%'
     OR plan::text NOT LIKE '%job_cost_lines_follows_document_idx%'
     OR plan::text LIKE '%Seq Scan%'
     OR (plan->0->'Plan'->>'Actual Rows')::int <> 3 THEN
     RAISE EXCEPTION 'FU11: expected indexed candidate read';
   END IF;
 END LOOP;
 DEALLOCATE fu11_candidates;
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
