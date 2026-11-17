\set ON_ERROR_STOP on
BEGIN;
SET LOCAL TimeZone = 'UTC';
CREATE TEMP TABLE fu29_checks(name text, passed boolean);
CREATE FUNCTION pg_temp.fu29_prove(n text, p boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  IF p IS DISTINCT FROM true THEN RAISE EXCEPTION 'Follow-up 29: %', n; END IF;
  INSERT INTO fu29_checks VALUES(n,p);
END $$;
-- Other contracts may have unwound this view. Start by applying our own guarded migration.
\ir ../../../migrations/20261118010401_job_revenue_live_parity.sql
SELECT pg_temp.fu29_prove('matches director live revenue hash',
  md5(pg_get_viewdef('public.v_job_revenue_events'::regclass,true))='cea985aadcb59a2f751b1f403176a39c');
CREATE TEMP TABLE fu29_rewrite AS SELECT oid,xmin::text AS revision FROM pg_rewrite
 WHERE ev_class='public.v_job_revenue_events'::regclass;
CREATE TEMP TABLE fu29_identity AS SELECT oid,relacl,reloptions FROM pg_class
 WHERE oid='public.v_job_revenue_events'::regclass;
CREATE TEMP TABLE fu29_other_views AS SELECT oid,pg_get_viewdef(oid,true) AS definition FROM pg_class
 WHERE oid IN ('public.v_job_cost_events'::regclass,'public.v_job_profit'::regclass);
-- Already-live is a no-op, including object identity, permissions and options.
\ir ../../../migrations/20261118010401_job_revenue_live_parity.sql
SELECT pg_temp.fu29_prove('already-live replay preserves identity and access',
  EXISTS(SELECT 1 FROM fu29_identity old JOIN pg_class c USING(oid)
    WHERE old.relacl IS NOT DISTINCT FROM c.relacl AND old.reloptions IS NOT DISTINCT FROM c.reloptions));
SELECT pg_temp.fu29_prove('already-live replay does not rewrite its rule',
  NOT EXISTS(SELECT 1 FROM fu29_rewrite old JOIN pg_rewrite r USING(oid) WHERE old.revision<>r.xmin::text));
-- Always exercise the erroneous registered-stack preimage, even when run after another test.
\ir fresh-revenue.sql
SELECT pg_temp.fu29_prove('repair fixture is the exact fresh-stack hash',
  md5(pg_get_viewdef('public.v_job_revenue_events'::regclass,true))='b8354d49625e92fdb4a52d81df3a761a');
\ir ../../../migrations/20261118010401_job_revenue_live_parity.sql
SELECT pg_temp.fu29_prove('fresh-stack repair reaches exact live hash',
  md5(pg_get_viewdef('public.v_job_revenue_events'::regclass,true))='cea985aadcb59a2f751b1f403176a39c');
SELECT pg_temp.fu29_prove('repair preserves identity and access',
  EXISTS(SELECT 1 FROM fu29_identity old JOIN pg_class c USING(oid)
    WHERE old.relacl IS NOT DISTINCT FROM c.relacl AND old.reloptions IS NOT DISTINCT FROM c.reloptions));
SELECT pg_temp.fu29_prove('cost and profit definitions remain unchanged',
  NOT EXISTS(SELECT 1 FROM fu29_other_views WHERE definition<>pg_get_viewdef(oid,true)));

DO $test$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  j uuid := gen_random_uuid();
  other_j uuid := gen_random_uuid();
  observed numeric;
BEGIN
  INSERT INTO public.organisations(id,name) VALUES(org,'Synthetic organisation') ON CONFLICT DO NOTHING;
  INSERT INTO public.jobs(id,org_id,status,type,job_number) VALUES
    (j,org,'in_progress','fencing','ZZTEST-FU29-A'),
    (other_j,org,'in_progress','fencing','ZZTEST-FU29-B');
  INSERT INTO public.xero_invoices(org_id,xero_invoice_id,invoice_number,invoice_type,status,
    invoice_date,job_id,sub_total,total,line_items,raw_json)
  SELECT org,'fu29-'||v.k,'ZZTEST-'||v.k,'ACCREC',v.status,'2026-11-01',v.job_id,100,110,
    '[{"LineItemID":"line-a","LineAmount":100,"TaxAmount":10,"Tracking":[{"Name":"Business Unit","Option":"SW - FENCING"}]}]'::jsonb,
    '{"LineAmountTypes":"Exclusive","CreditNotes":[{"CreditNoteID":"ZZTEST-credit","AppliedAmount":11}]}'::jsonb
  FROM (VALUES
    ('evidence','AUTHORISED',NULL::uuid), ('missing','AUTHORISED',NULL::uuid),
    ('not-evidenced','AUTHORISED',NULL::uuid), ('not-job','AUTHORISED',NULL::uuid),
    ('draft','DRAFT',NULL::uuid), ('voided','VOIDED',NULL::uuid),
    ('linked','AUTHORISED',other_j), ('split','AUTHORISED',NULL::uuid)) v(k,status,job_id);
  INSERT INTO public.v_bookkeeping_line_evidence_current(xero_invoice_id,xero_line_item_id,allocation,evidenced,job_id)
  SELECT 'fu29-'||v.k,'line-a',v.allocation,v.evidenced,j
  FROM (VALUES ('evidence','job',true),('not-evidenced','job',false),('not-job','overhead',true),
    ('draft','job',true),('voided','job',true),('linked','job',true),('split','job',true)) v(k,allocation,evidenced);
  UPDATE public.xero_invoices SET line_items=line_items||
    '[{"LineItemID":"line-b","LineAmount":50,"TaxAmount":5}]'::jsonb,
    sub_total=150,total=165 WHERE xero_invoice_id='fu29-split';
  INSERT INTO public.v_bookkeeping_line_evidence_current(xero_invoice_id,xero_line_item_id,allocation,evidenced,job_id)
  VALUES('fu29-split','line-b','job',true,other_j);

  PERFORM pg_temp.fu29_prove('unlinked evidenced invoice line counts on its job',
    (SELECT job_id=j AND amount_ex=100 AND counts_as_invoiced FROM public.v_job_revenue_events
      WHERE source_id='fu29-evidence:1'));
  PERFORM pg_temp.fu29_prove('whole-invoice evidence places applied credit on the same job with its division',
    (SELECT job_id=j AND amount_ex=-10 AND business_unit='SW - FENCING' FROM public.v_job_revenue_events
      WHERE source_id='fu29-evidence:credit'));
  PERFORM pg_temp.fu29_prove('missing or unconfirmed job evidence invents no revenue',
    NOT EXISTS(SELECT 1 FROM public.v_job_revenue_events
      WHERE document_id IN ('fu29-missing','fu29-not-evidenced','fu29-not-job')));
  PERFORM pg_temp.fu29_prove('draft is visible but not invoiced and has no applied-credit row',
    (SELECT count(*)=1 AND bool_and(NOT counts_as_invoiced) FROM public.v_job_revenue_events
      WHERE document_id='fu29-draft'));
  PERFORM pg_temp.fu29_prove('voided invoice contributes nothing',
    NOT EXISTS(SELECT 1 FROM public.v_job_revenue_events WHERE document_id='fu29-voided'));
  PERFORM pg_temp.fu29_prove('office invoice job link wins over ledger evidence for line and credit',
    (SELECT count(*)=2 AND bool_and(job_id=other_j) FROM public.v_job_revenue_events WHERE document_id='fu29-linked'));
  PERFORM pg_temp.fu29_prove('split-job invoice retains line placement but invents no whole-invoice credit placement',
    (SELECT count(*)=2 AND count(DISTINCT job_id)=2 AND bool_and(kind='invoice_line')
      FROM public.v_job_revenue_events WHERE document_id='fu29-split'));
  -- A retry is a read of the same rows, never an extra event or a second charge.
  SELECT sum(amount_ex) INTO observed FROM public.v_job_revenue_events WHERE document_id='fu29-evidence';
  PERFORM pg_temp.fu29_prove('repeated read returns the same evidenced net revenue',
    observed=90 AND observed=(SELECT sum(amount_ex) FROM public.v_job_revenue_events WHERE document_id='fu29-evidence'));
  DELETE FROM public.v_bookkeeping_line_evidence_current WHERE xero_invoice_id='fu29-evidence';
  PERFORM pg_temp.fu29_prove('removing evidence removes its unlinked revenue on the next read',
    NOT EXISTS(SELECT 1 FROM public.v_job_revenue_events WHERE document_id='fu29-evidence'));
END $test$;
SELECT count(*) AS checks,count(*) FILTER(WHERE passed) AS passed FROM fu29_checks;
ROLLBACK;
