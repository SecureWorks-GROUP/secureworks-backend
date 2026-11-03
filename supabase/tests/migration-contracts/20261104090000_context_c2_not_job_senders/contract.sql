-- 20261104090000 contract (finish line C2). Proves, against real PostgreSQL:
--   1. the surface: the trigger fires before the ladder's insert trigger, both new functions and the register are
--      service role only, the register refuses a malformed entry;
--   2. context_not_job_sender names a register entry (exact address before its domain, a subdomain under a domain
--      entry, a removed entry ignored), a crew user and a staff user (not when they name a street address), a supplier
--      on record and an approved order address (domain and subdomain; a free mail address only exactly), the one
--      outside recipient of an outbound row, and nobody for an unknown sender or two outside recipients;
--   3. the reason step asks it only at the end: a job reference still answers first, and an unknown sender is still
--      no_identity;
--   4. the insert trigger gives a text its entity's GHL contact, and nothing else changes.
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL statement_timeout = '120s';

-- 1. Surface.
DO $$ BEGIN
 IF (SELECT array_agg(tgname::text ORDER BY tgname::text) FROM pg_trigger
     WHERE tgrelid = 'public.business_events'::regclass AND tgname IN ('context_a0_entity_contact','context_attribute_business_event'))
    IS DISTINCT FROM ARRAY['context_a0_entity_contact','context_attribute_business_event'] THEN
  RAISE EXCEPTION 'c2 not-job senders contract: the entity trigger is missing or does not fire first';
 END IF;
 IF has_function_privilege('anon', 'public.context_not_job_sender(public.business_events)', 'EXECUTE')
 OR has_function_privilege('authenticated', 'public.context_not_job_sender(public.business_events)', 'EXECUTE')
 OR NOT has_function_privilege('service_role', 'public.context_not_job_sender(public.business_events)', 'EXECUTE')
 OR has_table_privilege('anon', 'public.context_sender_register', 'SELECT')
 OR has_table_privilege('authenticated', 'public.context_sender_register', 'SELECT')
 OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.context_sender_register'::regclass) THEN
  RAISE EXCEPTION 'c2 not-job senders contract: grants or row security wrong';
 END IF;
 BEGIN
  INSERT INTO public.context_sender_register(match, party_kind, note, added_by) VALUES ('Bank@Example.com', 'system', 'x', 'contract');
  RAISE EXCEPTION 'c2 not-job senders contract: a mixed-case entry was taken';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
END $$;

-- Fixtures.
INSERT INTO public.users(id, org_id, name, role, email, phone) VALUES
 ('9a000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'Crew One', 'crew', 'crew.one@gmail.com', '0411 000 111'),
 ('9a000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'Office Two', 'ops_manager', 'office.two@gmail.com', NULL);
INSERT INTO public.suppliers(id, name, email) VALUES
 ('9b000000-0000-4000-8000-000000000001', 'Steel Co', 'sales@steelco-test.com.au');
INSERT INTO public.dispatch_approved_supplier_emails(name, to_emails, cc_emails) VALUES
 ('Sheet Co', ARRAY['orders@perth.sheetco-test.com.au'], ARRAY['rep@bigpond.com']);
INSERT INTO public.context_sender_register(match, party_kind, note, added_by, removed_at) VALUES
 ('@examplebank-test.com.au', 'system', 'bank alerts', 'contract', NULL),
 ('owner.private@examplebank-test.com.au', 'personal', 'owner private', 'contract', NULL),
 ('@newsletter-test.com', 'marketing', 'newsletter', 'contract', NULL),
 ('cards@printer-test.com.au', 'vendor', 'business cards', 'contract', NULL),
 ('old@gone-test.com.au', 'admin', 'removed entry', 'contract', now());

CREATE TEMP TABLE c2_fx(label text, row_json jsonb, expected text) ON COMMIT DROP;
INSERT INTO c2_fx VALUES
 ('crew by email', '{"event_type":"client.email_in","direction":"inbound","payload":{"from":"Crew One <crew.one@gmail.com>","subject":"running late"}}', 'crew_party'),
 ('crew by phone', '{"event_type":"client.reply","payload":{"phone":"+61411000111","body":"on my way"}}', 'crew_party'),
 ('staff by email', '{"event_type":"client.email_in","direction":"inbound","payload":{"from":"office.two@gmail.com","subject":"fyi"}}', 'own_party'),
 ('register domain via subdomain', '{"event_type":"client.email_in","direction":"inbound","payload":{"from":"alerts@email8.examplebank-test.com.au","subject":"Payment to new payee"}}', 'system_notice'),
 ('register address beats domain', '{"event_type":"client.email_in","direction":"inbound","payload":{"from":"owner.private@examplebank-test.com.au","subject":"Loan"}}', 'personal_mail'),
 ('register marketing', '{"event_type":"client.email_in","direction":"inbound","payload":{"from":"news@newsletter-test.com","subject":"This week"}}', 'marketing_sender'),
 ('register removed entry ignored', '{"event_type":"client.email_in","direction":"inbound","payload":{"from":"old@gone-test.com.au","subject":"hello"}}', NULL),
 ('outbound to one vendor', '{"event_type":"client.email_out","direction":"outbound","payload":{"to":["jan@secureworkswa.com.au","cards@printer-test.com.au"],"subject":"Quote request: business cards"}}', 'business_vendor'),
 ('outbound to two outside names nobody', '{"event_type":"client.email_out","direction":"outbound","payload":{"to":["cards@printer-test.com.au","news@newsletter-test.com"],"subject":"hello"}}', NULL),
 ('supplier on record', '{"event_type":"client.email_in","direction":"inbound","payload":{"from":"accounts@steelco-test.com.au","subject":"Statement"}}', 'supplier_no_ref'),
 ('approved order domain', '{"event_type":"client.email_in","direction":"inbound","payload":{"from":"quotes@perth.sheetco-test.com.au","subject":"Quote 1051619"}}', 'supplier_no_ref'),
 ('approved order subdomain', '{"event_type":"client.email_in","direction":"inbound","payload":{"from":"x@payments.perth.sheetco-test.com.au","subject":"Receipt"}}', 'supplier_no_ref'),
 ('approved free mail exact', '{"event_type":"client.email_in","direction":"inbound","payload":{"from":"rep@bigpond.com","subject":"order"}}', 'supplier_no_ref'),
 ('approved free mail other address', '{"event_type":"client.email_in","direction":"inbound","payload":{"from":"someone@bigpond.com","subject":"order"}}', NULL),
 ('crew naming a street address stays open', '{"event_type":"client.email_in","direction":"inbound","payload":{"from":"crew.one@gmail.com","subject":"12 Smith Street, Balga"}}', NULL),
 ('register sender with a shop address is still named', '{"event_type":"client.email_in","direction":"inbound","payload":{"from":"alerts@email8.examplebank-test.com.au","subject":"Receipt","body":"Branch: 150 Hay Street, Perth"}}', 'system_notice'),
 ('unknown sender', '{"event_type":"client.email_in","direction":"inbound","payload":{"from":"new.person@gmail.com","subject":"Patio quote"}}', NULL),
 ('our own address', '{"event_type":"client.email_in","direction":"inbound","payload":{"from":"shaun@secureworkswa.com.au","subject":"fyi"}}', NULL);

-- 2. Who the sender is.
DO $$ DECLARE r record; got text; bad text[] := '{}'; BEGIN
 FOR r IN SELECT * FROM c2_fx LOOP
  got := public.context_not_job_sender(jsonb_populate_record(NULL::public.business_events, r.row_json))->>'reason';
  IF got IS DISTINCT FROM r.expected THEN bad := bad || format('%s: %s, expected %s', r.label, coalesce(got, 'null'), coalesce(r.expected, 'null')); END IF;
 END LOOP;
 IF cardinality(bad) > 0 THEN RAISE EXCEPTION 'c2 not-job senders contract: %', array_to_string(bad, '; '); END IF;
END $$;

-- 3. The reason step asks only at the end.
DO $$ DECLARE got text; BEGIN
 got := public.context_bucket_reason_detail(jsonb_populate_record(NULL::public.business_events,
  '{"event_type":"client.email_in","direction":"inbound","payload":{"from":"alerts@email8.examplebank-test.com.au","subject":"Payment to new payee"}}'), NULL)->>'reason';
 IF got IS DISTINCT FROM 'system_notice' THEN
  RAISE EXCEPTION 'c2 not-job senders contract: the reason step names the sender (got %)', coalesce(got, 'null');
 END IF;
 got := public.context_bucket_reason_detail(jsonb_populate_record(NULL::public.business_events,
  '{"event_type":"client.email_in","direction":"inbound","payload":{"from":"alerts@email8.examplebank-test.com.au","subject":"About SWX-99999"}}'), NULL)->>'reason';
 IF got IS DISTINCT FROM 'ref_not_found' THEN
  RAISE EXCEPTION 'c2 not-job senders contract: a job reference must answer first (got %)', coalesce(got, 'null');
 END IF;
 got := public.context_bucket_reason_detail(jsonb_populate_record(NULL::public.business_events,
  '{"event_type":"client.email_in","direction":"inbound","payload":{"from":"new.person@gmail.com","subject":"Patio quote"}}'), NULL)->>'reason';
 IF got IS DISTINCT FROM 'no_identity' THEN
  RAISE EXCEPTION 'c2 not-job senders contract: an unknown sender stays no_identity (got %)', coalesce(got, 'null');
 END IF;
END $$;

-- 4. The insert trigger.
INSERT INTO public.business_events(id, event_type, source, occurred_at, entity_type, entity_id, contact_id, payload) VALUES
 ('9c000000-0000-4000-8000-000000000001', 'client.sms_out', 'contract', TIMESTAMPTZ '2026-10-01 01:00:00+00', 'contact', 'AbCdEfGhIj0123456789', NULL, '{"message_preview":"Hi"}'),
 ('9c000000-0000-4000-8000-000000000002', 'client.sms_out', 'contract', TIMESTAMPTZ '2026-10-01 01:00:00+00', 'contact', 'AbCdEfGhIj0123456789', 'ZyXwVuTsRq9876543210', '{"message_preview":"Hi"}'),
 ('9c000000-0000-4000-8000-000000000003', 'client.sms_out', 'contract', TIMESTAMPTZ '2026-10-01 01:00:00+00', 'job', 'AbCdEfGhIj0123456789', NULL, '{"message_preview":"Hi"}'),
 ('9c000000-0000-4000-8000-000000000004', 'client.review_requested', 'contract', TIMESTAMPTZ '2026-10-01 01:00:00+00', 'contact', 'AbCdEfGhIj0123456789', NULL, '{}'),
 ('9c000000-0000-4000-8000-000000000005', 'client.email_in', 'contract', TIMESTAMPTZ '2026-10-01 01:00:00+00', 'unmatched_contact', 'someone@example.org', NULL, '{"from":"someone@example.org"}');
DO $$ DECLARE bad text[] := '{}'; BEGIN
 IF (SELECT contact_id FROM public.business_events WHERE id = '9c000000-0000-4000-8000-000000000001') IS DISTINCT FROM 'AbCdEfGhIj0123456789'
 OR (SELECT metadata->>'contact_from_entity' FROM public.business_events WHERE id = '9c000000-0000-4000-8000-000000000001') IS DISTINCT FROM 'true' THEN
  bad := bad || 'entity contact not filled'::text;
 END IF;
 IF (SELECT contact_id FROM public.business_events WHERE id = '9c000000-0000-4000-8000-000000000002') IS DISTINCT FROM 'ZyXwVuTsRq9876543210' THEN
  bad := bad || 'a writer''s own contact was replaced'::text;
 END IF;
 IF EXISTS (SELECT 1 FROM public.business_events WHERE id IN ('9c000000-0000-4000-8000-000000000003','9c000000-0000-4000-8000-000000000004','9c000000-0000-4000-8000-000000000005')
            AND (contact_id IS NOT NULL OR metadata ? 'contact_from_entity')) THEN
  bad := bad || 'a job entity, a non-message row or a non-GHL entity got a contact'::text;
 END IF;
 IF cardinality(bad) > 0 THEN RAISE EXCEPTION 'c2 not-job senders contract: %', array_to_string(bad, '; '); END IF;
END $$;

ROLLBACK;
SELECT 'c2 not-job senders contract passed' AS result;
