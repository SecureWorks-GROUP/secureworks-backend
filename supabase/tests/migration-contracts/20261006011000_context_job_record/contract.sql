-- Contract for 20261006011000_context_job_record: the record layer is read-only,
-- service-role only, and its rules behave as the proof-set reference says.
-- Every fixture row is synthetic and rolled back. User triggers are switched off
-- for the fixture transaction (session_replication_role = replica) so the
-- placement ladder does not move the synthetic rows.

-- 1. Shape and access.
DO $shape$
DECLARE f text; p record;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_job_record_timeline(uuid[],timestamptz)','public.context_job_record_loops(uuid[],timestamptz)',
   'public.context_job_record_money(uuid[],timestamptz)','public.context_job_record_contact(uuid[],timestamptz)'] LOOP
  SELECT pr.prosecdef, pr.provolatile, pr.proconfig INTO p FROM pg_proc pr WHERE pr.oid = to_regprocedure(f);
  IF p IS NULL THEN RAISE EXCEPTION 'record contract: % missing', f; END IF;
  IF NOT p.prosecdef OR p.provolatile <> 's' OR NOT ('search_path=public, pg_temp' = ANY (p.proconfig)) THEN
   RAISE EXCEPTION 'record contract: % must be STABLE SECURITY DEFINER with search_path public, pg_temp', f;
  END IF;
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
   RAISE EXCEPTION 'record contract: % is callable by anon or authenticated', f;
  END IF;
  IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
   RAISE EXCEPTION 'record contract: % is not callable by service_role', f;
  END IF;
  IF obj_description(to_regprocedure(f), 'pg_proc') NOT LIKE 'Job record (20261006011000)%' THEN
   RAISE EXCEPTION 'record contract: % comment does not name the slice', f;
  END IF;
 END LOOP;
 SELECT pr.prosecdef, pr.proconfig INTO p FROM pg_proc pr
 WHERE pr.oid = to_regprocedure('public.context_job_record_messages(uuid[],timestamptz)');
 IF p.prosecdef OR p.proconfig IS NOT NULL THEN
  RAISE EXCEPTION 'record contract: the messages helper must stay inlinable (no SET, not SECURITY DEFINER)';
 END IF;
 IF has_function_privilege('anon', 'public.context_job_record_messages(uuid[],timestamptz)', 'EXECUTE') THEN
  RAISE EXCEPTION 'record contract: the messages helper is callable by anon';
 END IF;
 SELECT pr.prosecdef, pr.proconfig INTO p FROM pg_proc pr
 WHERE pr.oid = to_regprocedure('public.context_job_record_legacy_mail(uuid[],timestamptz)');
 IF p IS NULL OR p.prosecdef OR p.proconfig IS NOT NULL THEN
  RAISE EXCEPTION 'record contract: the legacy mail helper must exist and stay inlinable';
 END IF;
 IF has_function_privilege('anon', 'public.context_job_record_legacy_mail(uuid[],timestamptz)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.context_job_record_legacy_mail(uuid[],timestamptz)', 'EXECUTE') THEN
  RAISE EXCEPTION 'record contract: the legacy mail helper is callable by anon or authenticated';
 END IF;
 IF to_regclass('public.inbox_events_job_id_record') IS NULL OR to_regclass('public.inbox_events_from_email_record') IS NULL THEN
  RAISE EXCEPTION 'record contract: the inbox_events lookup indexes are missing';
 END IF;
 -- rev-backend P2-16: a written date is read safely (one bad row never fails a story)
 SELECT pr.prosecdef, pr.proconfig INTO p FROM pg_proc pr WHERE pr.oid = to_regprocedure('public.context_job_record_date(text)');
 IF p IS NULL OR p.prosecdef OR p.proconfig IS NOT NULL OR has_function_privilege('anon', 'public.context_job_record_date(text)', 'EXECUTE') THEN
  RAISE EXCEPTION 'record contract: the date helper must exist, stay inlinable and not be callable by anon';
 END IF;
 IF public.context_job_record_date('2026-09-21') <> '2026-09-21' OR public.context_job_record_date('2026-09-21T10:00:00Z') <> '2026-09-21'
    OR public.context_job_record_date('2028-02-29') <> '2028-02-29'
    OR public.context_job_record_date('2026-02-30') IS NOT NULL OR public.context_job_record_date('21/09/2026') IS NOT NULL
    OR public.context_job_record_date('0000-01-01') IS NOT NULL OR public.context_job_record_date('') IS NOT NULL
    OR public.context_job_record_date(NULL) IS NOT NULL OR public.context_job_record_date('2026-13-01') IS NOT NULL THEN
  RAISE EXCEPTION 'record contract: the date helper must read real dates and nothing else';
 END IF;
END $shape$;

-- 2. Behaviour on synthetic jobs.
BEGIN;
SET LOCAL session_replication_role = replica;

INSERT INTO public.jobs (id, org_id, job_number, status, type, client_email, ghl_contact_id, pricing_json, created_at)
VALUES ('a0000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000aa', 'SWF-T0001', 'accepted', 'fencing',
        'cust.a@example.test', 'ctA', '{"totalIncGST": 11000}', '2026-09-01 01:00Z'),
       ('a0000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000aa', 'SWMS-T0002', 'processing', 'makesafe',
        NULL, NULL, '{}', '2026-09-01 01:00Z'),
       ('a0000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000aa', 'SWF-T0003', 'quoted', 'fencing',
        'cust.c@example.test', 'ctC', '{"totalIncGST": 5000}', '2026-09-01 01:00Z');

-- Job A messages: customer text, our workflow follow-up (never a reply), a crew alert (internal),
-- a missed call from the customer, and a text to the customer recorded only after the replay instant.
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, body_preview, occurred_at, recorded_at, event_at, attribution_status)
VALUES
 ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'client.reply', 'ghl', 'sms', 'inbound', 'ctA',
  '{"body":"Can you come Monday?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}', NULL,
  '2026-10-01 01:00Z', '2026-10-01 01:00Z', '2026-10-01 01:00Z', 'direct'),
 ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ctA',
  '{"body":"Reminder: your quote is waiting","sent_by_kind":"workflow"}', '{"party_roles":{"counterpart_role":"customer"}}', NULL,
  '2026-10-02 01:00Z', '2026-10-02 01:00Z', '2026-10-02 01:00Z', 'direct'),
 ('b0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'client.sms_out', 'ops-api', 'sms', 'outbound', 'ctCrew',
  '{"body":"New job assigned: SWF-T0001"}', '{"recipient_role":"crew","party_roles":{"counterpart_role":"crew"}}', NULL,
  '2026-10-03 01:00Z', '2026-10-03 01:00Z', '2026-10-03 01:00Z', 'direct'),
 ('b0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', 'client.call_logged', 'ghl', 'call', 'inbound', 'ctA',
  '{"body":"Call. Provider status: no-answer. Duration: 0 seconds"}', '{}', NULL,
  '2026-10-04 01:00Z', '2026-10-04 01:00Z', '2026-10-04 01:00Z', 'direct'),
 ('b0000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ctA',
  '{"body":"Sorry we missed you, Monday works"}', '{"party_roles":{"counterpart_role":"customer"}}', NULL,
  '2026-10-08 01:00Z', '2026-10-08 01:00Z', '2026-10-05 01:00Z', 'direct');

-- Job A money: overdue part-paid invoice, a deleted one, a stale draft, a supplier bill, and a
-- second payer's paid invoice settled partly by an earlier overpayment.
INSERT INTO public.xero_invoices (org_id, id, job_id, xero_invoice_id, xero_contact_id, contact_name, invoice_number, invoice_type, status, reference,
  total, amount_due, amount_paid, invoice_date, due_date, raw_json, created_at)
VALUES
 ('00000000-0000-4000-8000-0000000000aa', 'c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'x1', 'xc1', 'Payer One', 'INV-9001', 'ACCREC', 'AUTHORISED', 'SWF-T0001',
  1100, 800, 300, '2026-09-20', '2026-10-01',
  '{"Status":"AUTHORISED","Payments":[{"Amount":300,"Date":"/Date(1790294400000+0000)/"}],"AmountCredited":0}', '2026-09-20 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', 'c0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'x2', 'xc1', 'Payer One', 'INV-9002', 'ACCREC', 'DELETED', 'SWF-T0001',
  500, 0, 0, '2026-09-21', '2026-10-05', '{"Status":"DELETED"}', '2026-09-21 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', 'c0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'x3', 'xc1', 'Payer One', 'INV-9003', 'ACCREC', 'DRAFT', 'SWF-T0001',
  2000, 2000, 0, '2026-10-03', '2026-10-17', '{"Status":"DRAFT"}', '2026-10-03 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', 'c0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', 'x4', 'xs1', 'A Supplier', 'BILL-1', 'ACCPAY', 'AUTHORISED', NULL,
  400, 400, 0, '2026-09-25', '2026-09-30', '{"Status":"AUTHORISED"}', '2026-09-25 01:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', 'c0000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001', 'x5', 'xc2', 'Payer Two', 'INV-9005', 'ACCREC', 'PAID', 'SWF-T0001',
  1000, 0, 900, '2026-09-22', '2026-09-29',
  '{"Status":"PAID","Payments":[{"Amount":900,"Date":"/Date(1790380800000+0000)/"}],"Overpayments":[{"AppliedAmount":100,"Date":"/Date(1790380800000+0000)/"}],"AmountCredited":100}',
  '2026-09-22 01:00Z'),
 -- Job B: Xero columns say PAID while the raw copy still says AUTHORISED with no payments
 ('00000000-0000-4000-8000-0000000000aa', 'c0000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000002', 'x6', 'xc9', 'A Builder', 'INV-9006', 'ACCREC', 'PAID', 'SWMS-T0002',
  500, 0, 500, '2026-09-10', '2026-09-24', '{"Status":"AUTHORISED","Payments":[],"AmountCredited":0}', '2026-09-10 01:00Z');
UPDATE public.xero_invoices SET fully_paid_on = '2026-09-15' WHERE id = 'c0000000-0000-4000-8000-000000000006';

INSERT INTO public.job_documents (id, job_id, type, quote_number, version, created_at, sent_at, accepted_at)
VALUES ('d0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'quote', 'Q-9001', 1,
        '2026-09-10 01:00Z', '2026-09-10 01:10Z', '2026-09-12 01:00Z'),
       ('d0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000003', 'quote', 'Q-9003', 1,
        '2026-09-25 01:00Z', '2026-09-25 01:10Z', NULL);

-- Job B: a passed booking, an observer mirror left on a later day (R6 reads
-- crew bookings only), and a make-safe pack sent.
INSERT INTO public.job_assignments (id, job_id, role, scheduled_date, assignment_type, status, crew_name, confirmation_status, is_ghost, created_at)
VALUES ('e0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'lead_installer', '2026-10-02', 'install', 'scheduled', 'Crew One', 'tentative', false, '2026-09-28 01:00Z'),
       ('e0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002', 'observer', '2026-10-03', 'install', 'scheduled', NULL, 'confirmed', true, '2026-09-28 01:00Z');
INSERT INTO public.job_events (id, job_id, event_type, detail_json, created_at)
VALUES ('f0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'makesafe_pack_sent_at_derived', '{}', '2026-10-03 01:00Z'),
       -- Job C: status ping-pong within ten minutes folds into one row
       ('f0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000003', 'status_changed', '{"new_status":"awaiting_deposit"}', '2026-09-26 02:00Z'),
       ('f0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000003', 'status_changed', '{"new_status":"quoted"}', '2026-09-26 02:03Z'),
       ('f0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000003', 'status_changed', '{"new_status":"awaiting_deposit"}', '2026-09-26 02:05Z');

-- Job C: the customer's email exists only in the legacy inbox (no business_events copy).
INSERT INTO public.inbox_events (id, job_id, from_email, subject, body_preview, received_at, graph_message_id, mailbox)
VALUES ('aa000000-0000-4000-8000-000000000001', NULL, 'Cust.C@example.test', 'Quote question', 'Does the price include the gate?',
        '2026-10-03 01:00Z', 'g-legacy-1', 'admin@example.test'),
       ('aa000000-0000-4000-8000-000000000002', NULL, 'cust.c@example.test', 'Automatic reply: away', 'I am away',
        '2026-10-04 01:00Z', 'g-legacy-2', 'admin@example.test');
-- The same customer's mail that the old matcher placed on another of their jobs
-- (job E) belongs to job E only, never to job C.
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_email, ghl_contact_id, pricing_json, created_at)
VALUES ('a0000000-0000-4000-8000-00000000000e', '00000000-0000-4000-8000-0000000000aa', 'SWF-T000E', 'quoted', 'fencing',
        NULL, NULL, '{}', '2026-09-01 01:00Z');
INSERT INTO public.inbox_events (id, job_id, from_email, subject, body_preview, received_at, graph_message_id, mailbox)
VALUES ('aa000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-00000000000e', 'cust.c@example.test', 'About my other job',
        'When does the other fence start?', '2026-10-05 01:00Z', 'g-legacy-3', 'admin@example.test');

-- Job F: a booking whose status alone says complete, an app event with an
-- impossible date, and a call transcript as the customer's last word.
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_email, ghl_contact_id, pricing_json, created_at)
VALUES ('a0000000-0000-4000-8000-00000000000f', '00000000-0000-4000-8000-0000000000aa', 'SWF-T000F', 'complete', 'fencing',
        NULL, 'ctF', '{}', '2026-09-01 01:00Z');
INSERT INTO public.job_assignments (id, job_id, role, scheduled_date, assignment_type, status, crew_name, confirmation_status, is_ghost, created_at)
VALUES ('e0000000-0000-4000-8000-00000000000f', 'a0000000-0000-4000-8000-00000000000f', 'lead_installer', '2026-09-20', 'install', 'complete', 'Crew Two', 'confirmed', false, '2026-09-10 01:00Z');
INSERT INTO public.job_events (id, job_id, event_type, detail_json, created_at)
VALUES ('f0000000-0000-4000-8000-00000000000f', 'a0000000-0000-4000-8000-00000000000f', 'assignment_rescheduled',
        '{"old_date":"2026-02-30","new_date":"2026-09-20"}', '2026-09-12 01:00Z');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, body_preview, occurred_at, recorded_at, event_at, attribution_status)
VALUES ('b0000000-0000-4000-8000-00000000000f', 'a0000000-0000-4000-8000-00000000000f', 'call.transcript_completed', 'ghl-call-transcript', 'call', 'inbound', 'ctF',
        '{"transcript":"Hi, thanks for calling. Yes the gate is great."}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}', NULL,
        '2026-09-25 01:00Z', '2026-09-25 01:00Z', '2026-09-25 01:00Z', 'direct');

-- rev-backend P0-1, refined: mail from the client's address that no job holds.
-- Job H's client has another job (H2, the same CRM contact) and job I's client
-- another (I2, the same client email): their unplaced mail may be that other
-- job's, so it is withheld. Job J's client has only job J: its unplaced mail is
-- its from 30 days before it was created (and a booking J made before it).
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_email, ghl_contact_id, pricing_json, created_at)
VALUES ('a0000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-0000000000aa', 'SWF-T0010', 'quoted', 'fencing',
        'cust.h@example.test', 'ctH', '{}', '2026-09-01 01:00Z'),
       ('a0000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-0000000000aa', 'SWF-T0011', 'complete', 'fencing',
        NULL, 'ctH', '{}', '2025-03-01 01:00Z'),
       ('a0000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-0000000000aa', 'SWF-T0012', 'quoted', 'fencing',
        'cust.i@example.test', NULL, '{}', '2026-09-01 01:00Z'),
       ('a0000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-0000000000aa', 'SWF-T0013', 'complete', 'fencing',
        ' Cust.I@example.test ', 'ctI2', '{}', '2026-01-01 01:00Z'),
       ('a0000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-0000000000aa', 'SWF-T0014', 'quoted', 'fencing',
        'cust.j@example.test', 'ctJ', '{}', '2026-09-01 01:00Z');
INSERT INTO public.inbox_events (id, job_id, from_email, subject, body_preview, received_at, graph_message_id, mailbox)
VALUES ('aa000000-0000-4000-8000-000000000010', NULL, 'cust.h@example.test', 'Fence question', 'Can you also fix the side gate?',
        '2026-10-02 01:00Z', 'g-legacy-10', 'admin@example.test'),
       ('aa000000-0000-4000-8000-000000000012', NULL, 'cust.i@example.test', 'Fence question', 'Is the colour still available?',
        '2026-10-02 01:00Z', 'g-legacy-12', 'admin@example.test'),
       ('aa000000-0000-4000-8000-000000000014', NULL, 'cust.j@example.test', 'Old enquiry', 'Do you do pool fences as well?',
        '2026-07-31 01:00Z', 'g-legacy-14', 'admin@example.test'),
       ('aa000000-0000-4000-8000-000000000015', NULL, 'cust.j@example.test', 'New enquiry', 'Can you quote the front fence?',
        '2026-08-03 01:00Z', 'g-legacy-15', 'admin@example.test');
INSERT INTO public.job_assignments (id, job_id, role, scheduled_date, assignment_type, status, crew_name, confirmation_status, is_ghost, created_at)
VALUES ('e0000000-0000-4000-8000-000000000014', 'a0000000-0000-4000-8000-000000000014', 'lead_installer', '2026-10-20', 'install', 'scheduled',
        'Crew Three', 'confirmed', false, '2026-08-02 06:00Z');
-- Job K: a booking for today whose status alone says complete.
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_email, ghl_contact_id, pricing_json, created_at)
VALUES ('a0000000-0000-4000-8000-000000000015', '00000000-0000-4000-8000-0000000000aa', 'SWF-T0015', 'scheduled', 'fencing',
        NULL, 'ctK', '{}', now() - interval '10 days');
INSERT INTO public.job_assignments (id, job_id, role, scheduled_date, assignment_type, status, crew_name, confirmation_status, is_ghost, created_at)
VALUES ('e0000000-0000-4000-8000-000000000015', 'a0000000-0000-4000-8000-000000000015', 'lead_installer', (now() AT TIME ZONE 'Australia/Perth')::date,
        'install', 'complete', 'Crew Four', NULL, false, now() - interval '2 days');

DO $behave$
DECLARE
 a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'a0000000-0000-4000-8000-000000000002';
 c uuid := 'a0000000-0000-4000-8000-000000000003'; asof timestamptz := '2026-10-07 02:00Z';
 got text; n integer; r record;
BEGIN
 -- loops: the exact (rule, source) set for job A at the replay instant
 SELECT string_agg(l.rule || ':' || l.source_id, ',' ORDER BY l.rule, l.source_id) INTO got
 FROM public.context_job_record_loops(ARRAY[a], asof) l;
 IF got IS DISTINCT FROM
    'R1_overdue:c0000000-0000-4000-8000-000000000001,R2_part_paid:c0000000-0000-4000-8000-000000000001,'
    'R3_draft:c0000000-0000-4000-8000-000000000003,R4_missed_call:b0000000-0000-4000-8000-000000000004,'
    'R5_customer_wrote_last:b0000000-0000-4000-8000-000000000001,R8_not_yet_invoiced:a0000000-0000-4000-8000-000000000001' THEN
  RAISE EXCEPTION 'record contract: job A loops wrong (R5 must fire: automated and crew texts are never a reply): %', got;
 END IF;
 SELECT l.amount INTO r FROM public.context_job_record_loops(ARRAY[a], asof) l WHERE l.rule = 'R8_not_yet_invoiced';
 IF r.amount <> 8900 THEN RAISE EXCEPTION 'record contract: R8 amount % (want 8900: deleted and draft invoices never count)', r.amount; END IF;
 SELECT count(*) INTO n FROM public.context_job_record_loops(ARRAY[a], asof) l
 WHERE l.source_id = 'c0000000-0000-4000-8000-000000000004';
 IF n <> 0 THEN RAISE EXCEPTION 'record contract: a supplier bill was shown as money owed to us'; END IF;
 SELECT shown_as INTO got FROM public.context_job_record_loops(ARRAY[a], asof) WHERE rule = 'R5_customer_wrote_last';
 IF got <> 'candidate' THEN RAISE EXCEPTION 'record contract: R5 must be a candidate, got %', got; END IF;
 SELECT about_key INTO got FROM public.context_job_record_loops(ARRAY[a], asof) WHERE rule = 'R1_overdue';
 IF got <> 'invoice:inv-9001' THEN RAISE EXCEPTION 'record contract: R1 about_key %', got; END IF;
 -- the text recorded after the replay instant closes R4 and R5 only when read now
 SELECT count(*) INTO n FROM public.context_job_record_loops(ARRAY[a], '2026-10-09 00:00Z') l
 WHERE l.rule IN ('R4_missed_call', 'R5_customer_wrote_last');
 IF n <> 0 THEN RAISE EXCEPTION 'record contract: a later text to the customer must close R4 and R5'; END IF;

 -- job B: booking passed with status unmoved (the newest booking, mirrors included as the reference does),
 -- status lags the work, attendance unrecorded
 SELECT string_agg(l.rule || ':' || l.source_id, ',' ORDER BY l.rule) INTO got
 FROM public.context_job_record_loops(ARRAY[b], asof) l WHERE l.rule IN ('R6_booking_passed_status_unmoved', 'C1_status_lags_work', 'C4_booking_attendance_unrecorded');
 IF got IS DISTINCT FROM 'C1_status_lags_work:f0000000-0000-4000-8000-000000000001,C4_booking_attendance_unrecorded:e0000000-0000-4000-8000-000000000001,'
    'R6_booking_passed_status_unmoved:e0000000-0000-4000-8000-000000000001' THEN
  RAISE EXCEPTION 'record contract: job B checks wrong: %', got;
 END IF;

 -- job C: quote waiting 12 days (R7 reads evidence rows only, as the reference does, so the
 -- legacy-inbox email does not close it); that email is its own candidate; the auto-reply is dropped
 SELECT string_agg(l.rule || ':' || l.source_id, ',' ORDER BY l.rule) INTO got FROM public.context_job_record_loops(ARRAY[c], asof) l;
 IF got IS DISTINCT FROM 'C11_customer_mail_unanswered:aa000000-0000-4000-8000-000000000001,R7_quote_waiting:d0000000-0000-4000-8000-000000000003' THEN
  RAISE EXCEPTION 'record contract: job C loops wrong: %', got;
 END IF;
 SELECT string_agg(l.rule, ',') INTO got FROM public.context_job_record_loops(ARRAY[c], '2026-10-02 23:00Z') l;
 IF got IS NOT NULL THEN RAISE EXCEPTION 'record contract: R7 needs 8 whole days and C11 a day: %', got; END IF;

 -- timeline: Perth dates, folded status, payments, supplier bill, mirror kept apart, no em dashes
 SELECT count(*) INTO n FROM public.context_job_record_timeline(ARRAY[a, b, c], asof) t WHERE t.what ~ '[—–]';
 IF n > 0 THEN RAISE EXCEPTION 'record contract: em or en dash in timeline text'; END IF;
 SELECT count(*), max(t.what) INTO n, got FROM public.context_job_record_timeline(ARRAY[c], asof) t WHERE t.kind = 'status';
 IF n <> 1 OR got NOT LIKE 'Status changed 3 times within minutes: awaiting deposit -> quoted -> awaiting deposit%' THEN
  RAISE EXCEPTION 'record contract: status ping-pong not folded: % %', n, got;
 END IF;
 SELECT t.perth_date, t.amount INTO r FROM public.context_job_record_timeline(ARRAY[a], asof) t WHERE t.kind = 'payment' AND t.amount = 300;
 IF r.perth_date IS DISTINCT FROM '2026-09-25'::date THEN RAISE EXCEPTION 'record contract: payment date %', r.perth_date; END IF;
 SELECT count(*) INTO n FROM public.context_job_record_timeline(ARRAY[a], asof) t WHERE t.kind = 'credit' AND t.what LIKE 'Earlier overpayment $100.00 applied to INV-9005%';
 IF n <> 1 THEN RAISE EXCEPTION 'record contract: overpayment credit row missing'; END IF;
 SELECT count(*) INTO n FROM public.context_job_record_timeline(ARRAY[a], asof) t WHERE t.kind = 'supplier_bill' AND t.what LIKE '%we owe $400.00%';
 IF n <> 1 THEN RAISE EXCEPTION 'record contract: supplier bill row missing'; END IF;
 SELECT count(*) INTO n FROM public.context_job_record_timeline(ARRAY[a], asof) t WHERE t.kind = 'invoice' AND t.what LIKE 'Invoice INV-9002%deleted in Xero (never counted)';
 IF n <> 1 THEN RAISE EXCEPTION 'record contract: deleted invoice must be labelled'; END IF;
 SELECT count(*) INTO n FROM public.context_job_record_timeline(ARRAY[b], asof) t WHERE t.kind = 'booking_mirror';
 IF n <> 1 THEN RAISE EXCEPTION 'record contract: observer mirror must be its own kind'; END IF;
 SELECT count(*) INTO n FROM public.context_job_record_timeline(ARRAY[b], asof) t WHERE t.kind = 'payment' AND t.what LIKE 'Invoice INV-9006 paid in full%';
 IF n <> 1 THEN RAISE EXCEPTION 'record contract: paid-in-full fallback row missing for a stale raw copy'; END IF;
 SELECT t.what INTO got FROM public.context_job_record_timeline(ARRAY[b], asof) t WHERE t.kind = 'booking';
 IF got NOT LIKE 'Booking: install Fri 2 Oct 2026%' THEN RAISE EXCEPTION 'record contract: Perth weekday wrong: %', got; END IF;
 SELECT count(*) INTO n FROM public.context_job_record_timeline(ARRAY[a], asof) t WHERE t.source_id = 'b0000000-0000-4000-8000-000000000005';
 IF n <> 0 THEN RAISE EXCEPTION 'record contract: a row recorded after the replay instant leaked'; END IF;
 -- rev-backend P2-7: a status-only completion never says who or when; P2-16: an
 -- impossible date in an app event reads as no date, and the timeline still reads
 SELECT count(*) INTO n FROM public.context_job_record_timeline(ARRAY['a0000000-0000-4000-8000-00000000000f'::uuid], asof) t
 WHERE t.kind = 'attendance' AND t.what LIKE 'Booking status complete (who and when not recorded): install booked Sun 20 Sep 2026%';
 IF n <> 1 THEN RAISE EXCEPTION 'record contract: a status-only completion must not say the crew marked it'; END IF;
 SELECT count(*) INTO n FROM public.context_job_record_timeline(ARRAY['a0000000-0000-4000-8000-00000000000f'::uuid], asof) t
 WHERE t.source_id = 'f0000000-0000-4000-8000-00000000000f' AND t.what = 'Booking moved to Sun 20 Sep';
 IF n <> 1 THEN RAISE EXCEPTION 'record contract: an impossible date must read as no date'; END IF;
 -- Each timeline row says the state of the record it cites (and a booking when it was
 -- made), so no reader infers it from the words.
 IF (SELECT array_agg(DISTINCT t.source_id || '=' || coalesce(t.state, '-') ORDER BY t.source_id || '=' || coalesce(t.state, '-'))
     FROM public.context_job_record_timeline(ARRAY[a], asof) t WHERE t.source_table = 'xero_invoices')
    IS DISTINCT FROM ARRAY['c0000000-0000-4000-8000-000000000001=issued', 'c0000000-0000-4000-8000-000000000002=voided',
                           'c0000000-0000-4000-8000-000000000003=draft', 'c0000000-0000-4000-8000-000000000004=issued',
                           'c0000000-0000-4000-8000-000000000005=paid'] THEN
  RAISE EXCEPTION 'record contract: invoice states wrong: %', (SELECT array_agg(t.source_id || '=' || coalesce(t.state, '-'))
   FROM public.context_job_record_timeline(ARRAY[a], asof) t WHERE t.source_table = 'xero_invoices');
 END IF;
 IF (SELECT bool_and(t.state = 'accepted') FROM public.context_job_record_timeline(ARRAY[a], asof) t WHERE t.source_id = 'd0000000-0000-4000-8000-000000000001')
    IS NOT TRUE
    OR (SELECT bool_and(t.state = 'sent') FROM public.context_job_record_timeline(ARRAY[a], '2026-09-11 00:00Z') t
        WHERE t.source_id = 'd0000000-0000-4000-8000-000000000001') IS NOT TRUE THEN
  RAISE EXCEPTION 'record contract: a document''s state is its state as of the replay instant';
 END IF;
 IF (SELECT t.state || '/' || t.made_at FROM public.context_job_record_timeline(ARRAY[b], asof) t WHERE t.kind = 'booking')
    IS DISTINCT FROM 'scheduled/' || '2026-09-28 01:00Z'::timestamptz
    OR EXISTS (SELECT 1 FROM public.context_job_record_timeline(ARRAY[b], asof) t WHERE t.kind = 'booking_mirror' AND (t.state IS NOT NULL OR t.made_at IS NOT NULL))
    OR (SELECT count(*) FROM public.context_job_record_timeline(ARRAY['a0000000-0000-4000-8000-00000000000f'::uuid], asof) t
        WHERE t.source_id = 'e0000000-0000-4000-8000-00000000000f' AND t.state = 'attended' AND t.made_at = '2026-09-10 01:00Z') <> 2
    OR (SELECT t.at FROM public.context_job_record_timeline(ARRAY['a0000000-0000-4000-8000-00000000000f'::uuid], asof) t
        WHERE t.source_id = 'e0000000-0000-4000-8000-00000000000f' AND t.kind = 'attendance')
       IS DISTINCT FROM ('2026-09-21 00:00'::timestamp AT TIME ZONE 'Australia/Perth') - interval '1 second'
    OR EXISTS (SELECT 1 FROM public.context_job_record_timeline(ARRAY[a, b, c], asof) t
               WHERE t.source_table NOT IN ('xero_invoices', 'job_documents', 'job_assignments') AND (t.state IS NOT NULL OR t.made_at IS NOT NULL)) THEN
  RAISE EXCEPTION 'record contract: booking states, made_at or the status-only attendance time wrong';
 END IF;
 -- a status-only completion booked for today is attended now, never later today
 IF (SELECT t.at FROM public.context_job_record_timeline(ARRAY['a0000000-0000-4000-8000-000000000015'::uuid], now()) t WHERE t.kind = 'attendance')
    IS DISTINCT FROM now()
    OR (SELECT bool_and(t.state = 'attended') FROM public.context_job_record_timeline(ARRAY['a0000000-0000-4000-8000-000000000015'::uuid], now()) t
        WHERE t.source_table = 'job_assignments') IS NOT TRUE THEN
  RAISE EXCEPTION 'record contract: a status-only completion today is attended now, never later today';
 END IF;
 -- replayed during its booked day, a status-only completion is not attended yet
 IF (SELECT bool_and(t.state = 'scheduled') FROM public.context_job_record_timeline(ARRAY['a0000000-0000-4000-8000-00000000000f'::uuid], '2026-09-20 06:00Z') t
     WHERE t.source_id = 'e0000000-0000-4000-8000-00000000000f') IS NOT TRUE THEN
  RAISE EXCEPTION 'record contract: a status-only completion is attended from the end of its booked day';
 END IF;
 -- rev-backend P2-17: a transcript is a call with unlabelled speakers, not the customer's words
 SELECT * INTO r FROM public.context_job_record_contact(ARRAY['a0000000-0000-4000-8000-00000000000f'::uuid], asof);
 IF r.last_customer_message->>'id' <> 'b0000000-0000-4000-8000-00000000000f'
    OR r.last_customer_message->>'text' NOT LIKE 'Call (speakers not labelled): %' THEN
  RAISE EXCEPTION 'record contract: a transcript must read as a call: %', r.last_customer_message;
 END IF;

 -- money: per party, overpayment credited, stale raw copy flagged
 SELECT * INTO r FROM public.context_job_record_money(ARRAY[a], asof) m WHERE m.xero_contact_id = 'xc1';
 IF r.invoiced <> 1100 OR r.paid <> 300 OR r.owing <> 800 OR r.overdue <> 800 OR r.drafts <> 1 OR r.draft_total <> 2000
    OR r.not_yet_invoiced <> 8900 OR jsonb_array_length(r.supplier_bills) <> 1 THEN
  RAISE EXCEPTION 'record contract: payer one money wrong: %', row_to_json(r);
 END IF;
 SELECT * INTO r FROM public.context_job_record_money(ARRAY[a], asof) m WHERE m.xero_contact_id = 'xc2';
 IF r.invoiced <> 1000 OR r.paid <> 900 OR r.credited <> 100 OR r.owing <> 0 THEN
  RAISE EXCEPTION 'record contract: payer two money wrong: %', row_to_json(r);
 END IF;
 SELECT * INTO r FROM public.context_job_record_money(ARRAY[b], asof) m;
 IF r.paid <> 500 OR r.credited <> 0 OR NOT (r.invoices->0->>'xero_detail_stale')::boolean THEN
  RAISE EXCEPTION 'record contract: stale raw copy money wrong: %', row_to_json(r);
 END IF;
 SELECT count(*) INTO n FROM public.context_job_record_money(ARRAY[c], asof) m WHERE m.party IS NULL AND m.invoiced = 0;
 IF n <> 1 THEN RAISE EXCEPTION 'record contract: a job with no invoices needs one party-null row'; END IF;

 -- contact: automated and crew texts are never what we told the customer
 SELECT * INTO r FROM public.context_job_record_contact(ARRAY[a], asof);
 IF r.last_to_customer IS NOT NULL THEN RAISE EXCEPTION 'record contract: an automated or crew text counted as told the customer: %', r.last_to_customer; END IF;
 IF r.last_internal->>'id' <> 'b0000000-0000-4000-8000-000000000003' THEN RAISE EXCEPTION 'record contract: crew text must be the last internal message'; END IF;
 IF r.last_customer_message->>'id' <> 'b0000000-0000-4000-8000-000000000001' OR r.customer_messages <> 1 OR r.unanswered <> 1 OR r.replies <> 0 THEN
  RAISE EXCEPTION 'record contract: contact stats wrong: %', row_to_json(r);
 END IF;
 SELECT * INTO r FROM public.context_job_record_contact(ARRAY[a], '2026-10-09 00:00Z');
 IF r.last_to_customer->>'id' <> 'b0000000-0000-4000-8000-000000000005' OR r.replies <> 1 OR r.unanswered <> 0 OR r.median_reply_hours <> 96 THEN
  RAISE EXCEPTION 'record contract: contact after the reply wrong: %', row_to_json(r);
 END IF;
 SELECT * INTO r FROM public.context_job_record_contact(ARRAY[c], asof);
 IF r.last_customer_message->>'table' <> 'inbox_events' THEN RAISE EXCEPTION 'record contract: legacy inbox mail must count as the customer''s word'; END IF;
 -- the customer's mail placed on their other job stays there
 IF r.last_customer_message->>'id' <> 'aa000000-0000-4000-8000-000000000001' THEN
  RAISE EXCEPTION 'record contract: mail placed on another job leaked into job C: %', r.last_customer_message;
 END IF;
 -- client-address mail that no job holds is labelled so, in the contact doc and the timeline
 IF r.last_customer_message->>'placed_on' IS DISTINCT FROM 'none'
    OR r.last_customer_message->>'placement_note' IS DISTINCT FROM 'not placed on any job' THEN
  RAISE EXCEPTION 'record contract: unplaced mail must say it is not placed on any job: %', r.last_customer_message;
 END IF;
 SELECT count(*) INTO n FROM public.context_job_record_timeline(ARRAY[c], asof) t
 WHERE t.kind = 'first_contact' AND t.source_id = 'aa000000-0000-4000-8000-000000000001'
   AND t.what LIKE '%not placed on any job%' AND t.placement = 'not_placed';
 IF n <> 1 THEN RAISE EXCEPTION 'record contract: the first contact from unplaced mail must say so'; END IF;
 SELECT * INTO r FROM public.context_job_record_contact(ARRAY['a0000000-0000-4000-8000-00000000000e'::uuid], asof);
 IF r.last_customer_message->>'id' <> 'aa000000-0000-4000-8000-000000000003' OR r.last_customer_message->>'placed_on' <> 'this_job'
    OR r.last_customer_message ? 'placement_note' THEN
  RAISE EXCEPTION 'record contract: mail placed on the job is this job''s, with no note: %', r.last_customer_message;
 END IF;
 SELECT count(*) INTO n FROM public.context_job_record_timeline(ARRAY[c], asof) t WHERE t.source_id = 'aa000000-0000-4000-8000-000000000003';
 IF n <> 0 THEN RAISE EXCEPTION 'record contract: mail placed on another job is in job C''s timeline'; END IF;
 SELECT count(*) INTO n FROM public.context_job_record_legacy_mail(ARRAY['a0000000-0000-4000-8000-00000000000e'::uuid], asof) m
 WHERE m.id = 'aa000000-0000-4000-8000-000000000003' AND m.on_job;
 IF n <> 1 THEN RAISE EXCEPTION 'record contract: job E keeps the mail placed on it'; END IF;
 -- rev-backend P0-1, refined: a repeat client's unplaced mail is withheld (counted for
 -- the story, never a message of the job); a single job's counts from 30 days before it
 SELECT string_agg(m.id || '=' || m.placement, ',' ORDER BY m.id) INTO got
 FROM public.context_job_record_legacy_mail(ARRAY['a0000000-0000-4000-8000-000000000010', 'a0000000-0000-4000-8000-000000000012',
   'a0000000-0000-4000-8000-000000000014']::uuid[], asof) m;
 IF got IS DISTINCT FROM 'aa000000-0000-4000-8000-000000000010=withheld,aa000000-0000-4000-8000-000000000012=withheld,'
    || 'aa000000-0000-4000-8000-000000000015=not_placed' THEN
  RAISE EXCEPTION 'record contract: unplaced mail is withheld for a repeat client, and a single job''s starts 30 days before it: %', got;
 END IF;
 SELECT count(*) INTO n FROM public.context_job_record_messages(ARRAY['a0000000-0000-4000-8000-000000000010',
   'a0000000-0000-4000-8000-000000000012']::uuid[], asof) m;
 IF n <> 0 THEN RAISE EXCEPTION 'record contract: a repeat client''s unplaced mail is no message of the job'; END IF;
 SELECT * INTO r FROM public.context_job_record_contact(ARRAY['a0000000-0000-4000-8000-000000000010'::uuid], asof);
 IF r.last_customer_message IS NOT NULL THEN
  RAISE EXCEPTION 'record contract: a repeat client''s unplaced mail is not the customer''s last word: %', r.last_customer_message;
 END IF;
 SELECT count(*) INTO n FROM public.context_job_record_timeline(ARRAY['a0000000-0000-4000-8000-000000000010',
   'a0000000-0000-4000-8000-000000000012']::uuid[], asof) t WHERE t.source_table = 'inbox_events';
 IF n <> 0 THEN RAISE EXCEPTION 'record contract: a repeat client''s unplaced mail is not in the timeline'; END IF;
 SELECT count(*) INTO n FROM public.context_job_record_loops(ARRAY['a0000000-0000-4000-8000-000000000010',
   'a0000000-0000-4000-8000-000000000012']::uuid[], asof) l WHERE l.source_table = 'inbox_events';
 IF n <> 0 THEN RAISE EXCEPTION 'record contract: a repeat client''s unplaced mail opens no candidate'; END IF;
 SELECT * INTO r FROM public.context_job_record_contact(ARRAY['a0000000-0000-4000-8000-000000000014'::uuid], asof);
 IF r.last_customer_message->>'id' IS DISTINCT FROM 'aa000000-0000-4000-8000-000000000015'
    OR r.last_customer_message->>'placement_note' IS DISTINCT FROM 'not placed on any job' THEN
  RAISE EXCEPTION 'record contract: a single job''s unplaced mail is its, labelled: %', r.last_customer_message;
 END IF;
 -- N5: a candidate or check that quotes unplaced mail says so, in its words and its placement
 SELECT count(*) INTO n FROM public.context_job_record_loops(ARRAY[c], asof) l
 WHERE l.rule = 'C11_customer_mail_unanswered' AND l.placement = 'not_placed'
   AND l.what LIKE 'Customer emailed % (stored only in the old inbox, not placed on any job) and nothing went to the customer since:%';
 IF n <> 1 THEN RAISE EXCEPTION 'record contract: C11 on unplaced mail must say it is not placed on any job'; END IF;
 SELECT count(*) INTO n FROM public.context_job_record_loops(ARRAY['a0000000-0000-4000-8000-000000000014'::uuid], asof) l
 WHERE l.rule = 'C6_booking_after_customer_word' AND l.placement = 'not_placed' AND l.source_id = 'aa000000-0000-4000-8000-000000000015'
   AND l.what LIKE '%(an email not placed on any job) after it was made%';
 IF n <> 1 THEN RAISE EXCEPTION 'record contract: C6 on unplaced mail must say it is not placed on any job'; END IF;
 SELECT count(*) INTO n FROM public.context_job_record_loops(ARRAY[a, b, c], asof) l
 WHERE (l.source_table = 'business_events' AND l.placement IS DISTINCT FROM 'on_job')
    OR (l.source_table NOT IN ('business_events', 'inbox_events') AND l.placement IS NOT NULL);
 IF n <> 0 THEN RAISE EXCEPTION 'record contract: a loop on a job message is on_job, a record loop has no placement'; END IF;
END $behave$;
ROLLBACK;
