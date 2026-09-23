-- L1 behaviour contract: ladder step 1 links directly only on our own references.
-- Fixtures are recorded shapes of the named rows in the context design (sms.md
-- P0 and R13, audit C5); labels are synthetic, no live identifiers.
--
-- Shared fixture: the holding job SWF-PDF-BUCKET (archived, do_not_schedule)
-- carrying short supplier bills, as in production (185 short bill numbers).
BEGIN;
DO $$
DECLARE
 org uuid:='00000000-0000-0000-0000-000000000001';
 holding uuid:=gen_random_uuid(); ctrl uuid:=gen_random_uuid(); short_job uuid:=gen_random_uuid();
 quote_a uuid:=gen_random_uuid(); quote_b uuid:=gen_random_uuid(); patio uuid:=gen_random_uuid();
 lead_job uuid:=gen_random_uuid();
 e public.business_events; eid uuid;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,metadata) VALUES
 (holding,org,'archived','fencing','SWF-PDF-BUCKET','{"do_not_schedule":true,"purpose":"pdf_unlock_bucket"}'),
 (ctrl,org,'accepted','fencing','L1-CTRL-JOB','{}'),
 (short_job,org,'accepted','fencing','J12','{}');
 INSERT INTO public.xero_invoices(org_id,xero_invoice_id,invoice_number,invoice_type,status,job_id) VALUES
 -- Supplier bills parked on the holding job (audit C5).
 (org,'l1-bill-10','10','ACCPAY','PAID',holding),(org,'l1-bill-21','21','ACCPAY','PAID',holding),
 (org,'l1-bill-07','07','ACCPAY','PAID',holding),(org,'l1-bill-0063','0063','ACCPAY','PAID',holding),
 (org,'l1-bill-5','5','ACCPAY','PAID',holding),(org,'l1-bill-478','478','ACCPAY','PAID',holding),
 -- One of our own invoices that nonetheless sits on the holding job.
 (org,'l1-inv-hold','INV-0099','ACCREC','AUTHORISED',holding),
 -- Control job: our invoice, a long supplier bill and a credit note.
 (org,'l1-inv-ctrl','INV-01234','ACCREC','AUTHORISED',ctrl),
 (org,'l1-bill-long','BILL-778812','ACCPAY','PAID',ctrl),
 (org,'l1-cn-ctrl','CN-00012','ACCREC','AUTHORISED',ctrl);
 INSERT INTO public.purchase_orders(job_id,po_number) VALUES(ctrl,'PO-4471'),(ctrl,'PO1'),(holding,'PO-9990');

 -- P0 named case: "see you on the 21 Sep" never links directly.
 -- (a) no contact: stays in the admin bucket instead of landing on the holding job.
 INSERT INTO public.business_events(payload) VALUES('{"body":"Great, see you on the 21 Sep"}') RETURNING * INTO e;
 IF e.attribution_status='direct' OR e.job_id IS NOT DISTINCT FROM holding THEN
  RAISE EXCEPTION 'L1: "see you on the 21 Sep" linked directly (status %, job %)',e.attribution_status,e.job_id; END IF;
 IF e.attribution_status<>'admin_bucket' OR e.job_id IS NOT NULL OR e.attribution_step<>6 THEN
  RAISE EXCEPTION 'L1: contactless 21 Sep text should rest in admin_bucket, got % step %',e.attribution_status,e.attribution_step; END IF;
 -- (b) a customer with one open job reaches the contact rule and lands on that job.
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id) VALUES(patio,org,'accepted','patio','L1-ONE-OPEN','l1-one-open');
 INSERT INTO public.business_events(payload,contact_id) VALUES('{"body":"Great, see you on the 21 Sep","line":"patio"}','l1-one-open') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM patio OR e.attribution_status<>'single_open' OR e.attribution_step<>3 THEN
  RAISE EXCEPTION 'L1: one-open-job customer should be single_open on own job, got % step % job %',e.attribution_status,e.attribution_step,e.job_id; END IF;

 -- sms R13 shape: two open fencing quotes for one contact, text "$5,478" on the
 -- fencing line. Step 1 must fall through (bills "5" and "478" sit on the holding
 -- job); the contact rules send it to review with no job. content_ref is slice P2.
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id) VALUES
 (quote_a,org,'quoted','fencing','L1-R13-QUOTE-A','l1-r13-contact'),
 (quote_b,org,'quoted','fencing','L1-R13-QUOTE-B','l1-r13-contact');
 INSERT INTO public.business_events(payload,contact_id,event_at,provider_message_id)
 VALUES('{"body":"I only see one price of $5,478","line":"fencing"}','l1-r13-contact','2026-09-21T03:51:00Z','ghl:l1-r13') RETURNING * INTO e;
 IF e.attribution_step=1 OR e.job_id IS NOT NULL THEN
  RAISE EXCEPTION 'L1: R13 "$5,478" matched step 1 (status %, job %)',e.attribution_status,e.job_id; END IF;
 IF e.attribution_status<>'pending_luna' OR e.attribution_step<>5 THEN
  RAISE EXCEPTION 'L1: R13 should reach review (pending_luna step 5), got % step %',e.attribution_status,e.attribution_step; END IF;

 -- A lead texting before any job (sms R8 shape): stays bucketed, so the job-created
 -- reconsideration can still place it once the job exists. Before L1 it went
 -- straight to the holding job as "direct" and was never reconsidered.
 INSERT INTO public.business_events(payload,contact_id) VALUES('{"body":"Any response? Free on the 21 Sep"}','l1-lead') RETURNING * INTO e;
 eid:=e.id;
 IF e.attribution_status<>'admin_bucket' OR e.job_id IS NOT NULL THEN
  RAISE EXCEPTION 'L1: pre-job lead text should rest in admin_bucket, got % job %',e.attribution_status,e.job_id; END IF;
 INSERT INTO public.jobs(id,org_id,status,type,job_number,ghl_contact_id) VALUES(lead_job,org,'accepted','fencing','L1-LEAD-JOB','l1-lead');
 SELECT * INTO e FROM public.business_events WHERE id=eid;
 IF e.job_id IS DISTINCT FROM lead_job OR e.attribution_status<>'single_open' THEN
  RAISE EXCEPTION 'L1: pre-job lead text not placed on the new job, got % job %',e.attribution_status,e.job_id; END IF;

 -- Supplier bills, credit notes and short tokens never link directly.
 INSERT INTO public.business_events(payload) VALUES('{"body":"Paid bill BILL-778812"}') RETURNING * INTO e;
 IF e.job_id IS NOT NULL THEN RAISE EXCEPTION 'L1: ACCPAY bill number linked directly'; END IF;
 INSERT INTO public.business_events(payload) VALUES('{"body":"Credit CN-00012 received"}') RETURNING * INTO e;
 IF e.job_id IS NOT NULL THEN RAISE EXCEPTION 'L1: non-INV ACCREC number linked directly'; END IF;
 INSERT INTO public.business_events(payload) VALUES('{"body":"Is J12 booked?"}') RETURNING * INTO e;
 IF e.job_id IS NOT NULL THEN RAISE EXCEPTION 'L1: job number under 5 characters linked directly'; END IF;
 INSERT INTO public.business_events(payload) VALUES('{"body":"Re PO1 delivery"}') RETURNING * INTO e;
 IF e.job_id IS NOT NULL THEN RAISE EXCEPTION 'L1: PO number under 5 characters linked directly'; END IF;
 INSERT INTO public.business_events(payload) VALUES('{"body":"Invoice 0063 and 07 and 10"}') RETURNING * INTO e;
 IF e.job_id IS NOT NULL THEN RAISE EXCEPTION 'L1: short supplier bill numbers linked directly'; END IF;

 -- Nothing reaches the holding job by reference, even our own identifiers on it.
 INSERT INTO public.business_events(payload) VALUES('{"body":"Filed under SWF-PDF-BUCKET"}') RETURNING * INTO e;
 IF e.job_id IS NOT NULL THEN RAISE EXCEPTION 'L1: holding job number linked directly'; END IF;
 INSERT INTO public.business_events(payload) VALUES('{"body":"About INV-0099"}') RETURNING * INTO e;
 IF e.job_id IS NOT NULL THEN RAISE EXCEPTION 'L1: invoice on the holding job linked directly'; END IF;
 INSERT INTO public.business_events(payload) VALUES('{"body":"About PO-9990"}') RETURNING * INTO e;
 IF e.job_id IS NOT NULL THEN RAISE EXCEPTION 'L1: PO on the holding job linked directly'; END IF;

 -- Our own references still link directly (positive controls), any case.
 INSERT INTO public.business_events(payload) VALUES('{"body":"Please check L1-CTRL-JOB"}') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM ctrl OR e.attribution_status<>'direct' OR e.attribution_step<>1 THEN
  RAISE EXCEPTION 'L1: own job number lost its direct link'; END IF;
 INSERT INTO public.business_events(payload) VALUES('{"body":"paid inv-01234 today"}') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM ctrl OR e.attribution_status<>'direct' THEN
  RAISE EXCEPTION 'L1: own ACCREC INV- number lost its direct link'; END IF;
 INSERT INTO public.business_events(payload) VALUES('{"body":"PO-4471 delivered"}') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM ctrl OR e.attribution_status<>'direct' THEN
  RAISE EXCEPTION 'L1: own PO number lost its direct link'; END IF;
 -- A real reference beside a supplier bill number is one reference, not two.
 INSERT INTO public.business_events(payload) VALUES('{"body":"L1-CTRL-JOB see you on the 21"}') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM ctrl OR e.attribution_status<>'direct' THEN
  RAISE EXCEPTION 'L1: bill number beside a job number still made it ambiguous, got % job %',e.attribution_status,e.job_id; END IF;
 -- Two of our own jobs named stays ambiguous and unlinked (unchanged).
 INSERT INTO public.business_events(payload) VALUES('{"body":"L1-CTRL-JOB and L1-R13-QUOTE-A"}') RETURNING * INTO e;
 IF e.job_id IS NOT NULL OR e.attribution_status<>'admin_bucket' THEN RAISE EXCEPTION 'L1: two named jobs bound'; END IF;
 -- A verified writer job id keeps explicit custody, the holding job included (unchanged).
 INSERT INTO public.business_events(payload,job_id,match_method) VALUES('{"body":"Unlock bucket PDF"}',holding,'direct_job_id') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM holding OR e.attribution_status<>'direct' THEN RAISE EXCEPTION 'L1: explicit writer custody changed'; END IF;
END $$;
ROLLBACK;

-- Structure: the live body is this migration's, and no public role may call it.
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events)'::regprocedure)
  <>'acb80ebe792beeb7e5b537643bf9f184' THEN RAISE EXCEPTION 'L1: ladder body is not the L1 body'; END IF;
 IF has_function_privilege('anon','public.resolve_context_attribution(public.business_events)','EXECUTE')
  OR has_function_privilege('authenticated','public.resolve_context_attribution(public.business_events)','EXECUTE')
 THEN RAISE EXCEPTION 'L1: ladder callable by a public role'; END IF;
END $$;

-- Re-apply is a no-op: the guard accepts its own body.
\ir ../../../migrations/20260923230000_context_ladder_step1_own_references_live.sql
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events)'::regprocedure)
  <>'acb80ebe792beeb7e5b537643bf9f184' THEN RAISE EXCEPTION 'L1: re-apply changed the ladder body'; END IF;
END $$;
