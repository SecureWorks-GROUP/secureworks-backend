-- B0 contract. Proves, against real PostgreSQL:
--   1. the SQL key helpers give exactly the fixture table the TypeScript twin
--      runs (job_refs_contract_rows_test.ts proves the block below IS
--      _shared/job_refs_fixtures.ts);
--   2. every B0 function is service_role only;
--   3. the census classifies the named rows (adminbucket.md B0 row: N1, N5,
--      N6, N8 as a custody multi_ref candidate, N10; plus N2, N3, N4, N7, N9,
--      N23 and a re-stamped legacy row), agrees with the per-row reason, runs
--      in a read-only transaction and writes nothing;
--   4. the rows read pages newest first with a cursor and returns what the job
--      read shows;
--   5. a budget that runs out returns partial totals, not an error.
\set ON_ERROR_STOP 1

-- 1. One fixture table, run through the SQL helpers.
CREATE TEMP TABLE b0_fx(kind text, label text, input text, expected jsonb);
INSERT INTO b0_fx VALUES
-- FIXTURES BEGIN
 ('tokens','INV-1075 legacy job number','SW1346','["SW1346"]'::jsonb),
 ('tokens','INV-0664 two-job reference','SWF-260705 & SWF-26078','["SWF-260705","SWF-26078"]'::jsonb),
 ('tokens','INV-0664 design line string SWF-260705 | 17 Clarke Rd','SWF-260705 | 17 Clarke Rd','["SWF-260705"]'::jsonb),
 ('tokens','INV-0664 design line string SWF-26078 | 17 Clarke Rd','SWF-26078 | 17 Clarke Rd','["SWF-26078"]'::jsonb),
 ('tokens','unhyphenated form stays exact','SWP26376','["SWP26376"]'::jsonb),
 ('tokens','typo suffix stays one token','SWF-26777-V','["SWF-26777-V"]'::jsonb),
 ('tokens','N4 space-joined job number','FW: Material Order Ref SWP 26195 - 1047995','["1047995","26195","SWP-26195","SWP26195"]'::jsonb),
 ('tokens','N22 dated job number exact','Re: SWG-20260713-BE install','["SWG-20260713-BE"]'::jsonb),
 ('tokens','lower case reads as upper','about swp-26195 please','["SWP-26195"]'::jsonb),
 ('tokens','N8 two references','paid invoice for SWP-26183 and SWP-26941','["SWP-26183","SWP-26941"]'::jsonb),
 ('tokens','sms R13 a date is not a reference','see you on the 21 Sep','[]'::jsonb),
 ('tokens','an amount is not a reference','the balance is $5,478','[]'::jsonb),
 ('tokens','ACCREC number in a subject','Re: Invoice #INV-1244','["INV-1244"]'::jsonb),
 ('tokens','space-joined invoice number','paid INV 1244 today','["INV-1244","INV1244"]'::jsonb),
 ('tokens','empty text','','[]'::jsonb),
 ('phone','international','+61 412 345 678','"412345678"'::jsonb),
 ('phone','local','0412 345 678','"412345678"'::jsonb),
 ('phone','international without plus','61412345678','"412345678"'::jsonb),
 ('phone','punctuated','(04) 1234-5678','"412345678"'::jsonb),
 ('phone','placeholder zeros','0000000000','null'::jsonb),
 ('phone','too short','1234567','null'::jsonb),
 ('phone','our line','+61489267771','null'::jsonb),
 ('phone','landline','08 9123 4567','"891234567"'::jsonb),
 ('email','display-name form','Customer A <Person.A@Example.com.au>','"person.a@example.com.au"'::jsonb),
 ('email','trimmed and lower-cased','  X.Y@Example.COM ','"x.y@example.com"'::jsonb),
 ('email','our domain','admin@secureworkswa.com.au','null'::jsonb),
 ('email','our tool domain','orders@secureworksgroup.app','null'::jsonb),
 ('email','not an address','unknown sender','null'::jsonb),
 ('address','N3 text: 20A Beenan, no type','Acknowledgement BDBPCERT-2026/3018 - 20A Beenan','{"key":null,"loose":["20 beenan"]}'::jsonb),
 ('address','N3 job: 20 Beenan Cl','20 Beenan Cl, Karawara','{"key":"20 beenan cl","loose":["20 beenan"]}'::jsonb),
 ('address','N3 letter suffix kept in the exact key','20a Beenan Close, Karawara','{"key":"20a beenan cl","loose":["20 beenan"]}'::jsonb),
 ('address','E10 text: Montane Tn','Fw: 34 Montane Tn, Banksia Grove','{"key":"34 montane tn","loose":["34 montane"]}'::jsonb),
 ('address','E10 job: Montane Turn','34 Montane Turn, Banksia Grove WA 6031','{"key":"34 montane tn","loose":["34 montane"]}'::jsonb),
 ('address','E7 slash form','Re: Fencing Quote and Retaining - 4/6 St Joseph Close Stirling','{"key":"4/6 st joseph cl","loose":["4 st joseph","6 st joseph"]}'::jsonb),
 ('address','E7 job: 4 St Joseph Cl','4 St Joseph Cl, Stirling','{"key":"4 st joseph cl","loose":["4 st joseph"]}'::jsonb),
 ('address','N2 subject','RFI - BC26/1697 - Application for Building Permit - 14 Bradley Street','{"key":"14 bradley st","loose":["14 bradley"]}'::jsonb),
 ('address','N2 job','14 Bradley St, Yokine','{"key":"14 bradley st","loose":["14 bradley"]}'::jsonb),
 ('address','unit prefix kept','3/20 Smith Street','{"key":"3/20 smith st","loose":["3 smith","20 smith"]}'::jsonb),
 ('address','street name under 4 letters','12 Ash St','{"key":null,"loose":null}'::jsonb),
 ('address','no address','Please call me back','{"key":null,"loose":null}'::jsonb);
-- FIXTURES END
DO $$
DECLARE f record; got jsonb; bad text[]:='{}';
BEGIN
 FOR f IN SELECT * FROM b0_fx LOOP
  got:=CASE f.kind
   WHEN 'tokens' THEN coalesce(to_jsonb(public.context_job_ref_tokens(f.input)),'null')
   WHEN 'phone' THEN coalesce(to_jsonb(public.context_phone_key(f.input)),'null')
   WHEN 'email' THEN coalesce(to_jsonb(public.context_email_key(f.input)),'null')
   ELSE jsonb_build_object('key',public.context_address_key(f.input),'loose',public.context_address_loose_keys(f.input)) END;
  IF got IS DISTINCT FROM f.expected THEN bad:=bad||format('%s %s: got %s, expected %s',f.kind,f.label,got,f.expected); END IF;
 END LOOP;
 IF cardinality(bad)>0 THEN RAISE EXCEPTION 'b0 fixture mismatch: %',array_to_string(bad,' | '); END IF;
 IF (SELECT count(*) FROM b0_fx)<30 THEN RAISE EXCEPTION 'b0 fixture table unexpectedly short'; END IF;
END $$;

-- The key functions never raise on odd input (P4 will call them in the ladder).
DO $$
DECLARE v text;
BEGIN
 FOREACH v IN ARRAY ARRAY[NULL,'','////',',,,','0/0 Main St','99999999 x',repeat('9 ',5000)] LOOP
  PERFORM public.context_phone_key(v), public.context_email_key(v), public.context_address_key(v),
   public.context_address_loose_keys(v), public.context_job_ref_tokens(v);
 END LOOP;
END $$;

-- 2. Grants: service_role only.
DO $$
DECLARE f text; bad text[]:='{}';
BEGIN
 FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND obj_description(p.oid,'pg_proc') LIKE 'B0:%' LOOP
  IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') THEN bad:=bad||(f||' reachable by anon or authenticated'); END IF;
  IF NOT has_function_privilege('service_role',f,'EXECUTE') THEN bad:=bad||(f||' not executable by service_role'); END IF;
 END LOOP;
 IF cardinality(bad)>0 THEN RAISE EXCEPTION 'b0 grants: %',array_to_string(bad,'; '); END IF;
 IF (SELECT count(*) FROM pg_proc p WHERE obj_description(p.oid,'pg_proc') LIKE 'B0:%')<>18 THEN
  RAISE EXCEPTION 'b0: expected 18 B0 functions, found %',(SELECT count(*) FROM pg_proc p WHERE obj_description(p.oid,'pg_proc') LIKE 'B0:%');
 END IF;
 -- The jobs indexes use built-in expressions only, so a jobs write by any role
 -- never needs EXECUTE on a B0 function.
 IF EXISTS (SELECT 1 FROM pg_indexes WHERE tablename='jobs' AND indexname LIKE 'jobs_context_%' AND indexdef LIKE '%context_%key%') THEN
  RAISE EXCEPTION 'b0: a jobs index calls a B0 key function';
 END IF;
END $$;

-- 3 to 5. Named rows. Job numbers are the design's row labels; every contact
-- detail is synthetic. Shapes follow the production read of 23 Sep 2026: N1
-- and N10 carry a GHL contact and sat in the bucket (filed before P1a, when a
-- draft job was never a candidate); N6 sits on the holding job by the old
-- ladder's step 1; N5 and N8 have no event row in production (N5 was never
-- captured, N8's inbox copy has no event copy), so their rows here are the
-- design's shape. Rows go through the live insert trigger (the P1a ladder);
-- rows production filed differently are then set to their recorded state.
BEGIN;
INSERT INTO public.jobs(id,org_id,job_number,status,type,client_email,client_phone,ghl_contact_id,site_address,completed_at,created_at,metadata) VALUES
 ('b0000000-0000-4000-8000-000000000001',gen_random_uuid(),'SWP-261379','draft','patio','customer.n1@example.com','0400 111 001','contact-n1',NULL,NULL,'2026-09-10 00:00:00+00','{}'),
 ('b0000000-0000-4000-8000-000000000002',gen_random_uuid(),'SWP-26701','order_materials','patio',NULL,NULL,'contact-n2','14 Bradley St, Yokine WA 6060, Australia',NULL,'2026-06-01 00:00:00+00','{}'),
 ('b0000000-0000-4000-8000-000000000003',gen_random_uuid(),'SWP-261222','approvals','patio',NULL,NULL,'contact-n3','20 Beenan Cl, Karawara WA 6152, Australia',NULL,'2026-07-01 00:00:00+00','{}'),
 ('b0000000-0000-4000-8000-000000000004',gen_random_uuid(),'SWP-26195','awaiting_supplier','patio',NULL,NULL,'contact-n4','5 Lizard St, Banksia Grove WA 6031, Australia',NULL,'2026-05-01 00:00:00+00','{}'),
 ('b0000000-0000-4000-8000-000000000005',gen_random_uuid(),'SWP-26183','in_progress','patio',NULL,NULL,'contact-n8a','34A McKenzie Way, Embleton WA 6062, Australia',NULL,'2026-05-01 00:00:00+00','{}'),
 ('b0000000-0000-4000-8000-000000000006',gen_random_uuid(),'SWP-26941','in_progress','patio',NULL,NULL,'contact-n8b','3 Prior Pass, Clarkson WA 6030, Australia',NULL,'2026-05-01 00:00:00+00','{}'),
 ('b0000000-0000-4000-8000-000000000007',gen_random_uuid(),'SWF-26566','completed','fencing',NULL,NULL,'contact-n7',NULL,'2026-08-17 02:40:46+00','2026-07-01 00:00:00+00','{}'),
 ('b0000000-0000-4000-8000-000000000008',gen_random_uuid(),'SWF-PDF-BUCKET','scheduled','fencing',NULL,NULL,NULL,NULL,NULL,'2026-01-01 00:00:00+00','{"do_not_schedule":true}'),
 ('b0000000-0000-4000-8000-000000000009',gen_random_uuid(),'SWP-261401','draft','patio','lead.n10@example.net',NULL,'contact-n10',NULL,NULL,'2026-09-19 00:00:00+00','{}'),
 ('b0000000-0000-4000-8000-000000000011',gen_random_uuid(),'SWP-25029','scheduled','patio',NULL,NULL,NULL,NULL,NULL,'2026-05-01 00:00:00+00','{}'),
 ('b0000000-0000-4000-8000-000000000012',gen_random_uuid(),'SWF-261105','scheduled','fencing',NULL,NULL,NULL,NULL,NULL,'2026-05-01 00:00:00+00','{}'),
 ('b0000000-0000-4000-8000-000000000013',gen_random_uuid(),'SWF-261098','scheduled','fencing',NULL,NULL,NULL,NULL,NULL,'2026-05-01 00:00:00+00','{}'),
 ('b0000000-0000-4000-8000-000000000014',gen_random_uuid(),'SWP-261160','scheduled','patio',NULL,NULL,NULL,NULL,NULL,'2026-05-01 00:00:00+00','{}'),
 ('b0000000-0000-4000-8000-000000000015',gen_random_uuid(),'SWP-261063','scheduled','patio',NULL,NULL,NULL,NULL,NULL,'2026-05-01 00:00:00+00','{}'),
 ('b0000000-0000-4000-8000-000000000016',gen_random_uuid(),'SWP-261050','scheduled','patio','identity.e@example.com',NULL,'contact-e','9 Other Rd, Nowhere',NULL,'2026-05-01 00:00:00+00','{}');

INSERT INTO public.business_events(id,event_type,source,channel,direction,occurred_at,event_at,provider_message_id,source_table,source_id,contact_id,job_id,match_method,thread_key,payload) VALUES
 -- N1: customer email; monitor-inbox resolved her GHL contact.
 ('b0e00000-0000-4000-8000-000000000001','client.email_in','monitor-inbox','email','inbound','2026-09-18 06:46:52+00','2026-09-18 06:46:52+00','graph:n1-ABLTy7PQAAAA==','inbox_events','aa6745bb-n1','contact-n1',NULL,'none',NULL,
  '{"from":"Customer.N1@Example.com","subject":"Re: SecureWorks Patios","body":"Could someone come out for a site visit?","attribution_hint":{"job_id":"b0000000-0000-4000-8000-000000000001","match_method":"contact_id","match_confidence":0.85}}'),
 -- N5 (design shape): supplier invoice batch, job numbers only inside PDFs.
 ('b0e00000-0000-4000-8000-000000000005','supplier.email_in','monitor-inbox','email','inbound','2026-09-04 04:38:08+00','2026-09-04 04:38:08+00','graph:n5-AAJGOp_9AAA=','inbox_events','n5-inbox',NULL,NULL,'none',NULL,
  '{"from":"accounts@supplier-n5.example","subject":"invoices","body":"Please find attached invoices."}'),
 -- N6: supplier bill through a shared platform (placed on the holding job below).
 ('b0e00000-0000-4000-8000-000000000006','client.email_in','monitor-inbox','email','inbound','2026-09-18 03:49:17+00','2026-09-18 03:49:17+00','graph:n6-ABLTy7NgAAAA==','inbox_events','00c9f583-n6',NULL,NULL,'none',NULL,
  '{"from":"Invoices@apps.myob.com","subject":"Invoice 00065797; From a supplier","body":"Your invoice is attached."}'),
 -- N10: enquiry; monitor-inbox resolved a GHL contact whose job came the next day.
 ('b0e00000-0000-4000-8000-000000000010','client.email_in','monitor-inbox','email','inbound','2026-09-18 08:41:59+00','2026-09-18 08:41:59+00','graph:n10-ABLTy7QAAAAA==','inbox_events','47461f75-n10','contact-n10',NULL,'none',NULL,
  '{"from":"lead.n10@example.net","subject":"Re: SecureWorks Patios","body":"Can you quote a carport repair?"}'),
 -- N2: council request naming the site in its subject, no contact.
 ('b0e00000-0000-4000-8000-000000000002','client.email_in','monitor-inbox','email','inbound','2026-09-18 03:30:34+00','2026-09-18 03:30:34+00','graph:n2-ABLTy7NQAAAA==','inbox_events','n2-inbox',NULL,NULL,'none',NULL,
  '{"from":"Development@stirling.wa.gov.au","subject":"RFI - BC26/1697 - Application for Building Permit - 14 Bradley Street","body":"Further information is required."}'),
 -- N3: certifier acknowledgement, "20A" against the stored "20 Beenan Cl".
 ('b0e00000-0000-4000-8000-000000000003','client.email_in','monitor-inbox','email','inbound','2026-09-18 05:14:42+00','2026-09-18 05:14:42+00','graph:n3-ABLTy7OwAAAA==','inbox_events','n3-inbox',NULL,NULL,'none',NULL,
  '{"from":"noreply@southperth.wa.gov.au","subject":"Acknowledgement BDBPCERT-2026/3018 - 20A Beenan","body":"Your application has been received."}'),
 -- N4: supplier quote with the job number typed with a space.
 ('b0e00000-0000-4000-8000-000000000004','supplier.email_in','monitor-inbox','email','inbound','2026-09-21 21:28:07+00','2026-09-21 21:28:07+00','graph:n4-AAJUKLgEAA','inbox_events','n4-inbox',NULL,NULL,'none',NULL,
  '{"from":"Quotes@perth.metroll.example","subject":"FW: Material Order Ref SWP 26195 - 1047995","body":"Quotation attached."}'),
 -- N8 (design shape): monitor-inbox bound this to the first of two references.
 ('b0e00000-0000-4000-8000-000000000008','supplier.email_in','monitor-inbox','email','inbound','2026-09-10 02:00:00+00','2026-09-10 02:00:00+00','graph:n8-a7e0d2ba','inbox_events','a7e0d2ba-n8',NULL,'b0000000-0000-4000-8000-000000000005','direct_reference',NULL,
  '{"from":"accounts@bdmetals.example","subject":"paid invoice for SWP-26183 and SWP-26941","body":"Remittance attached."}'),
 -- N9: a digest naming seven jobs and one that does not exist.
 ('b0e00000-0000-4000-8000-000000000009','client.email_in','monitor-inbox','email','inbound','2026-09-22 09:07:36+00','2026-09-22 09:07:36+00','graph:n9-AAJUKaZ8AAA=','inbox_events','n9-inbox',NULL,NULL,'none',NULL,
  '{"from":"supplier.n9@example.org","subject":"tax invoices, copies for Finance","body":"SWP-25029 SWP-26183 SWP-26941 SWF-261105 SWF-261098 SWP-261160 SWP-261063 SWP-261009"}'),
 -- N7: customer text two hours after the job completed.
 ('b0e00000-0000-4000-8000-000000000007','client.sms_in','ghl-webhook-receiver','sms','inbound','2026-08-17 04:39:18+00','2026-08-17 04:39:18+00','ghl:lCdPzSqF6QFAl8inI5wp',NULL,NULL,'contact-n7',NULL,'none',NULL,
  '{"body":"someone needs to come and sign off with us face to face before we commit to final payment"}'),
 -- Identity in payload.from only, no contact on the row (identity unread).
 ('b0e00000-0000-4000-8000-000000000019','client.email_in','monitor-inbox','email','inbound','2026-09-20 02:00:00+00','2026-09-20 02:00:00+00','graph:ident-1','inbox_events','ident-inbox',NULL,NULL,'none',NULL,
  '{"from":"Customer E <Identity.E@Example.com>","subject":"question","body":"When do you start?"}'),
 -- A typo of our job number (ref_not_found).
 ('b0e00000-0000-4000-8000-000000000020','client.sms_in','ghl-webhook-receiver','sms','inbound','2026-09-20 01:00:00+00','2026-09-20 01:00:00+00','ghl:typo-1',NULL,NULL,NULL,NULL,'none',NULL,
  '{"body":"about job SWF-26777-V"}'),
 -- Our own staff mail with no reference and no site.
 ('b0e00000-0000-4000-8000-000000000021','client.email_in','monitor-inbox','email','inbound','2026-09-19 01:00:00+00','2026-09-19 01:00:00+00','graph:own-1','inbox_events','own-inbox',NULL,NULL,'none',NULL,
  '{"from":"jan@secureworkswa.com.au","subject":"Planning update","body":"Update attached."}');

-- N1 and N10 as production filed them (bucket, before P1a made a draft a candidate).
UPDATE public.business_events SET job_id=NULL,attribution_status='admin_bucket',attribution_step=6,match_status='unresolved',
 match_method='none',match_confidence=NULL,attribution_confidence=NULL,attributed_at=NULL,candidate_job_ids=NULL,
 attribution_checked_at=occurred_at+interval '10 seconds',context_captured_at=occurred_at+interval '5 seconds',
 metadata=metadata-'placement_rule'
WHERE id IN ('b0e00000-0000-4000-8000-000000000001','b0e00000-0000-4000-8000-000000000010');
-- N6 as production filed it: the old ladder's step 1 on the holding job.
UPDATE public.business_events SET job_id='b0000000-0000-4000-8000-000000000008',attribution_status='direct',attribution_step=1,
 match_status='matched',match_method='direct_job_id',match_confidence=1,attribution_confidence=1
WHERE id='b0e00000-0000-4000-8000-000000000006';

-- N23: a row inserted with the public key (written_as anon).
SELECT set_config('request.jwt.claims','{"role":"anon"}',true);
INSERT INTO public.business_events(id,event_type,source,channel,direction,occurred_at,event_at,payload)
VALUES ('b0e00000-0000-4000-8000-000000000023','client.email_in','public-form','email','inbound','2026-09-19 02:00:00+00','2026-09-19 02:00:00+00',
 '{"from":"customer.n1@example.com","body":"hello"}');
SELECT set_config('request.jwt.claims','',true);

-- A legacy row the re-run stripped a day after it was captured.
-- A legacy row recorded before the ladder existed, whose job a re-run took off.
INSERT INTO public.business_events(id,event_type,source,channel,direction,occurred_at,event_at,payload)
VALUES ('b0e00000-0000-4000-8000-000000000030','client.sms_in','sms-cache-backfill','sms','inbound','2026-06-01 00:00:00+00','2026-06-01 00:00:00+00','{"body":"thanks"}');
UPDATE public.business_events SET attribution_status='admin_bucket',
 recorded_at='2026-09-01 00:00:00+00', context_captured_at=NULL, attribution_checked_at='2026-09-22 00:00:00+00',
 metadata=metadata||'{"attribution_hint":{"job_id":"b0000000-0000-4000-8000-000000000001","match_method":"contact_id"}}'
WHERE id='b0e00000-0000-4000-8000-000000000030';
-- A machine event whose writer gave a job with no method: the ladder took it off at insert.
INSERT INTO public.business_events(id,event_type,source,channel,direction,occurred_at,event_at,job_id,payload)
VALUES ('b0e00000-0000-4000-8000-000000000031','proposed_action.dispatched','ops-api','sms','outbound','2026-09-20 03:00:00+00','2026-09-20 03:00:00+00',
 'b0000000-0000-4000-8000-000000000001','{"body":"follow-up sent"}');

-- Where each row sits before the census (the starting point B0 measures).
DO $$
DECLARE bad text[]:='{}'; r record;
BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('b0e00000-0000-4000-8000-000000000001','admin_bucket'),('b0e00000-0000-4000-8000-000000000005','admin_bucket'),
  ('b0e00000-0000-4000-8000-000000000006','direct'),('b0e00000-0000-4000-8000-000000000010','admin_bucket'),
  ('b0e00000-0000-4000-8000-000000000002','admin_bucket'),('b0e00000-0000-4000-8000-000000000003','admin_bucket'),
  ('b0e00000-0000-4000-8000-000000000004','admin_bucket'),('b0e00000-0000-4000-8000-000000000008','direct'),
  ('b0e00000-0000-4000-8000-000000000009','admin_bucket'),('b0e00000-0000-4000-8000-000000000007','admin_bucket'),
  ('b0e00000-0000-4000-8000-000000000019','admin_bucket'),('b0e00000-0000-4000-8000-000000000020','admin_bucket'),
  ('b0e00000-0000-4000-8000-000000000021','admin_bucket'),('b0e00000-0000-4000-8000-000000000023','admin_bucket'),
  ('b0e00000-0000-4000-8000-000000000030','admin_bucket'),('b0e00000-0000-4000-8000-000000000031','admin_bucket')) AS t(id,st) LOOP
  IF (SELECT attribution_status FROM public.business_events WHERE id=r.id::uuid) IS DISTINCT FROM r.st THEN
   bad:=bad||format('%s is %s, expected %s',r.id,(SELECT attribution_status FROM public.business_events WHERE id=r.id::uuid),r.st);
  END IF;
 END LOOP;
 IF cardinality(bad)>0 THEN RAISE EXCEPTION 'b0 fixture placement: %',array_to_string(bad,'; '); END IF;
END $$;

-- The census and the rows read, in a read-only transaction as PostgREST runs
-- a GET, called as service_role. Results land in psql variables, then a temp
-- table (written after the role is reset) for the checks.
CREATE TEMP TABLE b0_res(k text PRIMARY KEY, v jsonb);
SELECT md5(string_agg(t::text,'|' ORDER BY t.id)) AS before_hash FROM public.business_events t \gset
SET LOCAL transaction_read_only = on;
SET LOCAL ROLE service_role;
SELECT public.context_unlinked_census() AS census \gset
SELECT public.context_unlinked_census(1) AS census_short \gset
SELECT public.context_unlinked_census(1,(:'census_short')::jsonb->'next'->>'phase',
 ((:'census_short')::jsonb->'next'->>'cursor_at')::timestamptz,((:'census_short')::jsonb->'next'->>'cursor_id')::uuid) AS census_resumed \gset
SELECT public.context_unlinked_rows('custody_multi_ref') AS custody_rows \gset
SELECT public.context_unlinked_rows('holding_job') AS holding_rows \gset
SELECT public.context_unlinked_rows('bucket',NULL,NULL,NULL,NULL,NULL,2) AS page1 \gset
SELECT (:'page1')::jsonb->'next_cursor'->>'at' AS c_at, (:'page1')::jsonb->'next_cursor'->>'id' AS c_id \gset
SELECT public.context_unlinked_rows('bucket',NULL,NULL,NULL,:'c_at'::timestamptz,:'c_id'::uuid,100) AS page2 \gset
SELECT public.context_unlinked_rows('bucket','no_identity_site') AS site_rows \gset
SELECT jsonb_object_agg(e.id::text,public.context_bucket_reason_detail(e)) AS per_row FROM public.business_events e
 WHERE e.id::text LIKE 'b0e00000-%' \gset
-- Follow `next` with a 1 ms budget until the census ends; add the parts up.
SELECT jsonb_build_object('calls',n,'bucket',b,'holding',h,'custody',c,'complete',done) AS walk FROM (
 WITH RECURSIVE w(n,res) AS (
  SELECT 1, public.context_unlinked_census(1)
  UNION ALL
  SELECT n+1, public.context_unlinked_census(1,res->'next'->>'phase',(res->'next'->>'cursor_at')::timestamptz,(res->'next'->>'cursor_id')::uuid)
  FROM w WHERE NOT (res->>'complete')::boolean AND n<200)
 SELECT max(n) n, sum((res->'admin_bucket'->>'classified')::int) b, sum((res->'holding_job'->>'classified')::int) h,
  sum((res->'custody_multi_ref'->>'checked')::int) c, bool_or((res->>'complete')::boolean) done FROM w) x \gset
RESET ROLE;
SELECT md5(string_agg(t::text,'|' ORDER BY t.id)) AS after_hash FROM public.business_events t \gset
INSERT INTO b0_res VALUES ('census',:'census'),('census_short',:'census_short'),('census_resumed',:'census_resumed'),
 ('custody_rows',:'custody_rows'),('holding_rows',:'holding_rows'),('page1',:'page1'),('page2',:'page2'),
 ('site_rows',:'site_rows'),('per_row',:'per_row'),('walk',:'walk'),('unchanged',to_jsonb(:'before_hash'=:'after_hash'));

DO $$
DECLARE c jsonb:=(SELECT v FROM b0_res WHERE k='census'); short jsonb:=(SELECT v FROM b0_res WHERE k='census_short');
 resumed jsonb:=(SELECT v FROM b0_res WHERE k='census_resumed'); per jsonb:=(SELECT v FROM b0_res WHERE k='per_row');
 walk jsonb:=(SELECT v FROM b0_res WHERE k='walk'); bad text[]:='{}'; r record;
BEGIN
 IF (SELECT v FROM b0_res WHERE k='unchanged')<>'true'::jsonb THEN bad:=bad||'census or rows read changed business_events'::text; END IF;
 IF (c->>'complete')::boolean IS NOT TRUE OR c->'next'<>'null'::jsonb THEN bad:=bad||format('census incomplete: %s',c->'next'); END IF;
 -- Each named row's reason, per row, and the census lists it under that reason.
 FOR r IN SELECT * FROM (VALUES
  ('b0e00000-0000-4000-8000-000000000001','contact_has_candidates','admin_bucket'), -- N1
  ('b0e00000-0000-4000-8000-000000000005','supplier_no_ref','admin_bucket'),        -- N5
  ('b0e00000-0000-4000-8000-000000000006','platform_sender','holding_job'),         -- N6
  ('b0e00000-0000-4000-8000-000000000010','contact_has_candidates','admin_bucket'), -- N10
  ('b0e00000-0000-4000-8000-000000000002','no_identity_site','admin_bucket'),       -- N2
  ('b0e00000-0000-4000-8000-000000000003','no_identity_site','admin_bucket'),       -- N3
  ('b0e00000-0000-4000-8000-000000000004','single_ref','admin_bucket'),             -- N4
  ('b0e00000-0000-4000-8000-000000000009','multi_ref_many','admin_bucket'),         -- N9
  ('b0e00000-0000-4000-8000-000000000007','contact_only_finished','admin_bucket'),  -- N7
  ('b0e00000-0000-4000-8000-000000000019','identity_unread','admin_bucket'),
  ('b0e00000-0000-4000-8000-000000000020','ref_not_found','admin_bucket'),
  ('b0e00000-0000-4000-8000-000000000021','own_party','admin_bucket'),
  ('b0e00000-0000-4000-8000-000000000023','unverified_writer','admin_bucket'),      -- N23
  ('b0e00000-0000-4000-8000-000000000030','restamped_legacy','admin_bucket'),
  ('b0e00000-0000-4000-8000-000000000031','hint_stripped','admin_bucket')) AS t(id,reason,phase) LOOP
  IF per->r.id->>'reason' IS DISTINCT FROM r.reason THEN
   bad:=bad||format('%s reason %s, expected %s',r.id,per->r.id->>'reason',r.reason);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(c->r.phase->'by_reason') b WHERE b->>'reason'=r.reason AND b->'sample_ids' ? r.id) THEN
   bad:=bad||format('census %s does not list %s under %s',r.phase,r.id,r.reason);
  END IF;
 END LOOP;
 -- N1 and N10: the live candidate set now holds their job (a draft), so a
 -- re-run would place them; no identity step needed.
 IF (per->'b0e00000-0000-4000-8000-000000000001'->>'contact_candidates')::int<>1 THEN bad:=bad||'N1 candidates'::text; END IF;
 -- Identity in payload.from only: recovered through one job's client_email.
 IF per->'b0e00000-0000-4000-8000-000000000019'->'identity' <> '{"email":true,"phone":false,"contacts":1}'::jsonb THEN
  bad:=bad||format('identity row %s',per->'b0e00000-0000-4000-8000-000000000019'->'identity');
 END IF;
 -- N2: exact key, one live job. N3: loose only, one candidate, never exact.
 IF per->'b0e00000-0000-4000-8000-000000000002'->'site_exact_job_ids' <> '["b0000000-0000-4000-8000-000000000002"]'::jsonb THEN bad:=bad||'N2 not an exact site match on SWP-26701'::text; END IF;
 IF per->'b0e00000-0000-4000-8000-000000000003'->'site_exact_job_ids' <> '[]'::jsonb
  OR per->'b0e00000-0000-4000-8000-000000000003'->'site_loose_job_ids' <> '["b0000000-0000-4000-8000-000000000003"]'::jsonb THEN
  bad:=bad||format('N3 site match %s',per->'b0e00000-0000-4000-8000-000000000003');
 END IF;
 -- N4: the space-joined form names SWP-26195.
 IF per->'b0e00000-0000-4000-8000-000000000004'->'ref_job_ids' <> '["b0000000-0000-4000-8000-000000000004"]'::jsonb THEN bad:=bad||'N4 not SWP-26195'::text; END IF;
 -- N7: finished two hours before, inside the aftercare window.
 IF (per->'b0e00000-0000-4000-8000-000000000007'->>'aftercare_window')::boolean IS NOT TRUE THEN bad:=bad||'N7 not in the aftercare window'::text; END IF;
 -- N9: seven known jobs (the non-existent eighth adds nothing).
 IF jsonb_array_length(per->'b0e00000-0000-4000-8000-000000000009'->'ref_job_ids')<>7 THEN bad:=bad||'N9 does not name seven jobs'::text; END IF;
 -- N8 is custody on its first job: the census reports it as naming two jobs.
 IF NOT (c->'custody_multi_ref'->'sample_ids' ? 'b0e00000-0000-4000-8000-000000000008') OR (c->'custody_multi_ref'->>'rows')::int<>1 THEN
  bad:=bad||format('N8 custody multi_ref %s',c->'custody_multi_ref');
 END IF;
 IF c->'admin_bucket'->'restamped_legacy_by_prior_method'->>'contact_id' IS DISTINCT FROM '1' THEN bad:=bad||'restamped by method'::text; END IF;
 -- Every row of every phase read exactly once, and the totals agree.
 IF (c->'admin_bucket'->>'classified')::int<>(c->'totals'->>'admin_bucket')::int
  OR (c->'holding_job'->>'classified')::int<>(c->'totals'->>'holding_job')::int
  OR (c->'custody_multi_ref'->>'checked')::int<>(c->'totals'->>'custody_monitor_inbox')::int THEN
  bad:=bad||format('classified counts differ from totals: %s',c->'totals');
 END IF;
 IF NOT (c ? 'bucket_by_source' AND c ? 'bucket_24h' AND c ? 'null_status_no_job_by_source'
  AND c->'totals' ? 'null_status_no_job' AND c->'totals' ? 'null_status_with_job') THEN bad:=bad||'census shape missing a section'::text; END IF;
 -- A spent budget returns what it read and where to go on, not an error.
 IF (short->>'complete')::boolean IS NOT FALSE OR short->'next'->>'phase' IS NULL OR NOT short ? 'totals' THEN
  bad:=bad||format('short budget %s',short->'next');
 END IF;
 IF resumed ? 'totals' THEN bad:=bad||'a resumed call repeated the whole-table totals'::text; END IF;
 -- Following next to the end reads every row once, however small the budget.
 IF (walk->>'complete')::boolean IS NOT TRUE OR (walk->>'bucket')::int<>(c->'totals'->>'admin_bucket')::int
  OR (walk->>'holding')::int<>(c->'totals'->>'holding_job')::int OR (walk->>'custody')::int<>(c->'totals'->>'custody_monitor_inbox')::int THEN
  bad:=bad||format('resumed walk %s',walk);
 END IF;
 IF cardinality(bad)>0 THEN RAISE EXCEPTION 'b0 census: %',array_to_string(bad,' | '); END IF;
END $$;

DO $$
DECLARE cr jsonb:=(SELECT v FROM b0_res WHERE k='custody_rows'); hr jsonb:=(SELECT v FROM b0_res WHERE k='holding_rows');
 p1 jsonb:=(SELECT v FROM b0_res WHERE k='page1'); p2 jsonb:=(SELECT v FROM b0_res WHERE k='page2'); st jsonb:=(SELECT v FROM b0_res WHERE k='site_rows');
 row8 jsonb; bad text[]:='{}'; ids1 text[]; ids2 text[];
BEGIN
 -- N8 through the read tool: both jobs named, what the job read shows.
 SELECT x INTO row8 FROM jsonb_array_elements(cr->'rows') x WHERE x->>'id'='b0e00000-0000-4000-8000-000000000008';
 IF row8 IS NULL THEN bad:=bad||'N8 missing from the custody scope'::text;
 ELSE
  IF row8->'named_job_numbers' <> '["SWP-26183","SWP-26941"]'::jsonb THEN bad:=bad||format('N8 named %s',row8->'named_job_numbers'); END IF;
  IF row8->>'bound_job_number' IS DISTINCT FROM 'SWP-26183' THEN bad:=bad||'N8 bound job'::text; END IF;
  IF row8->>'subject' IS DISTINCT FROM 'paid invoice for SWP-26183 and SWP-26941' OR row8->>'preview' IS DISTINCT FROM 'Remittance attached.'
   OR row8->>'sender' IS DISTINCT FROM 'accounts@bdmetals.example' THEN bad:=bad||'N8 does not show what the job read shows'::text; END IF;
 END IF;
 -- N6 through the read tool: on the holding job, platform sender.
 IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(hr->'rows') x WHERE x->>'id'='b0e00000-0000-4000-8000-000000000006'
   AND x->>'reason'='platform_sender' AND x->>'bound_job_number'='SWF-PDF-BUCKET') THEN bad:=bad||format('N6 holding row %s',hr->'rows'); END IF;
 -- Keyset pages: 2 then the rest, newest first, no overlap, nothing skipped.
 SELECT array_agg(x->>'id') INTO ids1 FROM jsonb_array_elements(p1->'rows') x;
 SELECT array_agg(x->>'id') INTO ids2 FROM jsonb_array_elements(p2->'rows') x;
 IF cardinality(ids1)<>2 OR p1->'next_cursor' IS NULL OR ids1 && ids2 THEN bad:=bad||format('page1 %s',ids1); END IF;
 IF p2->'next_cursor' <> 'null'::jsonb THEN bad:=bad||'page2 should be last'::text; END IF;
 IF cardinality(ids1)+cardinality(ids2)<>(SELECT count(*) FROM public.business_events WHERE attribution_status='admin_bucket') THEN
  bad:=bad||'pages skipped or repeated a bucket row'::text;
 END IF;
 IF (p1->'rows'->0->>'event_at')::timestamptz < (p1->'rows'->1->>'event_at')::timestamptz THEN bad:=bad||'rows not newest first'::text; END IF;
 -- Reason filter: only the two site rows; N3's lane names SWP-261222.
 IF jsonb_array_length(st->'rows')<>2 OR EXISTS (SELECT 1 FROM jsonb_array_elements(st->'rows') x WHERE x->>'reason'<>'no_identity_site') THEN
  bad:=bad||format('site filter %s',st->'rows');
 END IF;
 IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(st->'rows') x WHERE x->'named_job_numbers'='["SWP-261222"]'::jsonb) THEN bad:=bad||'N3 lane job not named'::text; END IF;
 IF cardinality(bad)>0 THEN RAISE EXCEPTION 'b0 rows: %',array_to_string(bad,' | '); END IF;
END $$;

-- A bad scope, phase or half a cursor is refused, not guessed.
DO $$
BEGIN
 BEGIN PERFORM public.context_unlinked_rows('everything'); RAISE EXCEPTION 'b0: unknown scope accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM public.context_unlinked_rows('bucket',NULL,NULL,NULL,now(),NULL); RAISE EXCEPTION 'b0: half cursor accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM public.context_unlinked_census(1000,'everything'); RAISE EXCEPTION 'b0: unknown phase accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM public.context_unlinked_census(1000,NULL,now(),gen_random_uuid()); RAISE EXCEPTION 'b0: cursor without phase accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END $$;
ROLLBACK;
