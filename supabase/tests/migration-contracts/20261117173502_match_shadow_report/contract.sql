BEGIN;
INSERT INTO public.jobs(id,org_id,job_number,type,status) VALUES
('35020000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000001','ZZTEST-3502','fencing','accepted'),
('35020000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000001','ZZTEST-3503','fencing','accepted');
INSERT INTO public.xero_invoices(xero_invoice_id,invoice_type,sub_total) VALUES
('ZZTEST-shadow-1','ACCPAY',100),('ZZTEST-shadow-2','ACCPAY',200),('ZZTEST-shadow-3','ACCPAY',300);
INSERT INTO public.job_materials_facts(org_id,xero_invoice_id,job_id,amount_ex_gst,confidence,automation_source) VALUES
('00000000-0000-0000-0000-000000000001','ZZTEST-shadow-1','35020000-0000-4000-8000-000000000001',100,'high','xero_ref_link'),
('00000000-0000-0000-0000-000000000001','ZZTEST-shadow-2','35020000-0000-4000-8000-000000000002',200,'high','xero_ref_link');
INSERT INTO public.match_shadow_runs(subject_kind,subject_id,run_id,result,stops,rule_version,created_at) VALUES
('cost_document','xero_bill:ZZTEST-shadow-1','35020000-0000-4000-8000-000000000011','{"result":"none"}','[]','v1',now()-interval '1 hour'),
('cost_document','xero_bill:ZZTEST-shadow-1','35020000-0000-4000-8000-000000000012','{"result":"auto","job_id":"35020000-0000-4000-8000-000000000001"}','[]','v1',now()),
('cost_document','xero_bill:ZZTEST-shadow-2','35020000-0000-4000-8000-000000000013','{"result":"auto","job_id":"35020000-0000-4000-8000-000000000001"}','[]','v1',now()),
('cost_document','xero_bill:ZZTEST-shadow-3','35020000-0000-4000-8000-000000000014','{"result":"none"}','[{"code":"ZZTEST-stop"}]','v1',now());
DO $$
DECLARE r jsonb;
BEGIN
 r:=public.match_shadow_report();
 IF (r->>'documents')::int<>3 OR (r->>'dollars')::numeric<>600 OR (r#>>'{auto,count}')::int<>2 OR (r#>>'{auto,dollars}')::numeric<>300 OR (r#>>'{auto,same_job_as_legacy}')::int<>1 OR (r#>>'{none,count}')::int<>1 THEN RAISE EXCEPTION 'shadow report: totals'; END IF;
 IF NOT (r#>'{auto,different_job}') @> '[{"subject_id":"xero_bill:ZZTEST-shadow-2","matcher_job":"35020000-0000-4000-8000-000000000001","legacy_job":"35020000-0000-4000-8000-000000000002"}]'::jsonb THEN RAISE EXCEPTION 'shadow report: different job'; END IF;
 IF r#>>'{stops,ZZTEST-stop}' IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'shadow report: stops'; END IF;
 IF has_function_privilege('authenticated','public.match_shadow_report(integer)','EXECUTE') OR has_function_privilege('anon','public.match_shadow_report(integer)','EXECUTE') OR NOT has_function_privilege('service_role','public.match_shadow_report(integer)','EXECUTE') THEN RAISE EXCEPTION 'shadow report: grants'; END IF;
END $$;
ROLLBACK;
