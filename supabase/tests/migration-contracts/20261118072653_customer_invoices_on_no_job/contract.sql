\set ON_ERROR_STOP on
BEGIN;
\ir ../../../migrations/20261118072653_customer_invoices_on_no_job.sql
CREATE TEMP TABLE checks(label text PRIMARY KEY);
CREATE FUNCTION pg_temp.prove(label text, ok boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'P3-03.1: %', label; END IF;
  INSERT INTO checks VALUES(label);
END $$;

SELECT pg_temp.prove('switch seeded off', (SELECT NOT enabled FROM public.feature_flags
  WHERE flag_name = 'customer_invoice_no_job_items_v1'));
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'customer_invoice_no_job_items_v1';
\ir ../../../migrations/20261118072653_customer_invoices_on_no_job.sql
SELECT pg_temp.prove('reapply preserves the office switch', (SELECT enabled FROM public.feature_flags
  WHERE flag_name = 'customer_invoice_no_job_items_v1'));
SELECT pg_temp.prove('service role only', has_function_privilege('service_role',
  'public.customer_invoices_on_no_job(uuid,date,date)', 'EXECUTE')
  AND NOT has_function_privilege('anon','public.customer_invoices_on_no_job(uuid,date,date)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.customer_invoices_on_no_job(uuid,date,date)','EXECUTE'));

\set org 'f3030001-0000-4000-8000-000000000001'
\set other_org 'f3030001-0000-4000-8000-000000000002'
\set job 'f3030001-0000-4000-8000-000000000003'
INSERT INTO public.organisations(id,name) VALUES (:'org','ZZTEST'),(:'other_org','ZZTEST other');
INSERT INTO public.jobs(id,org_id,job_number,type,status)
VALUES (:'job',:'org','ZZTEST-P3031','fencing','in_progress');

INSERT INTO public.xero_invoices(org_id, job_id, xero_invoice_id, invoice_number, invoice_type,
  invoice_date, status, contact_name, total, line_items)
SELECT CASE WHEN k='other-org' THEN :'other_org' ELSE :'org' END::uuid,
       CASE WHEN k='linked' THEN :'job'::uuid END, 'ZZTEST-'||k, 'ZZTEST-'||k,
       CASE WHEN k='bill' THEN 'ACCPAY' ELSE 'ACCREC' END, day::date, state,
       CASE WHEN k='paid' THEN 'Bookkeeper' END, CASE WHEN k='paid' THEN 0 END,
       CASE WHEN k='malformed' THEN '{}'::jsonb WHEN k='missing' THEN NULL
            ELSE '[{"LineItemID":"a"},{"LineItemID":"b"}]'::jsonb END
FROM (VALUES
  ('approved','2026-07-01','AUTHORISED'), ('paid','2026-07-02','PAID'),
  ('submitted','2026-07-02','SUBMITTED'), ('linked','2026-07-02','AUTHORISED'),
  ('draft','2026-07-02','DRAFT'), ('void','2026-07-02','VOIDED'),
  ('early','2026-06-30','PAID'), ('future','2026-07-03','PAID'),
  ('bill','2026-07-02','AUTHORISED'), ('other-org','2026-07-02','PAID'),
  ('no-date',NULL,'PAID'), ('missing','2026-07-02','PAID'), ('malformed','2026-07-02','PAID'),
  ('placed','2026-07-02','PAID'), ('removed','2026-07-02','PAID'),
  ('unconfirmed','2026-07-02','PAID'), ('overhead','2026-07-02','PAID'),
  ('unknown-job','2026-07-02','PAID')
) f(k,day,state);

CREATE TEMP TABLE evidence AS
SELECT 'ZZTEST-'||k AS xero_invoice_id, line AS xero_line_item_id, allocation, evidenced,
       CASE WHEN k<>'unknown-job' THEN :'job'::uuid END AS job_id
FROM (VALUES ('placed','b','job',true), ('removed','removed-line','job',true),
  ('unconfirmed','a','job',false), ('overhead','a','overhead',true), ('unknown-job','a','job',true)
) f(k,line,allocation,evidenced);
-- The registered stack supplies a table for this view. The standalone script
-- installs the owning migration's actual view and writes the source records.
SELECT relkind='v' AS real_view FROM pg_class
WHERE oid='public.v_bookkeeping_line_evidence_current'::regclass \gset
\if :real_view
INSERT INTO public.bookkeeping_evidence_revisions
  (revision,stream,schema,emitted_at,sha256,facts_in_file,facts_sent,status)
VALUES ('ZZTEST-P3031','ZZTEST','ZZTEST',now(),repeat('0',64),5,5,'current');
INSERT INTO public.bookkeeping_line_evidence
  (revision,fact,xero_invoice_id,xero_line_item_id,allocation,evidenced,job_id)
SELECT 'ZZTEST-P3031','{}',e.* FROM evidence e;
\else
INSERT INTO public.v_bookkeeping_line_evidence_current
  (xero_invoice_id,xero_line_item_id,allocation,evidenced,job_id) SELECT * FROM evidence;
\endif

SET LOCAL ROLE service_role;
CREATE TEMP TABLE answer AS SELECT * FROM public.customer_invoices_on_no_job(:'org','2026-07-02')
  WITH ORDINALITY;
RESET ROLE;
SELECT pg_temp.prove('exact default list and stable row order',
  (SELECT array_agg(xero_invoice_id ORDER BY ordinality) FROM answer) =
  ARRAY['ZZTEST-approved','ZZTEST-malformed','ZZTEST-missing','ZZTEST-overhead','ZZTEST-paid',
        'ZZTEST-removed','ZZTEST-submitted','ZZTEST-unconfirmed','ZZTEST-unknown-job']);
SELECT pg_temp.prove('preserves unknown fields and age', EXISTS(SELECT FROM answer
  WHERE invoice_number='ZZTEST-approved' AND status='AUTHORISED' AND invoice_date='2026-07-01'
  AND age_days=1 AND contact_name IS NULL AND total IS NULL));
SELECT pg_temp.prove('same-day and explicit zero survive', EXISTS(SELECT FROM answer
  WHERE xero_invoice_id='ZZTEST-paid' AND age_days=0 AND contact_name='Bookkeeper' AND total=0));
SELECT pg_temp.prove('explicit lower bound inclusive', (SELECT array_agg(xero_invoice_id)
  FROM public.customer_invoices_on_no_job(:'org','2026-06-30','2026-06-30'))=ARRAY['ZZTEST-early']);
UPDATE public.xero_invoices SET job_id=:'job' WHERE org_id=:'org' AND xero_invoice_id='ZZTEST-approved';
SELECT pg_temp.prove('office placement disappears on reread', NOT EXISTS(
  SELECT FROM public.customer_invoices_on_no_job(:'org','2026-07-02') WHERE xero_invoice_id='ZZTEST-approved'));

-- An unreadable evidence relation must raise, never turn into a clean list.
SAVEPOINT before_fault;
ALTER TABLE public.v_bookkeeping_line_evidence_current RENAME COLUMN evidenced TO zztest_unreadable;
DO $$ BEGIN
  PERFORM * FROM public.customer_invoices_on_no_job('f3030001-0000-4000-8000-000000000001','2026-07-02');
  RAISE EXCEPTION 'expected evidence read failure';
EXCEPTION WHEN undefined_column THEN NULL;
END $$;
ROLLBACK TO before_fault;
SELECT pg_temp.prove('retry after restoring evidence returns current list', (SELECT count(*)
  FROM public.customer_invoices_on_no_job(:'org','2026-07-02'))=8);
\ir ../../../rollbacks/20261118072653_customer_invoices_on_no_job_down.sql
SELECT pg_temp.prove('rollback removes only this reader and its flag',
  to_regprocedure('public.customer_invoices_on_no_job(uuid,date,date)') IS NULL
  AND NOT EXISTS(SELECT FROM public.feature_flags WHERE flag_name='customer_invoice_no_job_items_v1')
  AND EXISTS(SELECT FROM public.xero_invoices WHERE org_id=:'org' AND xero_invoice_id='ZZTEST-approved'
    AND job_id=:'job'));
SELECT count(*) AS passed FROM checks;
ROLLBACK;
