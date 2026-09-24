-- P4 behaviour contract, on recorded fixtures of the rows the design names
-- (adminbucket.md section 10: N1 to N4, N7, N8, N9, N17 to N23; email.md
-- section 10: E5, E6, E7, E10, E12, E17, E20, E21; email.md finding 6).
-- Job numbers, GHL message ids, GHL contact ids and message times are as the
-- design records them; every email address and phone is synthetic, and no
-- customer name appears. Where the design gives no time or invoice date the
-- fixture states its stand-in beside the row.
--
-- Proves:
--   A. With the flag off (as shipped) the ladder is P1a's, bucket rows gain a
--      reason, and the preview shows what the rules would do, writing nothing.
--   B. With the flag on, each named row ends as the design says.
--   C. Structure: the flag row is created off and an unreadable flag is off;
--      nothing is callable by the public key or a signed-in login; P1a's
--      two-argument candidate set is unchanged; re-apply is a no-op.
\set ON_ERROR_STOP 1

BEGIN;
-- Jobs (the design's job numbers; sites and statuses from the production read
-- of 24 Sep 2026; contacts are the recorded GHL ids or a synthetic label).
INSERT INTO public.jobs(id,org_id,job_number,status,type,client_email,client_phone,ghl_contact_id,site_address,created_at,completed_at,archived,metadata) VALUES
 ('d4000000-0000-4000-8000-000000001379',gen_random_uuid(),'SWP-261379','draft','patio','customer.n1@example.com',NULL,'gNc36jRlkelMpCWhOUcl','41 Milne St, Bayswater WA 6053','2026-09-10Z',NULL,false,'{}'),
 ('d4000000-0000-4000-8000-000000000701',gen_random_uuid(),'SWP-26701','order_materials','patio',NULL,NULL,'p4-contact-n2','14 Bradley St, Yokine WA 6060','2026-06-01Z',NULL,false,'{}'),
 ('d4000000-0000-4000-8000-000000001222',gen_random_uuid(),'SWP-261222','approvals','patio',NULL,NULL,'p4-contact-n3','20 Beenan Cl, Karawara WA 6152','2026-07-01Z',NULL,false,'{}'),
 ('d4000000-0000-4000-8000-000000000195',gen_random_uuid(),'SWP-26195','awaiting_supplier','patio',NULL,NULL,'kkSBBvK4MWxOXCWGiGf8','5 Lizard St, Banksia Grove WA 6031','2026-05-01Z',NULL,false,'{}'),
 ('d4000000-0000-4000-8000-000000000328',gen_random_uuid(),'SWP-26328','in_progress','patio',NULL,NULL,'kkSBBvK4MWxOXCWGiGf8','5 Lizard St, Banksia Grove WA 6031','2026-06-01Z',NULL,false,'{}'),
 ('d4000000-0000-4000-8000-000000000566',gen_random_uuid(),'SWF-26566','archived','fencing',NULL,NULL,'UyU1yTFeygfdszy9Z5T7','18 Stoneykirk Lp, Wellard WA 6170','2026-07-01Z','2026-08-17 02:40:46Z',false,'{}'),
 ('d4000000-0000-4000-8000-000000000989',gen_random_uuid(),'SWF-26989','invoiced','fencing',NULL,NULL,'p4-contact-n17','102 Walcott St, Mount Lawley WA 6050','2026-08-01Z','2026-09-07 01:03:46Z',false,'{}'),
 ('d4000000-0000-4000-8000-000000000183',gen_random_uuid(),'SWP-26183','in_progress','patio',NULL,NULL,'p4-contact-n8a','34A McKenzie Way, Embleton WA 6062','2026-05-01Z',NULL,false,'{}'),
 ('d4000000-0000-4000-8000-000000000941',gen_random_uuid(),'SWP-26941','in_progress','patio',NULL,NULL,'p4-contact-n8b','3 Prior Pass, Clarkson WA 6030','2026-05-01Z',NULL,false,'{}'),
 ('d4000000-0000-4000-8000-000000025029',gen_random_uuid(),'SWP-25029','scheduled','patio',NULL,NULL,NULL,NULL,'2026-05-01Z',NULL,false,'{}'),
 ('d4000000-0000-4000-8000-000000001105',gen_random_uuid(),'SWF-261105','scheduled','fencing',NULL,NULL,NULL,NULL,'2026-05-01Z',NULL,false,'{}'),
 ('d4000000-0000-4000-8000-000000001098',gen_random_uuid(),'SWF-261098','scheduled','fencing',NULL,NULL,NULL,NULL,'2026-05-01Z',NULL,false,'{}'),
 ('d4000000-0000-4000-8000-000000001160',gen_random_uuid(),'SWP-261160','scheduled','patio',NULL,NULL,NULL,NULL,'2026-05-01Z',NULL,false,'{}'),
 ('d4000000-0000-4000-8000-000000001063',gen_random_uuid(),'SWP-261063','scheduled','patio',NULL,NULL,NULL,NULL,'2026-05-01Z',NULL,false,'{}'),
 ('d4000000-0000-4000-8000-000000001248',gen_random_uuid(),'SWP-261248','approvals','patio',NULL,NULL,NULL,'34 Montane Turn, Banksia Grove WA 6031','2026-08-01Z',NULL,false,'{}'),
 ('d4000000-0000-4000-8000-000000000838',gen_random_uuid(),'SWF-26838','quoted','fencing',NULL,NULL,'AfN47QHwprqBlUhshXfn','4 St Joseph Cl, Stirling WA 6021','2026-06-01Z',NULL,false,'{}'),
 ('d4000000-0000-4000-8000-000000001460',gen_random_uuid(),'SWF-261460','quoted','fencing',NULL,NULL,'5BFz2c6oUIgZuCSyKhFM','67 Epsom Ave, Redcliffe WA 6104','2026-09-20Z',NULL,false,'{}'),
 ('d4000000-0000-4000-8000-000000001459',gen_random_uuid(),'SWF-261459','quoted','fencing',NULL,NULL,'5BFz2c6oUIgZuCSyKhFM','9 Hartley St, Redcliffe WA 6104','2026-09-20Z',NULL,false,'{}'),
 ('d4000000-0000-4000-8000-000000026167',gen_random_uuid(),'SWF-26167','quoted','fencing','other.client.e20@example.com',NULL,'p4-contact-e20',NULL,'2026-06-01Z',NULL,false,'{}'),
 ('d4000000-0000-4000-8000-000000026168',gen_random_uuid(),'SWF-26168','quoted','fencing','customer.e20@example.com',NULL,NULL,NULL,'2026-06-02Z',NULL,false,'{}'),
 ('d4000000-0000-4000-8000-000020260713',gen_random_uuid(),'SWG-20260713-BE','scheduled','patio',NULL,NULL,NULL,NULL,'2026-07-01Z',NULL,false,'{}');
-- SWF-26566 (read 24 Sep): status archived, completed_at 17 Aug 02:40:46Z, no
-- terminal status event, so it finished at completed_at. Invoices as read:
-- INV-0757 issued 24 Jun and paid 2 Sep (unpaid at the N7 text), INV-0758 paid
-- 26 Jun, INV-1223 issued 25 Aug paid 31 Aug, INV-1226 issued 25 Aug paid 26 Aug.
INSERT INTO public.xero_invoices(id,org_id,xero_invoice_id,invoice_number,invoice_type,status,amount_due,amount_paid,fully_paid_on,job_id,invoice_date) VALUES
 (gen_random_uuid(),gen_random_uuid(),'p4-x-0757','INV-0757','ACCREC','PAID',0,1353,'2026-09-02','d4000000-0000-4000-8000-000000000566','2026-06-24'),
 (gen_random_uuid(),gen_random_uuid(),'p4-x-0758','INV-0758','ACCREC','PAID',0,1353,'2026-06-26','d4000000-0000-4000-8000-000000000566','2026-06-24'),
 (gen_random_uuid(),gen_random_uuid(),'p4-x-1223','INV-1223','ACCREC','PAID',0,1353,'2026-08-31','d4000000-0000-4000-8000-000000000566','2026-08-25'),
 (gen_random_uuid(),gen_random_uuid(),'p4-x-1226','INV-1226','ACCREC','PAID',0,1353,'2026-08-26','d4000000-0000-4000-8000-000000000566','2026-08-25'),
 -- SWF-26989 (read 24 Sep): INV-1216 issued and paid 14 Aug; INV-1483 issued
 -- 7 Sep (the completion day), still AUTHORISED; INV-1493 issued and paid 8 Sep.
 (gen_random_uuid(),gen_random_uuid(),'p4-x-1216','INV-1216','ACCREC','PAID',0,2186.25,'2026-08-14','d4000000-0000-4000-8000-000000000989','2026-08-14'),
 (gen_random_uuid(),gen_random_uuid(),'p4-x-1483','INV-1483','ACCREC','AUTHORISED',2433.75,0,NULL,'d4000000-0000-4000-8000-000000000989','2026-09-07'),
 (gen_random_uuid(),gen_random_uuid(),'p4-x-1493','INV-1493','ACCREC','PAID',0,247.5,'2026-09-08','d4000000-0000-4000-8000-000000000989','2026-09-08');

-- A. Flag off, as shipped.
DO $$
DECLARE e public.business_events; p jsonb; n_threads int;
BEGIN
 IF public.context_unlinked_rules_enabled() THEN RAISE EXCEPTION 'p4: the flag must ship off'; END IF;
 -- Finding 6 / N1 (Graph ...ABLTy7PQAAAA==, 18 Sep 06:46:52Z): the sender is
 -- in payload.from; the P1a ladder reads payload.email only, so it is unread.
 INSERT INTO public.business_events(id,event_type,source,channel,direction,occurred_at,event_at,provider_message_id,source_table,source_id,payload)
 VALUES('d4e00000-0000-4000-8000-000000000001','client.email_in','monitor-inbox','email','inbound','2026-09-18 06:46:52Z','2026-09-18 06:46:52Z',
  'graph:n1-ABLTy7PQAAAA==','inbox_events','aa6745bb-n1','{"from":"Customer.N1@Example.com","subject":"Re: SecureWorks Patios","body":"Could someone come out for a site visit?"}')
 RETURNING * INTO e;
 IF e.job_id IS NOT NULL OR e.attribution_status<>'admin_bucket' OR e.contact_id IS NOT NULL
 THEN RAISE EXCEPTION 'p4 flag off: N1 must stay in the bucket as P1a leaves it, got % %',e.attribution_status,e.job_id; END IF;
 IF e.metadata->>'bucket_reason' IS DISTINCT FROM 'identity_unread' THEN RAISE EXCEPTION 'p4 flag off: N1 bucket reason must be identity_unread, got %',e.metadata; END IF;
 -- The preview shows what the rules would do, and what they do today.
 SELECT count(*) INTO n_threads FROM public.event_threads;
 p:=public.context_attribution_preview(e.id,true);
 IF p->'decided'->>'attribution_status'<>'single_open' OR p->'decided'->>'job_number'<>'SWP-261379'
  OR p->'decided'->>'placement_rule'<>'identity_email' OR p->'decided'->>'contact_id'<>'gNc36jRlkelMpCWhOUcl'
  OR p->'stored'->>'attribution_status'<>'admin_bucket' OR (p->>'rules_on')::boolean IS NOT TRUE OR (p->>'flag_on')::boolean
 THEN RAISE EXCEPTION 'p4 preview on: N1 must be single_open identity_email on SWP-261379, got %',p; END IF;
 p:=public.context_attribution_preview(e.id,false);
 IF p->'decided'->>'attribution_status'<>'admin_bucket' OR p->'decided'->>'job_id' IS NOT NULL
 THEN RAISE EXCEPTION 'p4 preview off: N1 must stay in the bucket, got %',p; END IF;
 p:=public.context_attribution_preview(e.id,NULL);
 IF (p->>'rules_on')::boolean THEN RAISE EXCEPTION 'p4 preview: a null rules_on must read the flag (off), got %',p; END IF;
 SELECT * INTO e FROM public.business_events WHERE id=e.id;
 IF e.attribution_status<>'admin_bucket' OR e.job_id IS NOT NULL OR e.contact_id IS NOT NULL
  OR (SELECT count(*) FROM public.event_threads)<>n_threads
 THEN RAISE EXCEPTION 'p4 preview wrote something'; END IF;
 -- P1a's step 1 for two named jobs (a bucket row, now with its reason).
 INSERT INTO public.business_events(payload) VALUES('{"body":"paid invoice for SWP-26183 and SWP-26941"}') RETURNING * INTO e;
 IF e.attribution_status<>'admin_bucket' OR e.metadata->>'bucket_reason'<>'multi_ref' OR e.candidate_job_ids IS NOT NULL
 THEN RAISE EXCEPTION 'p4 flag off: two references must stay P1a''s bucket row with reason multi_ref, got % %',e.attribution_status,e.metadata; END IF;
 -- P1a still binds a thread on a guess placement while the rules are off.
 INSERT INTO public.business_events(payload,contact_id,thread_key,event_at) VALUES('{"body":"thanks, see you then"}','p4-contact-n3','outlook:p4-off-guess','2026-09-20Z') RETURNING * INTO e;
 IF e.attribution_status<>'single_open' OR NOT EXISTS(SELECT 1 FROM public.event_threads WHERE thread_key='outlook:p4-off-guess')
 THEN RAISE EXCEPTION 'p4 flag off: P1a''s guess binding changed, got %',e.attribution_status; END IF;
END $$;

-- B. Flag on.
UPDATE public.feature_flags SET enabled=true,updated_at=now() WHERE flag_name='context_unlinked_rules_v1';

-- Finding 6 / N1: identity read from payload.from; the contact recovered from
-- the job's client email; single_open, rule identity_email. No thread binding
-- from a guess.
DO $$
DECLARE e public.business_events;
BEGIN
 IF NOT public.context_unlinked_rules_enabled() THEN RAISE EXCEPTION 'p4: flag did not turn on in the fixture'; END IF;
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,provider_message_id,thread_key,payload)
 VALUES('client.email_in','monitor-inbox','email','inbound','2026-09-18 06:46:52Z','2026-09-18 06:46:52Z','graph:n1-live',
  'outlook:n1-conv','{"from":"Customer N1 <Customer.N1@Example.com>","subject":"Re: SecureWorks Patios","body":"Could someone come out for a site visit?"}')
 RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM 'd4000000-0000-4000-8000-000000001379' OR e.attribution_status<>'single_open' OR e.attribution_step<>3
  OR e.metadata->>'placement_rule'<>'identity_email' OR e.contact_id IS DISTINCT FROM 'gNc36jRlkelMpCWhOUcl'
  OR e.metadata->>'contact_recovered_by'<>'email' OR e.match_method<>'contact_id'
 THEN RAISE EXCEPTION 'N1: must be single_open identity_email on SWP-261379, got % % % %',e.attribution_status,e.job_id,e.contact_id,e.metadata; END IF;
 IF EXISTS(SELECT 1 FROM public.event_threads WHERE thread_key='outlook:n1-conv') THEN RAISE EXCEPTION 'N1: a guess placement bound its thread'; END IF;
 -- A phone key on an inbound text with no contact recovers the same way.
 UPDATE public.jobs SET client_phone='0400 111 001' WHERE id='d4000000-0000-4000-8000-000000001379';
 INSERT INTO public.business_events(source,channel,direction,event_at,payload)
 VALUES('ghl-webhook-receiver','sms','inbound','2026-09-18 07:00Z','{"body":"Is Thursday ok?","phone":"+61 400 111 001"}') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM 'd4000000-0000-4000-8000-000000001379' OR e.metadata->>'placement_rule'<>'identity_phone'
 THEN RAISE EXCEPTION 'identity by phone: got % % %',e.attribution_status,e.job_id,e.metadata; END IF;
END $$;

-- N2 / E5: council RFI naming the site in its subject; exact key, one live
-- job: content_ref, rule site_address. A proven placement binds its thread, so
-- the reply on that conversation follows by thread.
DO $$
DECLARE e public.business_events;
BEGIN
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,provider_message_id,thread_key,payload)
 VALUES('client.email_in','monitor-inbox','email','inbound','2026-09-18 03:30:34Z','2026-09-18 03:30:34Z','graph:n2-ABLTy7NQAAAA==','outlook:n2-conv',
  '{"from":"Development@stirling.wa.gov.au","subject":"RFI - BC26/1697 - Application for Building Permit - 14 Bradley Street YOKINE","body":"Further information is required."}')
 RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM 'd4000000-0000-4000-8000-000000000701' OR e.attribution_status<>'content_ref' OR e.metadata->>'placement_rule'<>'site_address'
  OR e.match_method<>'content_ref' OR e.attribution_step<>6
 THEN RAISE EXCEPTION 'N2/E5: must be content_ref site_address on SWP-26701, got % % %',e.attribution_status,e.job_id,e.metadata; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.event_threads WHERE thread_key='outlook:n2-conv' AND job_id='d4000000-0000-4000-8000-000000000701')
 THEN RAISE EXCEPTION 'N2: a content_ref placement must bind its thread'; END IF;
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,thread_key,payload)
 VALUES('client.email_in','monitor-inbox','email','inbound','2026-09-18 05:00Z','2026-09-18 05:00Z','outlook:n2-conv',
  '{"from":"admin@secureworkswa.com.au","subject":"Re: RFI - BC26/1697","body":"Documents attached."}') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM 'd4000000-0000-4000-8000-000000000701' OR e.attribution_status<>'thread'
 THEN RAISE EXCEPTION 'E5: the reply must follow by thread, got % %',e.attribution_status,e.job_id; END IF;
END $$;

-- N3 / E6 / E18: "20A Beenan" against the stored "20 Beenan Cl": loose only.
-- Unplaced with SWP-261222 as its one candidate, in that job's lane; never
-- content_ref; the noreply@ council sender is not noise.
DO $$
DECLARE e public.business_events;
BEGIN
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,provider_message_id,payload)
 VALUES('client.email_in','monitor-inbox','email','inbound','2026-09-18 05:14:42Z','2026-09-18 05:14:42Z','graph:n3-ABLTy7OwAAAA==',
  '{"from":"noreply@southperth.wa.gov.au","subject":"Acknowledgement BDBPCERT-2026/3018 - 20A Beenan","body":"Your application has been received."}')
 RETURNING * INTO e;
 IF e.job_id IS NOT NULL OR e.attribution_status<>'unplaced' OR e.candidate_job_ids IS DISTINCT FROM ARRAY['d4000000-0000-4000-8000-000000001222'::uuid]
  OR e.metadata->>'placement_rule'<>'site_address_loose'
 THEN RAISE EXCEPTION 'N3/E6: must rest unplaced with SWP-261222 only, got % % % %',e.attribution_status,e.job_id,e.candidate_job_ids,e.metadata; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.context_unplaced_for_job('d4000000-0000-4000-8000-000000001222') u WHERE u.id=e.id)
 THEN RAISE EXCEPTION 'N3: missing from the SWP-261222 lane'; END IF;
 -- A typed exact mention of another number on the same street matches nothing.
 INSERT INTO public.business_events(event_type,source,channel,direction,event_at,payload)
 VALUES('client.email_in','monitor-inbox','email','inbound','2026-09-18 05:20Z','{"from":"noreply@southperth.wa.gov.au","subject":"22 Beenan Close","body":"Received."}')
 RETURNING * INTO e;
 IF e.job_id IS NOT NULL OR e.attribution_status<>'admin_bucket' THEN RAISE EXCEPTION 'N3: a neighbouring number placed, got %',e.attribution_status; END IF;
END $$;

-- N4 and trace B: Metroll "SWP 26195 - 1047995". The space-joined token is
-- SWP-26195 (never SWP-26328, the same customer at the same site); ladder_ref;
-- the supplier order number is bound. The later "RE: Quote 1047995" follows it.
-- A second job named with the same order number retires the binding; a later
-- mail quoting only the number rests unplaced with both jobs.
DO $$
DECLARE e public.business_events;
BEGIN
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,provider_message_id,payload)
 VALUES('supplier.email_in','monitor-inbox','email','inbound','2026-09-21 21:28:07Z','2026-09-21 21:28:07Z','graph:n4-AAJUKLgEAA',
  '{"from":"Quotes@perth.metroll.example","subject":"FW: Material Order Ref SWP 26195 - 1047995","body":"Quotation attached."}')
 RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM 'd4000000-0000-4000-8000-000000000195' OR e.attribution_status<>'direct' OR e.match_method<>'ladder_ref'
  OR e.metadata->>'placement_rule'<>'direct_ref' OR e.metadata ? 'source_job_binding'
 THEN RAISE EXCEPTION 'N4: must be direct (ladder_ref) on SWP-26195, got % % % %',e.attribution_status,e.job_id,e.match_method,e.metadata; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.event_threads WHERE thread_key='supplier_ref:perth.metroll.example:1047995'
   AND job_id='d4000000-0000-4000-8000-000000000195' AND bound_by='ladder' AND retired_at IS NULL)
 THEN RAISE EXCEPTION 'N4: the supplier order binding was not written'; END IF;
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,payload)
 VALUES('supplier.email_in','monitor-inbox','email','inbound','2026-09-22 01:00Z','2026-09-22 01:00Z',
  '{"from":"Quotes@perth.metroll.example","subject":"RE: Quote 1047995 ready for collection","body":"Ready for pick up."}') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM 'd4000000-0000-4000-8000-000000000195' OR e.attribution_status<>'thread' OR e.metadata->>'placement_rule'<>'supplier_order_ref'
 THEN RAISE EXCEPTION 'Trace B: the order number must follow the binding, got % % %',e.attribution_status,e.job_id,e.metadata; END IF;
 -- Another sender quoting the same number is not bound to it.
 INSERT INTO public.business_events(event_type,source,channel,direction,event_at,payload)
 VALUES('supplier.email_in','monitor-inbox','email','inbound','2026-09-22 02:00Z','{"from":"sales@other-supplier.example","subject":"Order 1047995","body":"Dispatched."}') RETURNING * INTO e;
 IF e.job_id IS NOT NULL THEN RAISE EXCEPTION 'Trace B: another sender''s number followed the binding'; END IF;
 -- Conflict (Review M3): the same number named with SWP-26328.
 INSERT INTO public.business_events(event_type,source,channel,direction,event_at,payload)
 VALUES('supplier.email_in','monitor-inbox','email','inbound','2026-09-22 03:00Z','{"from":"Quotes@perth.metroll.example","subject":"Order SWP-26328 - 1047995","body":"Revised."}') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM 'd4000000-0000-4000-8000-000000000328' OR e.attribution_status<>'direct'
  OR e.metadata->'supplier_ref_conflicts'<>'["supplier_ref:perth.metroll.example:1047995"]'::jsonb
 THEN RAISE EXCEPTION 'M3: the reference must still place the row, got % % %',e.attribution_status,e.job_id,e.metadata; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.event_threads WHERE thread_key='supplier_ref:perth.metroll.example:1047995' AND retired_reason='conflict'
   AND retired_at IS NOT NULL AND retired_conflict_job_id='d4000000-0000-4000-8000-000000000328' AND job_id='d4000000-0000-4000-8000-000000000195')
 THEN RAISE EXCEPTION 'M3: the conflicting binding was not retired'; END IF;
 INSERT INTO public.business_events(event_type,source,channel,direction,event_at,payload)
 VALUES('supplier.email_in','monitor-inbox','email','inbound','2026-09-22 04:00Z','{"from":"Quotes@perth.metroll.example","subject":"RE: Quote 1047995","body":"Collect today."}') RETURNING * INTO e;
 IF e.job_id IS NOT NULL OR e.attribution_status<>'unplaced'
  OR e.candidate_job_ids IS DISTINCT FROM ARRAY['d4000000-0000-4000-8000-000000000195','d4000000-0000-4000-8000-000000000328']::uuid[]
  OR e.metadata->>'placement_rule'<>'supplier_order_retired'
 THEN RAISE EXCEPTION 'M3: a later mail quoting only the retired number must rest unplaced with both jobs, got % % %',e.attribution_status,e.candidate_job_ids,e.metadata; END IF;
END $$;

-- N7: text 17 Aug 04:39:18Z, two hours after SWF-26566 completed, with
-- INV-0757 unpaid. Aftercare never places directly (decision of 24 Sep, a
-- deviation from X26's single_open shortcut, because N17 has the same invoice
-- facts): review with the finished job, the unpaid job named; the model reads
-- "before we commit to final payment" and places it (recorded outcome: job,
-- confidence 0.9). After every invoice was paid (5 Sep, inside 60 days) the
-- same kind of text goes to review with no unpaid job named; as history it
-- rests unplaced instead of going to the model.
DO $$
DECLARE e public.business_events;
BEGIN
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,provider_message_id,contact_id,thread_key,payload)
 VALUES('client.sms_in','ghl-webhook-receiver','sms','inbound','2026-08-17 04:39:18Z','2026-08-17 04:39:18Z','ghl:lCdPzSqF6QFAl8inI5wp','UyU1yTFeygfdszy9Z5T7',
  'ghl-conv-n7','{"body":"someone needs to come and sign off with us face to face before we commit to final payment"}') RETURNING * INTO e;
 IF e.job_id IS NOT NULL OR e.attribution_status<>'pending_luna' OR e.metadata->>'placement_rule'<>'review_aftercare'
  OR e.candidate_job_ids IS DISTINCT FROM ARRAY['d4000000-0000-4000-8000-000000000566'::uuid]
  OR e.metadata->'aftercare_unpaid_job_ids'<>'["d4000000-0000-4000-8000-000000000566"]'::jsonb
 THEN RAISE EXCEPTION 'N7: must go to review with SWF-26566 named unpaid, never placed directly, got % % %',e.attribution_status,e.job_id,e.metadata; END IF;
 e:=public.attribute_context_event_with_luna(e.id,'d4000000-0000-4000-8000-000000000566',0.9,'job');
 IF e.job_id IS DISTINCT FROM 'd4000000-0000-4000-8000-000000000566' OR e.attribution_status<>'luna'
 THEN RAISE EXCEPTION 'N7: the model''s pick at 0.9 must place it, got % %',e.attribution_status,e.job_id; END IF;
 IF (SELECT array_agg(c.clause) FROM public.context_contact_jobs_at('UyU1yTFeygfdszy9Z5T7','2026-08-17 04:39:18Z',NULL,NULL) c)<>ARRAY['aftercare_unpaid']
 THEN RAISE EXCEPTION 'N7: keyed candidate set must name SWF-26566 as aftercare_unpaid'; END IF;
 -- P1a's two-argument candidate set is unchanged: no aftercare there.
 IF EXISTS(SELECT 1 FROM public.context_contact_jobs_at('UyU1yTFeygfdszy9Z5T7','2026-08-17 04:39:18Z')) THEN RAISE EXCEPTION 'N7: P1a''s candidate set gained aftercare'; END IF;
 -- The same kind of text after every invoice was paid (5 Sep): review with the one finished job.
 INSERT INTO public.business_events(source,channel,direction,event_at,contact_id,payload)
 VALUES('ghl-webhook-receiver','sms','inbound','2026-09-05Z','UyU1yTFeygfdszy9Z5T7','{"body":"Great! Thanks again"}') RETURNING * INTO e;
 IF e.job_id IS NOT NULL OR e.attribution_status<>'pending_luna' OR e.metadata->>'placement_rule'<>'review_aftercare'
  OR e.candidate_job_ids IS DISTINCT FROM ARRAY['d4000000-0000-4000-8000-000000000566'::uuid] OR e.metadata ? 'aftercare_unpaid_job_ids'
 THEN RAISE EXCEPTION 'N7 paid: must go to review with SWF-26566 and no unpaid job, got % % %',e.attribution_status,e.candidate_job_ids,e.metadata; END IF;
 -- Loaded as history: never to the model (X27).
 INSERT INTO public.business_events(source,channel,direction,event_at,contact_id,payload,metadata)
 VALUES('ghl_sms_cache_backfill','sms','inbound','2026-09-05Z','UyU1yTFeygfdszy9Z5T7','{"body":"Great! Thanks again"}','{"capture_mode":"backfill"}') RETURNING * INTO e;
 IF e.attribution_status<>'unplaced' OR e.candidate_job_ids IS DISTINCT FROM ARRAY['d4000000-0000-4000-8000-000000000566'::uuid]
 THEN RAISE EXCEPTION 'N7 backfill: must rest unplaced, got % %',e.attribution_status,e.candidate_job_ids; END IF;
 -- More than 60 days after completion with nothing unpaid: no candidate.
 INSERT INTO public.business_events(source,channel,direction,event_at,contact_id,payload)
 VALUES('ghl-webhook-receiver','sms','inbound','2026-11-01Z','UyU1yTFeygfdszy9Z5T7','{"body":"Hi again"}') RETURNING * INTO e;
 IF e.attribution_status<>'admin_bucket' OR e.metadata->>'bucket_reason'<>'contact_only_finished'
 THEN RAISE EXCEPTION 'N7 later: must bucket as contact_only_finished, got % %',e.attribution_status,e.metadata; END IF;
 -- Aftercare never reaches another customer's finished job through a shared
 -- phone, even with its balance unpaid.
 INSERT INTO public.jobs(id,org_id,job_number,status,type,client_phone,ghl_contact_id,created_at,completed_at)
 VALUES('d4000000-0000-4000-8000-0000000000f1',gen_random_uuid(),'SWF-P4-OTHER','completed','fencing','0400 222 002','p4-contact-other','2026-07-01Z','2026-08-16Z');
 INSERT INTO public.xero_invoices(id,org_id,xero_invoice_id,invoice_number,invoice_type,status,amount_due,amount_paid,job_id,invoice_date)
 VALUES(gen_random_uuid(),gen_random_uuid(),'p4-x-other','INV-P4-OTHER','ACCREC','AUTHORISED',500,0,'d4000000-0000-4000-8000-0000000000f1','2026-08-16');
 INSERT INTO public.business_events(source,channel,direction,event_at,contact_id,payload)
 VALUES('ghl-webhook-receiver','sms','inbound','2026-08-17Z','p4-contact-lone','{"body":"When can you come?","phone":"0400 222 002"}') RETURNING * INTO e;
 IF e.job_id IS NOT NULL OR e.attribution_status NOT IN ('admin_bucket')
 THEN RAISE EXCEPTION 'aftercare: another contact''s finished job was offered, got % % %',e.attribution_status,e.job_id,e.candidate_job_ids; END IF;
END $$;

-- N17: SMS SNDiMZgaVfbRKRiObjrT, 8 Sep (stand-in 02:00Z), "New extension
-- enquiry, not this completed job". SWF-26989 is status invoiced, completed
-- 7 Sep 01:03:46Z, and INV-1483 (issued 7 Sep) was unpaid at the message time,
-- exactly like N7. It must never be placed on the finished job: review with
-- it, the unpaid job named; the model reads a new enquiry and is undecided, so
-- it rests unplaced in that job's lane (recorded outcome: undecided).
DO $$
DECLARE e public.business_events;
BEGIN
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,provider_message_id,contact_id,payload)
 VALUES('client.sms_in','ghl-webhook-receiver','sms','inbound','2026-09-08 02:00Z','2026-09-08 02:00Z','ghl:SNDiMZgaVfbRKRiObjrT','p4-contact-n17',
  '{"body":"New extension enquiry, not about the completed job"}') RETURNING * INTO e;
 IF e.job_id IS NOT NULL OR e.attribution_status<>'pending_luna' OR e.metadata->>'placement_rule'<>'review_aftercare'
  OR e.candidate_job_ids IS DISTINCT FROM ARRAY['d4000000-0000-4000-8000-000000000989'::uuid]
  OR e.metadata->'aftercare_unpaid_job_ids'<>'["d4000000-0000-4000-8000-000000000989"]'::jsonb
 THEN RAISE EXCEPTION 'N17: must go to review with SWF-26989, never placed on it, got % % % %',e.attribution_status,e.job_id,e.candidate_job_ids,e.metadata; END IF;
 e:=public.attribute_context_event_with_luna(e.id,NULL,NULL,'undecided');
 IF e.attribution_status<>'unplaced' OR e.job_id IS NOT NULL THEN RAISE EXCEPTION 'N17: Luna undecided must rest it unplaced, got %',e.attribution_status; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.context_unplaced_for_job('d4000000-0000-4000-8000-000000000989') u WHERE u.id=e.id)
 THEN RAISE EXCEPTION 'N17: missing from the SWF-26989 lane'; END IF;
 -- A text before the completion still binds (the job was live then).
 INSERT INTO public.business_events(source,channel,direction,event_at,contact_id,payload)
 VALUES('ghl-webhook-receiver','sms','inbound','2026-09-06Z','p4-contact-n17','{"body":"See you tomorrow"}') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM 'd4000000-0000-4000-8000-000000000989' OR e.attribution_status<>'single_open' OR e.metadata->>'placement_rule'<>'single_open'
 THEN RAISE EXCEPTION 'N17: a text while the job was live must bind, got % %',e.attribution_status,e.metadata; END IF;
END $$;

-- N8: a new monitor-inbox custody row, bound by the writer to the first of two
-- references: unplaced "names these jobs", in both lanes, no model call.
-- N19 and N20: the rows B-RUN re-decides, as the preview decides them: five
-- and two jobs named, each unplaced multi_ref with all of them; the preview
-- writes nothing.
DO $$
DECLARE e public.business_events; p jsonb;
BEGIN
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,source_table,source_id,job_id,match_method,payload)
 VALUES('supplier.email_in','monitor-inbox','email','inbound','2026-09-10 02:00Z','2026-09-10 02:00Z','inbox_events','a7e0d2ba-n8',
  'd4000000-0000-4000-8000-000000000183','direct_reference','{"from":"accounts@bdmetals.example","subject":"paid invoice for SWP-26183 and SWP-26941","body":"Remittance attached."}')
 RETURNING * INTO e;
 IF e.job_id IS NOT NULL OR e.attribution_status<>'unplaced' OR e.attribution_step<>1 OR e.metadata->>'placement_rule'<>'multi_ref'
  OR e.candidate_job_ids IS DISTINCT FROM ARRAY['d4000000-0000-4000-8000-000000000183','d4000000-0000-4000-8000-000000000941']::uuid[]
  OR e.metadata->'custody_rescan'->>'writer_job_id'<>'d4000000-0000-4000-8000-000000000183'
 THEN RAISE EXCEPTION 'N8: must rest unplaced multi_ref with both jobs, got % % % %',e.attribution_status,e.job_id,e.candidate_job_ids,e.metadata; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.context_unplaced_for_job('d4000000-0000-4000-8000-000000000183') u WHERE u.id=e.id)
  OR NOT EXISTS(SELECT 1 FROM public.context_unplaced_for_job('d4000000-0000-4000-8000-000000000941') u WHERE u.id=e.id)
 THEN RAISE EXCEPTION 'N8: missing from a lane'; END IF;
 -- A custody row whose text names exactly its own job keeps the writer's binding.
 INSERT INTO public.business_events(event_type,source,channel,direction,event_at,job_id,match_method,payload)
 VALUES('supplier.email_in','monitor-inbox','email','inbound','2026-09-10 03:00Z','d4000000-0000-4000-8000-000000000183','direct_reference',
  '{"from":"accounts@bdmetals.example","subject":"SWP-26183 delivery","body":"Delivered."}') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM 'd4000000-0000-4000-8000-000000000183' OR e.attribution_status<>'direct' OR e.match_method<>'direct_reference'
  OR e.metadata->>'placement_rule'<>'custody'
 THEN RAISE EXCEPTION 'custody: a one-job custody row changed, got % % %',e.attribution_status,e.match_method,e.metadata; END IF;
 -- A verified tool id is never re-scanned (the holding job and two refs included).
 INSERT INTO public.business_events(source,payload,job_id,match_method) VALUES('ops-api','{"body":"SWP-26183 and SWP-26941 both booked"}',
  'd4000000-0000-4000-8000-000000000941','direct_job_id') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM 'd4000000-0000-4000-8000-000000000941' OR e.attribution_status<>'direct' OR e.match_method<>'direct_job_id'
 THEN RAISE EXCEPTION 'custody: a verified tool id was re-scanned'; END IF;
 -- N19 (internal digest 3bda9f0e, five jobs) and N20 (supplier 077b8ef5, two
 -- jobs), filed before P4 as monitor-inbox custody on the first job.
 UPDATE public.feature_flags SET enabled=false WHERE flag_name='context_unlinked_rules_v1';
 INSERT INTO public.business_events(id,event_type,source,channel,direction,event_at,source_table,source_id,job_id,match_method,payload) VALUES
 ('d4e00000-0000-4000-8000-000000000019','client.email_in','monitor-inbox','email','inbound','2026-09-15Z','inbox_events','3bda9f0e-n19',
  'd4000000-0000-4000-8000-000000025029','direct_reference','{"from":"admin@secureworkswa.com.au","subject":"Weekly digest","body":"SWP-25029 SWP-26183 SWP-26941 SWF-261105 SWF-261098"}'),
 ('d4e00000-0000-4000-8000-000000000020','supplier.email_in','monitor-inbox','email','inbound','2026-09-15Z','inbox_events','077b8ef5-n20',
  'd4000000-0000-4000-8000-000000000183','direct_reference','{"from":"accounts@bdmetals.example","subject":"Invoices SWP-26183, SWP-26941","body":"Attached."}');
 UPDATE public.feature_flags SET enabled=true WHERE flag_name='context_unlinked_rules_v1';
 IF (SELECT count(*) FROM public.business_events WHERE id IN ('d4e00000-0000-4000-8000-000000000019','d4e00000-0000-4000-8000-000000000020') AND attribution_status='direct')<>2
 THEN RAISE EXCEPTION 'N19/N20 fixture: must start as custody rows on the first job'; END IF;
 p:=public.context_attribution_preview('d4e00000-0000-4000-8000-000000000019',true);
 IF p->'decided'->>'attribution_status'<>'unplaced' OR p->'decided'->>'placement_rule'<>'multi_ref' OR jsonb_array_length(p->'decided'->'candidate_job_ids')<>5
 THEN RAISE EXCEPTION 'N19: preview must rest it unplaced with five jobs, got %',p; END IF;
 p:=public.context_attribution_preview('d4e00000-0000-4000-8000-000000000020',true);
 IF p->'decided'->>'attribution_status'<>'unplaced' OR p->'decided'->'candidate_job_numbers'<>'["SWP-26183","SWP-26941"]'::jsonb
 THEN RAISE EXCEPTION 'N20: preview must rest it unplaced with both jobs, got %',p; END IF;
 IF (SELECT count(*) FROM public.business_events WHERE id IN ('d4e00000-0000-4000-8000-000000000019','d4e00000-0000-4000-8000-000000000020') AND attribution_status='direct')<>2
 THEN RAISE EXCEPTION 'N19/N20: the preview moved a row'; END IF;
END $$;

-- N9: an internal digest naming seven jobs and SWP-261009 (no such job):
-- bucket, multi_ref_many, with ref_not_found. Never linked to one of them.
-- N22: SWG-20260713-BE is still one exact token.
DO $$
DECLARE e public.business_events;
BEGIN
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,payload)
 VALUES('client.email_out','monitor-inbox','email','outbound','2026-09-22 09:07:36Z','2026-09-22 09:07:36Z',
  '{"from":"admin@secureworkswa.com.au","subject":"tax invoices, copies for Finance","body":"SWP-25029 SWP-26183 SWP-26941 SWF-261105 SWF-261098 SWP-261160 SWP-261063 SWP-261009"}')
 RETURNING * INTO e;
 IF e.job_id IS NOT NULL OR e.attribution_status<>'admin_bucket' OR e.metadata->>'bucket_reason'<>'multi_ref_many'
  OR e.metadata->'ref_not_found'<>'["SWP-261009"]'::jsonb OR jsonb_array_length(e.metadata->'ref_job_ids')<>7
 THEN RAISE EXCEPTION 'N9: must bucket as multi_ref_many with SWP-261009 not found, got % %',e.attribution_status,e.metadata; END IF;
 INSERT INTO public.business_events(payload) VALUES('{"body":"Re: SWG-20260713-BE install"}') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM 'd4000000-0000-4000-8000-000020260713' OR e.attribution_status<>'direct' OR e.match_method<>'ladder_ref'
 THEN RAISE EXCEPTION 'N22: must stay direct by the exact token, got % %',e.attribution_status,e.job_id; END IF;
 -- N21's premise: a ladder-made step-1 link is not custody, so a re-decision
 -- runs step 1 again (it holds the job as a hint, then finds it again).
 e:=public.resolve_context_attribution(e,true,true);
 IF e.job_id IS DISTINCT FROM 'd4000000-0000-4000-8000-000020260713' OR e.match_method<>'ladder_ref' OR e.metadata ? 'source_job_binding'
 THEN RAISE EXCEPTION 'N21: a ladder_ref row re-decided as custody, got % %',e.match_method,e.metadata; END IF;
END $$;

-- N23: rows written with the public key are never placed and never woken; a
-- claimed written_as or custody id does not change that.
DO $$
DECLARE e public.business_events;
BEGIN
 PERFORM set_config('request.jwt.claims','{"role":"anon"}',true);
 INSERT INTO public.business_events(id,event_type,source,channel,direction,occurred_at,event_at,payload,metadata)
 VALUES('d4e00000-0000-4000-8000-000000000023','client.email_in','public-form','email','inbound','2026-09-19 02:00Z','2026-09-19 02:00Z',
  '{"from":"customer.n1@example.com","body":"hello, about my patio"}','{"written_as":"service_role"}');
 INSERT INTO public.business_events(id,source,payload,job_id,match_method)
 VALUES('d4e00000-0000-4000-8000-000000000024','public-form','{"body":"SWP-26701 update"}','d4000000-0000-4000-8000-000000000701','direct_job_id');
 PERFORM set_config('request.jwt.claims','',true);
 SELECT * INTO e FROM public.business_events WHERE id='d4e00000-0000-4000-8000-000000000023';
 IF e.job_id IS NOT NULL OR e.attribution_status<>'admin_bucket' OR e.metadata->>'bucket_reason'<>'unverified_writer'
  OR e.metadata->>'written_as'<>'anon' OR e.contact_id IS NOT NULL
 THEN RAISE EXCEPTION 'N23: must rest unverified_writer, got % % %',e.attribution_status,e.contact_id,e.metadata; END IF;
 IF EXISTS(SELECT 1 FROM public.context_unread_rows(ARRAY['d4000000-0000-4000-8000-000000001379'::uuid]) u WHERE u.id=e.id)
 THEN RAISE EXCEPTION 'N23: an unverified row can wake a read'; END IF;
 SELECT * INTO e FROM public.business_events WHERE id='d4e00000-0000-4000-8000-000000000024';
 IF e.job_id IS NOT NULL OR e.attribution_status<>'admin_bucket' OR e.metadata->'attribution_hint'->>'job_id'<>'d4000000-0000-4000-8000-000000000701'
 THEN RAISE EXCEPTION 'N23: a public-key custody id must be kept only as a hint, got % %',e.attribution_status,e.metadata; END IF;
END $$;

-- E7: the neighbour on a dividing fence, "Re: Fencing Quote and Retaining -
-- 4/6 St Joseph Close Stirling" from an address on no job: no contact
-- recovered; a slash form is loose only: unplaced with SWF-26838.
DO $$
DECLARE e public.business_events;
BEGIN
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,payload)
 VALUES('client.email_in','monitor-inbox','email','inbound','2026-09-23 02:29Z','2026-09-23 02:29Z',
  '{"from":"neighbour.e7@example.com","subject":"Re: Fencing Quote and Retaining - 4/6 St Joseph Close Stirling","body":"I thought the quote was $9,201.50. Can you confirm which is correct?"}')
 RETURNING * INTO e;
 IF e.job_id IS NOT NULL OR e.contact_id IS NOT NULL OR e.attribution_status<>'unplaced'
  OR e.candidate_job_ids IS DISTINCT FROM ARRAY['d4000000-0000-4000-8000-000000000838'::uuid] OR e.metadata->>'placement_rule'<>'site_address_loose'
 THEN RAISE EXCEPTION 'E7: must rest unplaced with SWF-26838, got % % % %',e.attribution_status,e.contact_id,e.candidate_job_ids,e.metadata; END IF;
END $$;

-- E10: our own forward "Fw: 34 Montane Tn, Banksia Grove" (Tn is Turn), job
-- SWP-261248 has no GHL contact: exact key, content_ref.
-- E12: our quote email to a shared-contact customer, "67 Epsom Ave,
-- Redcliffe": the site picks SWF-261460 of the two; with both jobs at that
-- site it rests unplaced with both.
DO $$
DECLARE e public.business_events;
BEGIN
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,payload)
 VALUES('staff.email_internal','monitor-inbox','email','internal','2026-09-23 01:05Z','2026-09-23 01:05Z',
  '{"from":"staff.e10@secureworkswa.com.au","subject":"Fw: 34 Montane Tn, Banksia Grove","body":"CDC and client plz"}') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM 'd4000000-0000-4000-8000-000000001248' OR e.attribution_status<>'content_ref'
 THEN RAISE EXCEPTION 'E10: must be content_ref on SWP-261248, got % % %',e.attribution_status,e.job_id,e.metadata; END IF;
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,payload)
 VALUES('client.email_out','monitor-inbox','email','outbound','2026-09-23 02:53Z','2026-09-23 02:53Z',
  '{"from":"orders@secureworksgroup.app","email":"customer.e12@example.com","sent_by_kind":"our_tool","subject":"Your fencing quote - 67 Epsom Ave, Redcliffe","body":"Please find your quote attached."}') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM 'd4000000-0000-4000-8000-000000001460' OR e.attribution_status<>'content_ref'
 THEN RAISE EXCEPTION 'E12: the site must pick SWF-261460, got % % %',e.attribution_status,e.job_id,e.metadata; END IF;
 UPDATE public.jobs SET site_address='67 Epsom Avenue, Redcliffe WA 6104' WHERE id='d4000000-0000-4000-8000-000000001459';
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,payload)
 VALUES('client.email_out','monitor-inbox','email','outbound','2026-09-23 02:45Z','2026-09-23 02:45Z',
  '{"from":"orders@secureworksgroup.app","email":"customer.e12@example.com","sent_by_kind":"our_tool","subject":"Your fencing quote - 67 Epsom Ave, Redcliffe","body":"Please find your quote attached."}') RETURNING * INTO e;
 IF e.job_id IS NOT NULL OR e.attribution_status<>'unplaced' OR cardinality(e.candidate_job_ids)<>2
 THEN RAISE EXCEPTION 'E12: two jobs at the site must rest unplaced, never a coin toss, got % %',e.attribution_status,e.candidate_job_ids; END IF;
 UPDATE public.jobs SET site_address='9 Hartley St, Redcliffe WA 6104' WHERE id='d4000000-0000-4000-8000-000000001459';
 -- An address that names no job (a signature) links nothing.
 INSERT INTO public.business_events(event_type,source,channel,direction,event_at,payload)
 VALUES('client.email_in','monitor-inbox','email','inbound','2026-09-23 03:00Z','{"from":"info@certifier.example","subject":"Invoice","body":"Regards, 99 Nowhere Street, Perth"}') RETURNING * INTO e;
 IF e.job_id IS NOT NULL OR e.attribution_status<>'admin_bucket' THEN RAISE EXCEPTION 'signature address: placed %',e.attribution_status; END IF;
END $$;

-- E17 / N18 (SWP-26359, a personal licence email; read 24 Sep: status
-- archived with no terminal status event and no completed_at, updated 29 Jul;
-- INV-0993 issued 16 Jul, paid 23 Jul; every other invoice paid or voided): the
-- email (stand-in 10 Aug, its event row was not found) goes to review with that
-- job, never placed on it.
-- E20: the customer's contact sits on another client's job and their own job
-- is contactless: review with both, never a confident placement.
DO $$
DECLARE e public.business_events; j359 uuid:=gen_random_uuid();
BEGIN
 INSERT INTO public.jobs(id,org_id,job_number,status,type,client_email,ghl_contact_id,created_at,completed_at,archived)
 VALUES(j359,gen_random_uuid(),'SWP-26359','archived','patio','customer.n18@example.com','p4-contact-n18','2025-10-01Z',NULL,false);
 UPDATE public.jobs SET updated_at='2026-07-29 04:02:34Z' WHERE id=j359;
 INSERT INTO public.business_events(event_type,source,entity_type,entity_id,channel,direction,payload,event_at) VALUES
 ('job.status_changed','app/office','job',j359::text,'status','internal','{"changes":{"status":{"from":"quoted","to":"schedule_install"}}}','2026-05-25Z');
 INSERT INTO public.xero_invoices(id,org_id,xero_invoice_id,invoice_number,invoice_type,status,amount_due,amount_paid,fully_paid_on,job_id,invoice_date) VALUES
 (gen_random_uuid(),gen_random_uuid(),'p4-x-0023','INV-0023','ACCREC','PAID',0,14938.86,'2025-10-28',j359,'2025-10-27'),
 (gen_random_uuid(),gen_random_uuid(),'p4-x-0022','INV-0022','ACCREC','VOIDED',0,0,NULL,j359,'2025-10-25'),
 (gen_random_uuid(),gen_random_uuid(),'p4-x-0993','INV-0993','ACCREC','PAID',0,1673.59,'2026-07-23',j359,'2026-07-16');
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,source_table,source_id,payload)
 VALUES('client.email_in','monitor-inbox','email','inbound','2026-08-10Z','2026-08-10Z','inbox_events','7a573060-n18',
  '{"from":"customer.n18@example.com","subject":"builder''s licence","body":"Personal question about a builder''s licence."}') RETURNING * INTO e;
 IF e.job_id IS NOT NULL OR e.attribution_status<>'pending_luna' OR e.candidate_job_ids IS DISTINCT FROM ARRAY[j359]
  OR e.metadata->>'placement_rule'<>'review_aftercare' OR e.contact_id<>'p4-contact-n18'
 THEN RAISE EXCEPTION 'N18/E17: must go to review with SWP-26359, got % % % %',e.attribution_status,e.job_id,e.candidate_job_ids,e.metadata; END IF;
 INSERT INTO public.business_events(event_type,source,channel,direction,occurred_at,event_at,contact_id,payload)
 VALUES('client.email_in','monitor-inbox','email','inbound','2026-09-10Z','2026-09-10Z','p4-contact-e20',
  '{"from":"customer.e20@example.com","subject":"Re: quote","body":"Which quote is mine?"}') RETURNING * INTO e;
 IF e.job_id IS NOT NULL OR e.attribution_status<>'pending_luna'
  OR e.candidate_job_ids IS DISTINCT FROM ARRAY['d4000000-0000-4000-8000-000000026167','d4000000-0000-4000-8000-000000026168']::uuid[]
 THEN RAISE EXCEPTION 'E20: must go to review with both jobs, got % % %',e.attribution_status,e.job_id,e.candidate_job_ids; END IF;
END $$;

-- E21 and thread rules (X25): a reply on a conversation bound to job A that
-- names job B is direct on B, raises no thread_conflict and leaves A's binding.
-- A retired binding rests its rows unplaced with both jobs. A bound job that is
-- not a candidate of the known contact is not followed.
DO $$
DECLARE e public.business_events;
BEGIN
 INSERT INTO public.event_threads(thread_key,job_id,bound_by) VALUES('outlook:e21-conv','d4000000-0000-4000-8000-000000000183','ladder');
 INSERT INTO public.business_events(event_type,source,channel,direction,event_at,thread_key,payload)
 VALUES('client.email_in','monitor-inbox','email','inbound','2026-09-20Z','outlook:e21-conv','{"from":"crew@supplier.example","subject":"Re: SWP-26941 materials","body":"On site Monday."}')
 RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM 'd4000000-0000-4000-8000-000000000941' OR e.attribution_status<>'direct' OR e.payload ? 'attribution_error'
 THEN RAISE EXCEPTION 'E21: must be direct on B with no thread_conflict, got % % %',e.attribution_status,e.job_id,e.payload; END IF;
 IF (SELECT job_id FROM public.event_threads WHERE thread_key='outlook:e21-conv')<>'d4000000-0000-4000-8000-000000000183'
 THEN RAISE EXCEPTION 'E21: the binding to A moved'; END IF;
 -- A retired thread.
 UPDATE public.event_threads SET retired_at=now(),retired_reason='conflict',retired_conflict_job_id='d4000000-0000-4000-8000-000000000941'
 WHERE thread_key='outlook:e21-conv';
 INSERT INTO public.business_events(event_type,source,channel,direction,event_at,thread_key,payload)
 VALUES('client.email_in','monitor-inbox','email','inbound','2026-09-21Z','outlook:e21-conv','{"from":"crew@supplier.example","subject":"Re: materials","body":"Running late."}')
 RETURNING * INTO e;
 IF e.job_id IS NOT NULL OR e.attribution_status<>'unplaced' OR e.metadata->>'placement_rule'<>'thread_retired'
  OR e.candidate_job_ids IS DISTINCT FROM ARRAY['d4000000-0000-4000-8000-000000000183','d4000000-0000-4000-8000-000000000941']::uuid[]
 THEN RAISE EXCEPTION 'retired thread: must rest unplaced with both jobs, got % %',e.attribution_status,e.candidate_job_ids; END IF;
 -- A binding to a job the known contact does not have is not followed.
 INSERT INTO public.event_threads(thread_key,job_id,bound_by) VALUES('outlook:foreign-conv','d4000000-0000-4000-8000-000000000183','ladder');
 INSERT INTO public.business_events(event_type,source,channel,direction,event_at,thread_key,contact_id,payload)
 VALUES('client.email_in','monitor-inbox','email','inbound','2026-09-20Z','outlook:foreign-conv','p4-contact-n3','{"from":"c@example.net","subject":"Re: plans","body":"Looks good."}')
 RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM 'd4000000-0000-4000-8000-000000001222' OR e.attribution_status<>'single_open'
 THEN RAISE EXCEPTION 'thread check: a bound job outside the contact''s candidates was followed, got % %',e.attribution_status,e.job_id; END IF;
END $$;

-- The bucket re-run and the preview agree with the insert path; a P4 defect
-- surfaces as attribution_error, never an exception.
DO $$
DECLARE e public.business_events; p jsonb; n int;
BEGIN
 UPDATE public.feature_flags SET enabled=false WHERE flag_name='context_unlinked_rules_v1';
 INSERT INTO public.business_events(id,event_type,source,channel,direction,occurred_at,event_at,payload)
 VALUES('d4e00000-0000-4000-8000-000000000044','supplier.email_in','monitor-inbox','email','inbound','2026-09-21 21:28:07Z','2026-09-21 21:28:07Z',
  '{"from":"Quotes@perth.metroll.example","subject":"FW: Material Order Ref SWP 26195 - 7654321","body":"Quotation attached."}');
 UPDATE public.feature_flags SET enabled=true WHERE flag_name='context_unlinked_rules_v1';
 SELECT count(*) INTO n FROM public.event_threads;
 p:=public.context_attribution_preview('d4e00000-0000-4000-8000-000000000044',true);
 IF p->'decided'->>'job_number'<>'SWP-26195' OR p->'decided'->'would_bind'<>jsonb_build_array(jsonb_build_object('key','supplier_ref:perth.metroll.example:7654321','job_id','d4000000-0000-4000-8000-000000000195'))
  OR (SELECT count(*) FROM public.event_threads)<>n
 THEN RAISE EXCEPTION 'preview: must show the binding it would write and write none, got %',p; END IF;
 PERFORM public.rerun_context_attribution(1000,NULL);
 SELECT * INTO e FROM public.business_events WHERE id='d4e00000-0000-4000-8000-000000000044';
 IF e.job_id IS DISTINCT FROM 'd4000000-0000-4000-8000-000000000195' OR e.match_method<>'ladder_ref'
  OR NOT EXISTS(SELECT 1 FROM public.event_threads WHERE thread_key='supplier_ref:perth.metroll.example:7654321')
 THEN RAISE EXCEPTION 're-run: must decide as the preview did, got % %',e.attribution_status,e.job_id; END IF;
END $$;
ROLLBACK;

-- C. Structure.
DO $$
DECLARE f text; role_name text;
BEGIN
 IF (SELECT count(*) FROM public.feature_flags WHERE flag_name='context_unlinked_rules_v1' AND NOT enabled)<>1 THEN RAISE EXCEPTION 'p4: the flag row must exist, off'; END IF;
 FOREACH f IN ARRAY ARRAY['public.context_unlinked_rules_enabled()','public.context_supplier_order_tokens(text)',
  'public.context_sender_key(public.business_events)','public.context_job_unpaid_at(uuid,timestamptz)',
  'public.context_contact_job_timeline(text,timestamptz,text,text)','public.context_contact_jobs_at(text,timestamptz,text,text)',
  'public.context_ladder_p1a(public.business_events,boolean)','public.resolve_context_attribution(public.business_events,boolean,boolean)',
  'public.resolve_context_attribution(public.business_events)','public.context_attribution_preview(uuid,boolean)','public.attribute_business_event()'] LOOP
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF has_function_privilege(role_name,f,'EXECUTE') THEN RAISE EXCEPTION '% can execute %',role_name,f; END IF;
  END LOOP;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_supplier_order_tokens(text)','public.context_sender_key(public.business_events)',
  'public.context_job_unpaid_at(uuid,timestamptz)','public.context_contact_job_timeline(text,timestamptz,text,text)',
  'public.context_ladder_p1a(public.business_events,boolean)','public.resolve_context_attribution(public.business_events,boolean,boolean)'] LOOP
  IF has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'service_role can call private %',f; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_unlinked_rules_enabled()','public.context_contact_jobs_at(text,timestamptz,text,text)',
  'public.context_attribution_preview(uuid,boolean)','public.resolve_context_attribution(public.business_events)','public.attribute_business_event()'] LOOP
  IF NOT has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'service_role cannot execute %',f; END IF;
 END LOOP;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_contact_jobs_at(text,timestamptz)'::regprocedure)<>'911811b617fa760f5ddf847fb1ab853d'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_contact_job_timeline(text,timestamptz)'::regprocedure)<>'2bc8e76f14fda242eb6e4d414e93fefa'
 THEN RAISE EXCEPTION 'p4: P1a''s two-argument candidate set changed'; END IF;
 -- P1a's ladder body moved verbatim: undoing the one preview guard gives back
 -- P1a's live body byte for byte.
 IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid='public.context_ladder_p1a(public.business_events,boolean)'::regprocedure),
   E'   IF NOT p_preview THEN\n    INSERT INTO public.event_threads(thread_key,job_id,bound_by,source_event_id) VALUES(e.thread_key,candidate,''ladder'',e.id) ON CONFLICT DO NOTHING;\n   END IF;\n   IF EXISTS (SELECT 1 FROM public.event_threads WHERE thread_key=e.thread_key AND job_id<>candidate) THEN',
   E'   INSERT INTO public.event_threads(thread_key,job_id,bound_by,source_event_id) VALUES(e.thread_key,candidate,''ladder'',e.id) ON CONFLICT DO NOTHING;\n   IF NOT EXISTS (SELECT 1 FROM public.event_threads WHERE thread_key=e.thread_key AND job_id=candidate) THEN'))
  <>'fe50f14f4ab28d4d6c9dbb70bc85e7df'
 THEN RAISE EXCEPTION 'p4: context_ladder_p1a is not P1a''s body plus the preview guard'; END IF;
END $$;

-- An unreadable flag table reads as off.
BEGIN;
ALTER TABLE public.feature_flags RENAME TO feature_flags_moved;
DO $$ BEGIN IF public.context_unlinked_rules_enabled() THEN RAISE EXCEPTION 'p4: a missing flag table must read as off'; END IF; END $$;
ROLLBACK;

-- Re-apply is a no-op.
CREATE TEMP TABLE p4_before AS SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS md5 FROM pg_proc p
 WHERE obj_description(p.oid,'pg_proc') LIKE 'P4:%' OR p.oid='public.attribute_business_event()'::regprocedure;
\ir ../../../migrations/20260924213000_context_unlinked_rules.sql
DO $$
BEGIN
 IF (SELECT count(*) FROM p4_before)<>11 THEN RAISE EXCEPTION 'expected 11 P4 functions, got %',(SELECT count(*) FROM p4_before); END IF;
 IF EXISTS(SELECT 1 FROM p4_before b LEFT JOIN pg_proc p ON p.oid=b.sig::regprocedure WHERE md5(p.prosrc) IS DISTINCT FROM b.md5)
 THEN RAISE EXCEPTION 'P4 re-apply changed a body'; END IF;
 IF (SELECT count(*) FROM public.feature_flags WHERE flag_name='context_unlinked_rules_v1')<>1 THEN RAISE EXCEPTION 'P4 re-apply duplicated the flag row'; END IF;
END $$;
DROP TABLE p4_before;
