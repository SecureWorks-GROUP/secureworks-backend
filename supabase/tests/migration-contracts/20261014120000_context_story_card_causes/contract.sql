\set ON_ERROR_STOP on
BEGIN;
SET LOCAL session_replication_role = replica;
CREATE FUNCTION pg_temp.sc_assert(ok boolean, why text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS NOT TRUE THEN RAISE EXCEPTION 'story card causes: %', why; END IF; END $$;
INSERT INTO public.jobs(id,org_id,job_number,type,status,client_name,client_email,ghl_contact_id,pricing_json,created_at,updated_at)
VALUES ('74100000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000aa','SWP-974101','patio','approvals',
 'Morgan Example','morgan@example.test','ct-story-causes','{"totalIncGST":8000}', '2026-09-01 00:00Z','2026-09-01 00:00Z'),
 ('74100000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000000aa','SWF-974102','fencing','scheduled',
 'Morgan Example','morgan@example.test','ct-story-causes','{}','2026-09-01 00:00Z','2026-09-01 00:00Z');
INSERT INTO public.job_documents(id,job_id,type,quote_number,version,created_at)
VALUES ('74200000-0000-4000-8000-000000000001','74100000-0000-4000-8000-000000000001','quote','Q-9741',1,'2026-09-02 01:00Z');
INSERT INTO public.xero_invoices(id,org_id,job_id,xero_invoice_id,xero_contact_id,contact_name,invoice_number,invoice_type,status,reference,
 total,amount_paid,amount_due,invoice_date,fully_paid_on,line_items,created_at)
VALUES ('74300000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000aa','74100000-0000-4000-8000-000000000001',
 'sc-invoice','sc-payer','Morgan Example','INV-9741','ACCREC','PAID','SWP-974101-DEP50',4000,4000,0,'2026-09-03','2026-09-03',
 '[{"Description":"50% Deposit","LineAmount":3636.36}]','2026-09-03 01:00Z');
INSERT INTO public.business_events(id,job_id,event_type,source,channel,direction,contact_id,provider_message_id,payload,metadata,
 occurred_at,recorded_at,event_at,context_captured_at,attribution_status,candidate_job_ids)
VALUES
 ('74400000-0000-4000-8000-000000000001','74100000-0000-4000-8000-000000000001','client.email_out','outlook-mail-capture','email','outbound',
 'ct-story-causes','email:sc-quote@example.test','{"body":"Here is your quote attached.","folder_kind":"sent","sender_kind":"ours","to":["morgan@example.test"]}',
 '{"written_as":"service_role"}','2026-09-02 02:00Z','2026-09-02 02:00Z','2026-09-02 02:00Z','2026-09-02 02:00Z','direct',NULL),
 ('74400000-0000-4000-8000-000000000002',NULL,'call.transcript_completed','ghl-call-transcript','call','inbound','ct-story-causes','ghltx:sc-held',
 jsonb_build_object('transcript',repeat('Background conversation. ',175)||'Tell the crew to add extra concrete at the shared fence. The damaged side panel belongs to SWF-974102, not this patio.'),
 '{"written_as":"service_role","placement_rule":"review_several"}',
 '2026-09-04 02:00Z','2026-09-04 02:00Z','2026-09-04 02:00Z','2026-09-04 02:00Z','unplaced',
 ARRAY['74100000-0000-4000-8000-000000000001','74100000-0000-4000-8000-000000000002']::uuid[]);
INSERT INTO public.context_email_attachments(id,provider_message_id,attachment_key,business_event_id,file_name,content_type,sha256,storage_bucket,storage_path,status,created_at)
VALUES ('74500000-0000-4000-8000-000000000001','email:sc-quote@example.test',repeat('a',64),'74400000-0000-4000-8000-000000000001',
 'Quote_Morgan_SWP-974101.pdf','application/pdf',repeat('b',64),'context-email-attachments','synthetic.pdf','stored','2026-09-02 03:00Z');
UPDATE public.business_events SET attribution_confidence=1 WHERE id='74400000-0000-4000-8000-000000000001';
CREATE TEMP TABLE sc_before AS SELECT id,md5(to_jsonb(e)::text) h FROM public.business_events e WHERE id::text LIKE '74400000-%';
DO $proof$
DECLARE j uuid := '74100000-0000-4000-8000-000000000001'; t timestamptz := '2026-10-01 00:00Z'; p jsonb; s jsonb; v record; x jsonb;
BEGIN
 SELECT * INTO v FROM public.context_job_record_value(ARRAY[j],t);
 PERFORM pg_temp.sc_assert(v.value=8000 AND v.issued=4000 AND v.accepted AND v.checks='[]'::jsonb,'sent attachment clears false C2, paid deposit accepts, amount stays exact');
 PERFORM pg_temp.sc_assert((SELECT count(*)=1 FROM public.context_job_quote_email_sends(ARRAY[j],t)),'one actual sent quote');
 PERFORM pg_temp.sc_assert((SELECT count(*)=0 FROM public.context_job_quote_email_sends(ARRAY[j],'2026-09-02 02:30Z')),'attachment not captured yet cannot prove an earlier read');
 s := public.context_job_story(j,t);
 PERFORM pg_temp.sc_assert((s#>>'{money,not_yet_invoiced,amount}')::numeric=4000 AND s#>>'{money,not_yet_invoiced,status}'='not_due'
   AND s#>>'{money,not_yet_invoiced,held}'='true' AND (s#>>'{money,parties,0,owing}')::numeric=0,'future balance held, not lost or owed');
 PERFORM pg_temp.sc_assert(s#>>'{money,line}' LIKE '%not owed now%' AND NOT (s#>>'{money,job_value,basis}' LIKE '%unconfirmed%'),'money meaning in the card text');
 p := public.context_ledger_packet(j,NULL,t);
 x := p#>'{held,rows,0}';
 PERFORM pg_temp.sc_assert(x->>'text' LIKE '%extra concrete%' AND x->>'text' LIKE '%SWF-974102%'
   AND x->>'certainty'='job_not_certain' AND x->>'cut'='false','held transcript tail survives, including sibling boundary');
 PERFORM pg_temp.sc_assert(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'evidence') e WHERE e->>'id'='74400000-0000-4000-8000-000000000002'), 'held never becomes job evidence');
 x := public.context_ledger_cite(j,'{"table":"business_events","id":"74400000-0000-4000-8000-000000000002","excerpt":"Tell the crew to add extra concrete"}');
 PERFORM pg_temp.sc_assert(x->>'code'='citation_off_job' OR x->>'reason'='citation_off_job','held still cannot certify a job matter');
 PERFORM pg_temp.sc_assert(s#>>'{held_messages,items,0,text}' LIKE '%extra concrete%' AND s#>>'{held_messages,items,0,job_certain}'='false','story input gets the same uncertain tail');
 PERFORM pg_temp.sc_assert(public.context_job_story_writer_input(j)#>>'{card,held_messages,items,0,text}' LIKE '%extra concrete%','real writer input, not only standalone helper');
 PERFORM pg_temp.sc_assert((SELECT count(*)=2 FROM public.context_ledger_held_rows(ARRAY[j,'74100000-0000-4000-8000-000000000002']::uuid[],t)),'both candidates see context');
 PERFORM pg_temp.sc_assert(NOT EXISTS(SELECT 1 FROM sc_before b JOIN public.business_events e USING(id) WHERE md5(to_jsonb(e)::text)<>b.h),'reads move no source');
END $proof$;
-- A forwarded response is read and citable as correspondence, never fed into placement.
UPDATE public.business_events SET payload=payload || '{"forwarded_correspondence":"From: Example City\nPlease find attached all available building plans as requested. Previous job SWP-999999.","forwarded_correspondence_truncated":false}'::jsonb
WHERE id='74400000-0000-4000-8000-000000000001';
SELECT pg_temp.sc_assert((SELECT public.context_event_text(e) NOT LIKE '%SWP-999999%' FROM public.business_events e
 WHERE id='74400000-0000-4000-8000-000000000001'),'forwarded references cannot change placement');
SELECT pg_temp.sc_assert((SELECT body LIKE '%all available building plans as requested%' AND body LIKE '%quoted content%'
 FROM public.context_ledger_evidence_rows(ARRAY['74100000-0000-4000-8000-000000000001']::uuid[],'2026-10-01')
 WHERE src_id='74400000-0000-4000-8000-000000000001'),'notes reader gets the supplied correspondence body');
SELECT pg_temp.sc_assert(public.context_ledger_cite('74100000-0000-4000-8000-000000000001',
 '{"table":"business_events","id":"74400000-0000-4000-8000-000000000001","excerpt":"Please find attached all available building plans as requested"}') ->> 'ok' = 'true',
 'a note can cite the supplied content, same excerpt rule');
-- Controls: wrong recipient, wrong whole token, attachment absent, later quote and final-balance conflict.
UPDATE public.business_events SET payload=jsonb_set(payload,'{to}','["other@example.test"]') WHERE id='74400000-0000-4000-8000-000000000001';
SELECT pg_temp.sc_assert((SELECT count(*)=0 FROM public.context_job_quote_email_sends(ARRAY['74100000-0000-4000-8000-000000000001']::uuid[],'2026-10-01')),'wrong recipient is no sent proof');
UPDATE public.business_events SET payload=jsonb_set(payload,'{to}','["morgan@example.test"]') WHERE id='74400000-0000-4000-8000-000000000001';
UPDATE public.context_email_attachments SET file_name='Quote_SWP-9741019.pdf' WHERE id='74500000-0000-4000-8000-000000000001';
SELECT pg_temp.sc_assert((SELECT count(*)=0 FROM public.context_job_quote_email_sends(ARRAY['74100000-0000-4000-8000-000000000001']::uuid[],'2026-10-01')),'longer job token is not our job');
UPDATE public.context_email_attachments SET file_name='Quote_Q-9741.pdf' WHERE id='74500000-0000-4000-8000-000000000001';
SELECT pg_temp.sc_assert((SELECT count(*)=1 FROM public.context_job_quote_email_sends(ARRAY['74100000-0000-4000-8000-000000000001']::uuid[],'2026-10-01')),'exact quote token works');
UPDATE public.jobs SET accepted_at='2026-09-03 00:00Z' WHERE id='74100000-0000-4000-8000-000000000001';
UPDATE public.xero_invoices SET reference='SWP-974101-FINBAL',line_items='[{"Description":"Final balance"}]' WHERE id='74300000-0000-4000-8000-000000000001';
SELECT pg_temp.sc_assert((SELECT jsonb_array_length(checks)>0 FROM public.context_job_record_value(ARRAY['74100000-0000-4000-8000-000000000001']::uuid[],'2026-10-01')),'real final invoice conflict is never cleared by sent proof');
INSERT INTO public.job_documents(id,job_id,type,quote_number,version,created_at)
VALUES ('74200000-0000-4000-8000-000000000002','74100000-0000-4000-8000-000000000001','quote','Q-9742',2,'2026-09-02 01:30Z');
SELECT pg_temp.sc_assert((SELECT count(*)=0 FROM public.context_job_quote_email_sends(ARRAY['74100000-0000-4000-8000-000000000001']::uuid[],'2026-10-01')),'later version cannot borrow older attachment');
UPDATE public.context_email_attachments SET file_name='Quote_SWP-974101.pdf' WHERE id='74500000-0000-4000-8000-000000000001';
SELECT pg_temp.sc_assert((SELECT count(*)=0 FROM public.context_job_quote_email_sends(ARRAY['74100000-0000-4000-8000-000000000001']::uuid[],'2026-10-01')),'two same-day documents cannot be picked by job filename');
ROLLBACK;
BEGIN;
-- (held notes, 20261015100000) replaced the judge, the item check, the story's ledger read, the packet and
-- the story since: its down goes first, inside this transaction only.
SELECT to_regprocedure('public.context_ledger_held_cite(uuid,jsonb)') IS NOT NULL AS held_notes_live \gset
\if :held_notes_live
\ir ../../../rollbacks/20261015100000_context_held_notes_down.sql
\endif
CREATE TEMP TABLE sc_md5 AS SELECT oid,md5(prosrc) h FROM pg_proc WHERE proname IN
 ('context_ledger_packet','context_job_story','context_job_story_held','context_job_record_value','context_job_quote_email_sends','context_job_story_payment_terms',
  'context_ledger_evidence_rows','context_ledger_cite','context_ledger_held_rows','context_story_message_text');
\ir ../../../migrations/20261014120000_context_story_card_causes.sql
DO $$ BEGIN IF EXISTS(SELECT 1 FROM sc_md5 s JOIN pg_proc p USING(oid) WHERE md5(p.prosrc)<>s.h) THEN RAISE EXCEPTION 'story card causes reapply drift'; END IF; END $$;
ROLLBACK;
