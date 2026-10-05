-- Contract: Xero evidence (20261005230000).
--   1. One paid key per invoice: the trigger's invoice.paid, xero-sync's
--      invoice.payment_received and ops-api's invoice.manually_marked_paid of
--      one invoice share xero:invoice:<InvoiceID>:paid.
--   2. The backfill writes raised, authorised and paid rows only for live
--      jobs' invoices, only where none exists, on the invoice's job, direct,
--      capture_mode backfill, through capture_business_event; again: nothing.
--      Refuses a real run with the capture lane off.
--   3. Placement: invoice's own job (direct_job_id); else the plan's unique
--      match (direct_reference); else the review queue with candidates; a
--      holding job, a public-key row, a crew-marked row and a non-invoice row
--      are never touched; xero_invoices is never written; a second run writes
--      nothing. Bad plans and the attribution lane off refuse.
--   4. The touched jobs go on the catch-up list; a holding job never does.
--   5. Every dry run works inside a READ ONLY transaction.
--   6. The undo puts every row back exactly and removes the backfill's rows.
BEGIN;

INSERT INTO public.jobs(id,org_id,status,type,job_number,metadata) VALUES
 ('c5e40000-0000-4000-8000-0000000000a1','00000000-0000-0000-0000-000000000001','scheduled','fencing','SWF-C5E1','{}'),
 ('c5e40000-0000-4000-8000-0000000000a2','00000000-0000-0000-0000-000000000001','invoiced','makesafe','SWMS-C5E2','{}'),
 ('c5e40000-0000-4000-8000-0000000000a3','00000000-0000-0000-0000-000000000001','complete','fencing','SWF-C5E3','{}'),
 ('c5e40000-0000-4000-8000-0000000000a4','00000000-0000-0000-0000-000000000001','scheduled','fencing','SWF-C5E4','{"do_not_schedule":true}'),
 ('c5e40000-0000-4000-8000-0000000000a5','00000000-0000-0000-0000-000000000001','scheduled','makesafe','SWMS-C5E5','{}'),
 ('c5e40000-0000-4000-8000-0000000000a6','00000000-0000-0000-0000-000000000001','scheduled','makesafe','SWMS-C5E6','{}');

INSERT INTO public.xero_invoices(id,org_id,xero_invoice_id,invoice_number,invoice_type,status,total,amount_due,amount_paid,
 invoice_date,due_date,fully_paid_on,job_id,reference,updated_at) VALUES
 ('c5e40000-0000-4000-8000-0000000000b1','00000000-0000-0000-0000-000000000001','c5e-xid-1','INV-C5E1','ACCREC','PAID',1100,0,1100,'2026-09-01','2026-09-15','2026-09-10','c5e40000-0000-4000-8000-0000000000a1','SWF-C5E1','2026-09-10'),
 ('c5e40000-0000-4000-8000-0000000000b2','00000000-0000-0000-0000-000000000001','c5e-xid-2','INV-C5E2','ACCREC','AUTHORISED',550,550,0,'2026-09-20','2026-10-04',NULL,'c5e40000-0000-4000-8000-0000000000a1','SWF-C5E1','2026-09-20'),
 ('c5e40000-0000-4000-8000-0000000000b3','00000000-0000-0000-0000-000000000001','c5e-xid-3','INV-C5E3','ACCREC','DRAFT',300,300,0,'2026-09-21',NULL,NULL,'c5e40000-0000-4000-8000-0000000000a2','MLB-31002','2026-09-21'),
 ('c5e40000-0000-4000-8000-0000000000b4','00000000-0000-0000-0000-000000000001','c5e-xid-4','INV-C5E4','ACCREC','PAID',300,0,300,'2026-09-02',NULL,'2026-09-12','c5e40000-0000-4000-8000-0000000000a3','SWF-C5E3','2026-09-12'),
 ('c5e40000-0000-4000-8000-0000000000b5','00000000-0000-0000-0000-000000000001','c5e-xid-5','INV-C5E5','ACCREC','VOIDED',200,0,0,'2026-09-03',NULL,NULL,'c5e40000-0000-4000-8000-0000000000a1','SWF-C5E1','2026-09-03'),
 ('c5e40000-0000-4000-8000-0000000000b6','00000000-0000-0000-0000-000000000001','c5e-xid-6','INV-C5E6','ACCREC','PAID',882.2,0,882.2,'2026-09-04',NULL,'2026-09-14',NULL,'MLB-31001','2026-09-14'),
 ('c5e40000-0000-4000-8000-0000000000b7','00000000-0000-0000-0000-000000000001','c5e-xid-7','INV-C5E7','ACCREC','PAID',400,0,400,'2026-09-05',NULL,'2026-09-15',NULL,'MLB-31003','2026-09-15'),
 ('c5e40000-0000-4000-8000-0000000000b8','00000000-0000-0000-0000-000000000001','c5e-xid-8','INV-C5E8','ACCREC','AUTHORISED',700,700,0,'2026-09-06',NULL,NULL,'c5e40000-0000-4000-8000-0000000000a4','SWF-C5E4','2026-09-06'),
 ('c5e40000-0000-4000-8000-0000000000b9','00000000-0000-0000-0000-000000000001','c5e-xid-9','INV-C5E9','ACCREC','PAID',990,0,990,'2026-09-07','2026-09-21','2026-09-17','c5e40000-0000-4000-8000-0000000000a1','SWF-C5E1','2026-09-17');

-- Evidence as the writers leave it today.
INSERT INTO public.business_events(id,event_type,source,entity_type,entity_id,job_id,match_method,provider_message_id,channel,direction,body_preview,payload) VALUES
 -- xero-sync's keyed paid row on INV-C5E1 and the trigger's copy (writer job kept by L1e).
 ('c5e40000-0000-4000-8000-0000000000e1','invoice.payment_received','xero-sync','invoice','c5e-xid-1','c5e40000-0000-4000-8000-0000000000a1','direct_job_id','xero:invoice:c5e-xid-1:paid','invoice','internal','Xero marks invoice INV-C5E1 PAID.','{"invoice_number":"INV-C5E1"}'),
 ('c5e40000-0000-4000-8000-0000000000e2','invoice.paid','xero-sync-trigger','invoice','c5e40000-0000-4000-8000-0000000000b1','c5e40000-0000-4000-8000-0000000000a1',NULL,NULL,NULL,NULL,NULL,'{"invoice_number":"INV-C5E1","xero_invoice_id":"c5e-xid-1"}'),
 -- trigger rows for invoices with no job, and for one linked after its payment.
 ('c5e40000-0000-4000-8000-0000000000e6','invoice.paid','xero-sync-trigger','invoice','c5e40000-0000-4000-8000-0000000000b6',NULL,NULL,NULL,NULL,NULL,NULL,'{"invoice_number":"INV-C5E6","xero_invoice_id":"c5e-xid-6"}'),
 ('c5e40000-0000-4000-8000-0000000000e7','invoice.paid','xero-sync-trigger','invoice','c5e40000-0000-4000-8000-0000000000b7',NULL,NULL,NULL,NULL,NULL,NULL,'{"invoice_number":"INV-C5E7","xero_invoice_id":"c5e-xid-7"}'),
 ('c5e40000-0000-4000-8000-0000000000e9','invoice.paid','xero-sync-trigger','invoice','c5e40000-0000-4000-8000-0000000000b9',NULL,NULL,NULL,NULL,NULL,NULL,'{"invoice_number":"INV-C5E9","xero_invoice_id":"c5e-xid-9"}'),
 -- ops-api rows that name no job: a void on the holding job's invoice, an
 -- unlinked-looking send of a linked invoice (worded), a manual paid mark.
 ('c5e40000-0000-4000-8000-0000000000e8','invoice.voided','ops-api/void_invoice','invoice','c5e-xid-8',NULL,NULL,NULL,NULL,NULL,NULL,'{"invoice_number":"INV-C5E8"}'),
 ('c5e40000-0000-4000-8000-000000000e10','invoice.emailed','app/office','xero_invoice','c5e-xid-9',NULL,NULL,NULL,'email',NULL,'The invoice was emailed to the customer.','{"invoice_number":"INV-C5E9","linked":false}'),
 ('c5e40000-0000-4000-8000-000000000e12','invoice.manually_marked_paid','ops-api/mark_invoice_paid','invoice','c5e-xid-1',NULL,NULL,NULL,NULL,NULL,NULL,'{"invoice_number":"INV-C5E1","manual":true}'),
 -- not invoice evidence: a quote row with no job.
 ('c5e40000-0000-4000-8000-000000000e11','quote.declined','send-quote','job','c5e40000-0000-4000-8000-0000000000a1',NULL,NULL,NULL,NULL,NULL,NULL,'{}'),
 -- crew-marked row about an invoice: another rule's.
 ('c5e40000-0000-4000-8000-000000000e14','invoice.paid','xero-sync-trigger','invoice','c5e40000-0000-4000-8000-0000000000b9',NULL,NULL,NULL,NULL,NULL,NULL,'{"xero_invoice_id":"c5e-xid-9"}');
UPDATE public.business_events SET metadata=metadata||'{"recipient_role":"crew"}' WHERE id='c5e40000-0000-4000-8000-000000000e14';
-- a public-key writer's row about an invoice.
SELECT set_config('request.jwt.claims','{"role":"anon"}',true);
INSERT INTO public.business_events(id,event_type,source,entity_type,entity_id,payload) VALUES
 ('c5e40000-0000-4000-8000-000000000e13','invoice.paid','patio-tool','invoice','c5e-xid-9','{}');
SELECT set_config('request.jwt.claims','',true);

-- 1. One paid key per invoice.
DO $$
DECLARE keys text[];
BEGIN
 SELECT array_agg(DISTINCT public.context_xero_paid_event_key(b)) INTO keys FROM public.business_events b
 WHERE b.id IN ('c5e40000-0000-4000-8000-0000000000e1','c5e40000-0000-4000-8000-0000000000e2','c5e40000-0000-4000-8000-000000000e12');
 IF keys IS DISTINCT FROM ARRAY['xero:invoice:c5e-xid-1:paid'] THEN
  RAISE EXCEPTION 'xero_evidence_contract: paid events of one invoice must share one key, got %',keys;
 END IF;
 IF (SELECT public.context_xero_paid_event_key(b) FROM public.business_events b WHERE b.id='c5e40000-0000-4000-8000-000000000e10') IS NOT NULL THEN
  RAISE EXCEPTION 'xero_evidence_contract: a non-paid row has no paid key';
 END IF;
END $$;

-- Snapshot of every fixture event as it stands, for the undo check.
CREATE TEMP TABLE c5e_before ON COMMIT DROP AS
SELECT b.id, to_jsonb(b) AS r FROM public.business_events b WHERE b.id::text LIKE 'c5e40000-%';
CREATE TEMP TABLE c5e_invoices_before ON COMMIT DROP AS
SELECT md5(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id)) AS h FROM public.xero_invoices x;

-- 5. Every dry run works with the transaction read only (the desk's count files).
SAVEPOINT ro;
SET LOCAL transaction_read_only = on;
DO $$
DECLARE b jsonb; p jsonb; r jsonb; u jsonb;
BEGIN
 b:=public.context_xero_evidence_backfill(true);
 p:=public.context_xero_evidence_place('{"matches":[{"invoice_id":"c5e40000-0000-4000-8000-0000000000b6","job_id":"c5e40000-0000-4000-8000-0000000000a2","digits":["31001"]}]}',true);
 r:=public.context_xero_evidence_request_reads(true);
 u:=public.context_xero_evidence_undo(true);
 IF NOT ((b->>'dry_run')::boolean AND (p->>'dry_run')::boolean AND (r->>'dry_run')::boolean AND (u->>'dry_run')::boolean) THEN
  RAISE EXCEPTION 'xero_evidence_contract: a dry run did not report dry_run';
 END IF;
END $$;
ROLLBACK TO SAVEPOINT ro;

-- 2. The backfill.
DO $$
DECLARE plan_rows jsonb; res jsonb; n integer;
BEGIN
 SELECT jsonb_agg(jsonb_build_array(p.invoice_id,p.kind) ORDER BY p.invoice_id,p.kind) INTO plan_rows
 FROM public.context_xero_evidence_backfill_plan() p WHERE p.invoice_id::text LIKE 'c5e40000-%';
 -- INV-C5E1: paid already (keyed row); INV-C5E3 draft: raised only; INV-C5E4
 -- complete job and INV-C5E5 voided: nothing; INV-C5E6/7 no job: nothing;
 -- INV-C5E9: paid covered by its trigger row.
 IF plan_rows IS DISTINCT FROM '[["c5e40000-0000-4000-8000-0000000000b1","authorised"],["c5e40000-0000-4000-8000-0000000000b1","raised"],
   ["c5e40000-0000-4000-8000-0000000000b2","authorised"],["c5e40000-0000-4000-8000-0000000000b2","raised"],
   ["c5e40000-0000-4000-8000-0000000000b3","raised"],
   ["c5e40000-0000-4000-8000-0000000000b8","authorised"],["c5e40000-0000-4000-8000-0000000000b8","raised"],
   ["c5e40000-0000-4000-8000-0000000000b9","authorised"],["c5e40000-0000-4000-8000-0000000000b9","raised"]]'::jsonb THEN
  RAISE EXCEPTION 'xero_evidence_contract: backfill plan is %',plan_rows;
 END IF;

 UPDATE public.automation_switches SET capture=false WHERE id=1;
 BEGIN
  PERFORM public.context_xero_evidence_backfill(false);
  RAISE EXCEPTION 'xero_evidence_contract: a real backfill ran with the capture lane off';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM NOT LIKE 'xero_evidence_backfill_capture_off%' THEN RAISE; END IF;
 END;
 UPDATE public.automation_switches SET capture=true WHERE id=1;

 res:=public.context_xero_evidence_backfill(false,5000);
 IF (res->'written'->>'errors')::integer<>0 THEN RAISE EXCEPTION 'xero_evidence_contract: backfill errors %',res; END IF;

 SELECT count(*) INTO n FROM public.business_events b
 WHERE b.source='xero-history' AND b.entity_id LIKE 'c5e-xid-%'
  AND b.job_id=(SELECT x.job_id FROM public.xero_invoices x WHERE x.xero_invoice_id=b.entity_id)
  AND b.attribution_status='direct' AND b.match_method='direct_job_id'
  AND b.metadata->>'capture_mode'='backfill' AND b.metadata->>'written_as'='service_role'
  AND b.provider_message_id='xero:invoice:'||b.entity_id||':'||(b.metadata->'xero_backfill'->>'kind')
  AND b.event_at IS NOT NULL AND btrim(public.context_event_text(b))<>'';
 IF n<>9 THEN RAISE EXCEPTION 'xero_evidence_contract: expected 9 well-formed backfill rows, got %',n; END IF;

 IF (SELECT b.body_preview FROM public.business_events b WHERE b.provider_message_id='xero:invoice:c5e-xid-3:raised')
   <>'Xero invoice INV-C5E3 raised as a draft: total $300.00 inc GST.'
  OR (SELECT b.event_at FROM public.business_events b WHERE b.provider_message_id='xero:invoice:c5e-xid-2:authorised')
   <>'2026-09-20 00:00:00+08'::timestamptz
  -- history is invoice.raised: the digest counts invoice.created as office decisions.
  OR (SELECT b.event_type FROM public.business_events b WHERE b.provider_message_id='xero:invoice:c5e-xid-3:raised')<>'invoice.raised' THEN
  RAISE EXCEPTION 'xero_evidence_contract: backfill words or source time wrong';
 END IF;

 IF EXISTS(SELECT 1 FROM public.context_xero_evidence_backfill_plan() p WHERE p.invoice_id::text LIKE 'c5e40000-%') THEN
  RAISE EXCEPTION 'xero_evidence_contract: a second backfill would write again';
 END IF;
END $$;

-- 3. Placement.
DO $$
DECLARE plan jsonb:='{"matches":[{"invoice_id":"c5e40000-0000-4000-8000-0000000000b6","job_id":"c5e40000-0000-4000-8000-0000000000a2","digits":["31001"]}],
 "candidates":[{"invoice_id":"c5e40000-0000-4000-8000-0000000000b7","job_ids":["c5e40000-0000-4000-8000-0000000000a6","c5e40000-0000-4000-8000-0000000000a5"]}]}';
 res jsonb; r record;
BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('[]'),('{"matches":{}}'),('{"matches":[{"invoice_id":"x","job_id":"c5e40000-0000-4000-8000-0000000000a2"}]}'),
  ('{"candidates":[{"invoice_id":"c5e40000-0000-4000-8000-0000000000b7","job_ids":[]}]}'),
  ('{"matches":[{"invoice_id":"c5e40000-0000-4000-8000-0000000000b6","job_id":"c5e40000-0000-4000-8000-0000000000a2"}],"candidates":[{"invoice_id":"c5e40000-0000-4000-8000-0000000000b6","job_ids":["c5e40000-0000-4000-8000-0000000000a5"]}]}')
 ) v(p) LOOP
  BEGIN
   PERFORM public.context_xero_evidence_place(r.p::jsonb,true);
   RAISE EXCEPTION 'xero_evidence_contract: plan % was accepted',r.p;
  EXCEPTION WHEN raise_exception THEN
   IF SQLERRM NOT LIKE 'xero_evidence_place_plan_invalid%' THEN RAISE; END IF;
  END;
 END LOOP;

 UPDATE public.automation_switches SET attribution=false WHERE id=1;
 BEGIN
  PERFORM public.context_xero_evidence_place(plan,false);
  RAISE EXCEPTION 'xero_evidence_contract: placement ran with the attribution lane off';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM NOT LIKE 'xero_evidence_place_attribution_off%' THEN RAISE; END IF;
 END;
 UPDATE public.automation_switches SET attribution=true WHERE id=1;

 res:=public.context_xero_evidence_place(plan,false);
 IF (res->'written'->>'skipped_busy')::integer<>0 OR (res->'written'->>'changed_meanwhile')::integer<>0 THEN
  RAISE EXCEPTION 'xero_evidence_contract: placement skipped rows %',res;
 END IF;

 FOR r IN SELECT * FROM (VALUES
  -- id, job, status, match_method, placement rule
  ('c5e40000-0000-4000-8000-0000000000e6','c5e40000-0000-4000-8000-0000000000a2','empty','direct_reference','xero_reference_unique'),
  ('c5e40000-0000-4000-8000-0000000000e9','c5e40000-0000-4000-8000-0000000000a1','empty','direct_job_id','xero_invoice_job'),
  ('c5e40000-0000-4000-8000-000000000e10','c5e40000-0000-4000-8000-0000000000a1','direct','direct_job_id','xero_invoice_job'),
  ('c5e40000-0000-4000-8000-000000000e12','c5e40000-0000-4000-8000-0000000000a1','empty','direct_job_id','xero_invoice_job')
 ) v(id,job,st,mm,rule) LOOP
  IF NOT EXISTS(SELECT 1 FROM public.business_events b WHERE b.id=r.id::uuid AND b.job_id=r.job::uuid
    AND b.attribution_status=r.st AND b.match_method=r.mm AND b.metadata->>'placement_rule'=r.rule
    AND b.metadata->'source_job_binding'->>'job_id'=r.job
    AND b.metadata->'placement_repaired'->>'by'='context_xero_evidence_place') THEN
   RAISE EXCEPTION 'xero_evidence_contract: row % not placed as %/%/%/%',r.id,r.job,r.st,r.mm,r.rule;
  END IF;
 END LOOP;
 -- the worded row is now readable on its job.
 IF NOT EXISTS(SELECT 1 FROM public.context_unread_rows(ARRAY['c5e40000-0000-4000-8000-0000000000a1'::uuid]) u
   WHERE u.id='c5e40000-0000-4000-8000-000000000e10') THEN
  RAISE EXCEPTION 'xero_evidence_contract: the placed worded row is not readable';
 END IF;
 -- no unique match: review queue with candidate jobs.
 IF NOT EXISTS(SELECT 1 FROM public.business_events b WHERE b.id='c5e40000-0000-4000-8000-0000000000e7' AND b.job_id IS NULL
   AND b.attribution_status='unplaced'
   AND b.candidate_job_ids=ARRAY['c5e40000-0000-4000-8000-0000000000a5','c5e40000-0000-4000-8000-0000000000a6']::uuid[]
   AND b.metadata->'xero_review'->>'reason'='no_unique_reference_match') THEN
  RAISE EXCEPTION 'xero_evidence_contract: the unmatched row is not queued with its candidates';
 END IF;
 -- holding job, quote row, crew-marked row, public-key row: untouched.
 IF EXISTS(SELECT 1 FROM public.business_events b JOIN c5e_before s ON s.id=b.id
   WHERE b.id IN ('c5e40000-0000-4000-8000-0000000000e8','c5e40000-0000-4000-8000-000000000e11',
    'c5e40000-0000-4000-8000-000000000e13','c5e40000-0000-4000-8000-000000000e14','c5e40000-0000-4000-8000-0000000000e1',
    'c5e40000-0000-4000-8000-0000000000e2')
    AND to_jsonb(b)<>s.r) THEN
  RAISE EXCEPTION 'xero_evidence_contract: a row placement must leave alone was changed';
 END IF;
 IF (SELECT md5(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id)) FROM public.xero_invoices x)<>(SELECT h FROM c5e_invoices_before) THEN
  RAISE EXCEPTION 'xero_evidence_contract: xero_invoices was written';
 END IF;

 res:=public.context_xero_evidence_place(plan,false);
 IF (res->'written'->>'placed')::integer<>0 OR (res->'written'->>'queued_with_candidates')::integer<>0
  OR (res->'by_class'->>'already_queued')::integer<>1 THEN
  RAISE EXCEPTION 'xero_evidence_contract: a second placement wrote again %',res;
 END IF;
END $$;

-- 4. The touched jobs go on the catch-up list; never the holding job.
DO $$
DECLARE res jsonb;
BEGIN
 res:=public.context_xero_evidence_request_reads(false);
 IF NOT EXISTS(SELECT 1 FROM public.context_catchup_jobs c WHERE c.job_id='c5e40000-0000-4000-8000-0000000000a1' AND c.scope='backlog' AND c.done_at IS NULL)
  OR EXISTS(SELECT 1 FROM public.context_catchup_jobs c WHERE c.job_id='c5e40000-0000-4000-8000-0000000000a4') THEN
  RAISE EXCEPTION 'xero_evidence_contract: catch-up list wrong %',res;
 END IF;
 IF (SELECT c.priority FROM public.context_catchup_jobs c WHERE c.job_id='c5e40000-0000-4000-8000-0000000000a1')<>1 THEN
  RAISE EXCEPTION 'xero_evidence_contract: a job with open money or a relinked row reads first';
 END IF;
END $$;

-- 6. The undo.
DO $$
DECLARE res jsonb; diff text;
BEGIN
 res:=public.context_xero_evidence_undo(false);
 IF (res->>'unplaced')::integer<4 OR (res->>'unqueued')::integer<1 OR (res->>'backfill_removed')::integer<9 THEN
  RAISE EXCEPTION 'xero_evidence_contract: undo counts %',res;
 END IF;
 SELECT string_agg(b.id::text,', ') INTO diff FROM public.business_events b JOIN c5e_before s ON s.id=b.id WHERE to_jsonb(b)<>s.r;
 IF diff IS NOT NULL THEN RAISE EXCEPTION 'xero_evidence_contract: undo did not restore %',diff; END IF;
 IF EXISTS(SELECT 1 FROM public.business_events b WHERE b.source='xero-history' AND b.entity_id LIKE 'c5e-xid-%') THEN
  RAISE EXCEPTION 'xero_evidence_contract: undo left backfill rows';
 END IF;
END $$;

ROLLBACK;
