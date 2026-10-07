-- Contract for 20261007010000_context_lead_cutoff: the owner's lead rule of 7 Oct 2026. A lead
-- still at quoted with no progress stops being followed up 28 days after the newer of its newest
-- quote send and the customer's newest text, email or call on the job, and comes back the moment it
-- progresses or the customer writes. Failing first: section 1 runs first and, like section 2, reads
-- only bodies that exist before this migration (the record loops and the story read; the judge,
-- the due list and the claim), and each fails on the earlier bodies (break-contract.sql puts them
-- back and expects section 1's first check to fail). The rule's own functions are read only after
-- section 1.
--  1. The story (fixed instant Wed 7 Oct 2026 10:00 Perth): R7 on a lead 29 days after its quote
--     ends "Lead not followed up since <day>: 4 weeks after the last quote or message with no
--     progress"; 27 days after is unchanged; the first line of a lead no longer followed up says so
--     in place of whose move and never that it is the customer's move (whose_move
--     not_followed_up, now.monitored false, now.not_followed_up_since its day), with the item still
--     open on it unless that is the quote waiting on the customer; a customer message on day 25
--     keeps it followed up; one on day 35 brings it back.
--  2. The ledger (instants relative to now, since the judge judges now): a lead no longer followed
--     up is blocked lead_not_monitored, never on the due list, and a claim answers not_due; a lead
--     inside its 4 weeks, or one the customer wrote on an hour ago, is due as before.
--  3. The rule, as of each instant: 27 and 29 days; day 25 and day 35 customer messages; accepted
--     after 40 days; a deposit (paid, voided, draft); a booking (standing, or only ghost, observer or
--     cancelled ones); never sent; the job row's quoted stamp when no quote document was sent; a
--     later status; ours, a supplier's and a message placed on no job never count; a missed call
--     counts; the newest of two sends; every live job when the ids are null.
--  4. Shape and access: plain SQL with no SET for the rule, the replaced bodies keep their flags,
--     grants and slice names first.
--  5. Re-applying changes nothing.
-- Every fixture row is synthetic and rolled back; user triggers are off for it, and the column
-- defaults that would stamp the wall clock are pinned inside each fixture transaction.

-- 1 and 3 share these fixtures (fixed instant 2026-10-07 02:00Z).
BEGIN;
SET LOCAL session_replication_role = replica;
ALTER TABLE public.business_events ALTER COLUMN context_captured_at SET DEFAULT '2026-07-01 00:00Z',
 ALTER COLUMN recorded_at SET DEFAULT '2026-07-01 00:00Z', ALTER COLUMN occurred_at SET DEFAULT '2026-07-01 00:00Z';
ALTER TABLE public.job_documents ALTER COLUMN created_at SET DEFAULT '2026-07-01 00:00Z';
ALTER TABLE public.xero_invoices ALTER COLUMN created_at SET DEFAULT '2026-07-01 00:00Z', ALTER COLUMN updated_at SET DEFAULT '2026-07-01 00:00Z';
ALTER TABLE public.job_assignments ALTER COLUMN created_at SET DEFAULT '2026-07-01 00:00Z';
ALTER TABLE public.jobs ALTER COLUMN created_at SET DEFAULT '2026-07-01 00:00Z', ALTER COLUMN updated_at SET DEFAULT '2026-07-01 00:00Z';

INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, client_email, ghl_contact_id, pricing_json, quoted_at, accepted_at,
  created_at, updated_at)
VALUES
 ('70000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000aa', 'SWF-97001', 'quoted', 'fencing', 'Lead One', NULL, 'ct7001', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 ('70000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000aa', 'SWF-97002', 'quoted', 'fencing', 'Lead Two', NULL, 'ct7002', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 ('70000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000aa', 'SWF-97003', 'quoted', 'fencing', 'Lead Three', NULL, 'ct7003', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 ('70000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-0000000000aa', 'SWF-97004', 'quoted', 'fencing', 'Lead Four', NULL, 'ct7004', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 ('70000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-0000000000aa', 'SWF-97005', 'quoted', 'fencing', 'Lead Five', 'lead5@example.test', 'ct7005', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 ('70000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-0000000000aa', 'SWF-97006', 'quoted', 'fencing', 'Lead Six', NULL, 'ct7006', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 ('70000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-0000000000aa', 'SWF-97007', 'quoted', 'fencing', 'Lead Seven', NULL, 'ct7007', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 ('70000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-0000000000aa', 'SWF-97008', 'quoted', 'fencing', 'Lead Eight', NULL, 'ct7008', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 ('70000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-0000000000aa', 'SWF-97009', 'quoted', 'fencing', 'Lead Nine', NULL, 'ct7009', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 ('70000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-0000000000aa', 'SWF-97010', 'quoted', 'fencing', 'Lead Ten', NULL, 'ct7010', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 ('70000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-0000000000aa', 'SWF-97011', 'quoted', 'fencing', 'Lead Eleven', NULL, 'ct7011', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 ('70000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-0000000000aa', 'SWF-97012', 'quoted', 'fencing', 'Lead Twelve', NULL, 'ct7012', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 ('70000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-0000000000aa', 'SWF-97013', 'quoted', 'fencing', 'Lead Thirteen', NULL, 'ct7013', '{}', '2026-09-07 02:00Z', NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 ('70000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-0000000000aa', 'SWF-97014', 'quoted', 'fencing', 'Lead Fourteen', NULL, 'ct7014', '{}', '2026-09-30 02:00Z', NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 ('70000000-0000-4000-8000-000000000015', '00000000-0000-4000-8000-0000000000aa', 'SWF-97015', 'accepted', 'fencing', 'Lead Fifteen', NULL, 'ct7015', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 ('70000000-0000-4000-8000-000000000016', '00000000-0000-4000-8000-0000000000aa', 'SWF-97016', 'quoted', 'fencing', 'Lead Sixteen', NULL, 'ct7016', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 ('70000000-0000-4000-8000-000000000017', '00000000-0000-4000-8000-0000000000aa', 'SWF-97017', 'quoted', 'fencing', 'Lead Seventeen', NULL, 'ct7017', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 ('70000000-0000-4000-8000-000000000018', '00000000-0000-4000-8000-0000000000aa', 'SWF-97018', 'quoted', 'fencing', 'Lead Eighteen', NULL, 'ct7018', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 ('70000000-0000-4000-8000-000000000019', '00000000-0000-4000-8000-0000000000aa', 'SWF-97019', 'cancelled', 'fencing', 'Lead Nineteen', NULL, 'ct7019', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 ('70000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-0000000000aa', 'SWF-97020', 'quoted', 'fencing', 'Lead Twenty', NULL, 'ct7020', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z');

INSERT INTO public.job_documents (id, job_id, type, quote_number, version, created_at, sent_at, viewed_at, accepted_at, declined_at, superseded_at)
VALUES
 -- 27 and 29 days after the quote
 ('70e00000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'quote', 'Q-7001', 1, '2026-09-10 01:00Z', '2026-09-10 02:00Z', NULL, NULL, NULL, NULL),
 ('70e00000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000002', 'quote', 'Q-7002', 1, '2026-09-08 01:00Z', '2026-09-08 02:00Z', NULL, NULL, NULL, NULL),
 -- 40 days: a customer text on day 25 (three), none (four), a customer email on day 35 (five)
 ('70e00000-0000-4000-8000-000000000003', '70000000-0000-4000-8000-000000000003', 'quote', 'Q-7003', 1, '2026-08-28 01:00Z', '2026-08-28 02:00Z', NULL, NULL, NULL, NULL),
 ('70e00000-0000-4000-8000-000000000004', '70000000-0000-4000-8000-000000000004', 'quote', 'Q-7004', 1, '2026-08-28 01:00Z', '2026-08-28 02:00Z', NULL, NULL, NULL, NULL),
 ('70e00000-0000-4000-8000-000000000005', '70000000-0000-4000-8000-000000000005', 'quote', 'Q-7005', 1, '2026-08-28 01:00Z', '2026-08-28 02:00Z', NULL, NULL, NULL, NULL),
 -- 50 days, accepted on day 40 (the job row still at quoted)
 ('70e00000-0000-4000-8000-000000000006', '70000000-0000-4000-8000-000000000006', 'quote', 'Q-7006', 1, '2026-08-18 01:00Z', '2026-08-18 02:00Z', '2026-08-19 01:00Z', '2026-09-27 02:00Z', NULL, NULL),
 -- 60 days: a deposit invoice (paid, voided, a draft), a booking (standing; only ghost, observer and cancelled)
 ('70e00000-0000-4000-8000-000000000007', '70000000-0000-4000-8000-000000000007', 'quote', 'Q-7007', 1, '2026-08-08 01:00Z', '2026-08-08 02:00Z', NULL, NULL, NULL, NULL),
 ('70e00000-0000-4000-8000-000000000008', '70000000-0000-4000-8000-000000000008', 'quote', 'Q-7008', 1, '2026-08-08 01:00Z', '2026-08-08 02:00Z', NULL, NULL, NULL, NULL),
 ('70e00000-0000-4000-8000-000000000009', '70000000-0000-4000-8000-000000000009', 'quote', 'Q-7009', 1, '2026-08-08 01:00Z', '2026-08-08 02:00Z', NULL, NULL, NULL, NULL),
 ('70e00000-0000-4000-8000-000000000010', '70000000-0000-4000-8000-000000000010', 'quote', 'Q-7010', 1, '2026-08-08 01:00Z', '2026-08-08 02:00Z', NULL, NULL, NULL, NULL),
 ('70e00000-0000-4000-8000-000000000011', '70000000-0000-4000-8000-000000000011', 'quote', 'Q-7011', 1, '2026-08-08 01:00Z', '2026-08-08 02:00Z', NULL, NULL, NULL, NULL),
 -- never sent (a draft quote document, no quoted stamp)
 ('70e00000-0000-4000-8000-000000000012', '70000000-0000-4000-8000-000000000012', 'quote', 'Q-7012', 1, '2026-07-02 01:00Z', NULL, NULL, NULL, NULL, NULL),
 -- not sent as a document, the job row's quoted stamp 7 days ago (fourteen; thirteen has no document)
 ('70e00000-0000-4000-8000-000000000014', '70000000-0000-4000-8000-000000000014', 'quote', 'Q-7014', 1, '2026-09-29 01:00Z', NULL, NULL, NULL, NULL, NULL),
 -- a later status
 ('70e00000-0000-4000-8000-000000000015', '70000000-0000-4000-8000-000000000015', 'quote', 'Q-7015', 1, '2026-08-08 01:00Z', '2026-08-08 02:00Z', NULL, NULL, NULL, NULL),
 -- 40 days: ours and a supplier's since (sixteen), the customer's text placed on no job (seventeen),
 -- the customer's missed call on the job (twenty)
 ('70e00000-0000-4000-8000-000000000016', '70000000-0000-4000-8000-000000000016', 'quote', 'Q-7016', 1, '2026-08-28 01:00Z', '2026-08-28 02:00Z', NULL, NULL, NULL, NULL),
 ('70e00000-0000-4000-8000-000000000017', '70000000-0000-4000-8000-000000000017', 'quote', 'Q-7017', 1, '2026-08-28 01:00Z', '2026-08-28 02:00Z', NULL, NULL, NULL, NULL),
 ('70e00000-0000-4000-8000-000000000020', '70000000-0000-4000-8000-000000000020', 'quote', 'Q-7020', 1, '2026-08-28 01:00Z', '2026-08-28 02:00Z', NULL, NULL, NULL, NULL),
 -- two sends: 60 days and 10 days
 ('70e00000-0000-4000-8000-000000000018', '70000000-0000-4000-8000-000000000018', 'quote', 'Q-7018', 1, '2026-08-08 01:00Z', '2026-08-08 02:00Z', NULL, NULL, NULL, '2026-09-27 01:00Z'),
 ('70e00000-0000-4000-8000-000000000118', '70000000-0000-4000-8000-000000000018', 'quote', 'Q-7018', 2, '2026-09-27 01:00Z', '2026-09-27 02:00Z', NULL, NULL, NULL, NULL),
 -- not live
 ('70e00000-0000-4000-8000-000000000019', '70000000-0000-4000-8000-000000000019', 'quote', 'Q-7019', 1, '2026-08-08 01:00Z', '2026-08-08 02:00Z', NULL, NULL, NULL, NULL);

INSERT INTO public.xero_invoices (id, org_id, xero_invoice_id, invoice_number, invoice_type, status, amount_due, amount_paid, fully_paid_on, job_id,
  due_date, total, invoice_date, reference, contact_name, created_at, updated_at, synced_at)
VALUES
 ('70f00000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-0000000000aa', 'x7007', 'INV-7007', 'ACCREC', 'PAID', 0, 500, '2026-09-08', '70000000-0000-4000-8000-000000000007',
  '2026-09-14', 500, '2026-09-07', 'SWF-97007-DEP', 'Lead Seven', '2026-09-07 02:00Z', '2026-09-08 02:00Z', '2026-09-08 02:00Z'),
 ('70f00000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-0000000000aa', 'x7008', 'INV-7008', 'ACCREC', 'VOIDED', 0, 0, NULL, '70000000-0000-4000-8000-000000000008',
  '2026-09-14', 500, '2026-09-07', 'SWF-97008-DEP', 'Lead Eight', '2026-09-07 02:00Z', '2026-09-08 02:00Z', '2026-09-08 02:00Z'),
 ('70f00000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-0000000000aa', 'x7009', 'INV-7009', 'ACCREC', 'DRAFT', 500, 0, NULL, '70000000-0000-4000-8000-000000000009',
  '2026-09-14', 500, '2026-09-07', 'SWF-97009-DEP', 'Lead Nine', '2026-09-07 02:00Z', '2026-09-08 02:00Z', '2026-09-08 02:00Z');

INSERT INTO public.job_assignments (id, job_id, role, scheduled_date, assignment_type, status, crew_name, is_ghost, created_at)
VALUES
 ('70a00000-0000-4000-8000-000000000010', '70000000-0000-4000-8000-000000000010', 'lead_installer', '2026-10-14', 'install', 'scheduled', 'Crew L', false, '2026-09-17 02:00Z'),
 ('70a00000-0000-4000-8000-000000000011', '70000000-0000-4000-8000-000000000011', 'lead_installer', '2026-10-14', 'install', 'scheduled', 'Crew L', true, '2026-09-17 02:00Z'),
 ('70a00000-0000-4000-8000-000000000111', '70000000-0000-4000-8000-000000000011', 'observer', '2026-10-14', 'install', 'scheduled', 'Crew L', false, '2026-09-17 02:00Z'),
 ('70a00000-0000-4000-8000-000000000211', '70000000-0000-4000-8000-000000000011', 'lead_installer', '2026-10-15', 'install', 'cancelled', 'Crew L', false, '2026-09-17 02:00Z');

INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  context_captured_at, attribution_status, attribution_confidence)
VALUES
 -- three: the customer's text on day 25 after the quote
 ('70b00000-0000-4000-8000-000000000003', '70000000-0000-4000-8000-000000000003', 'client.reply', 'ghl', 'sms', 'inbound', 'ct7003',
  '{"body":"Still thinking about the colour, will let you know"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-09-22 02:00Z', '2026-09-22 02:00Z', '2026-09-22 02:00Z', '2026-09-22 02:00Z', 'direct', 1),
 -- five: the customer's email on day 35 after the quote
 ('70b00000-0000-4000-8000-000000000005', '70000000-0000-4000-8000-000000000005', 'client.email_in', 'outlook-mail-capture', 'email', 'inbound', 'ct7005',
  '{"body":"We are ready to go ahead, what are the next steps?","from":"lead5@example.test","subject":"Fence quote"}',
  '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-10-02 02:00Z', '2026-10-02 02:00Z', '2026-10-02 02:00Z', '2026-10-02 02:00Z', 'direct', 1),
 -- twelve: the customer's text long before any quote went out (never sent: no clock)
 ('70b00000-0000-4000-8000-000000000012', '70000000-0000-4000-8000-000000000012', 'client.reply', 'ghl', 'sms', 'inbound', 'ct7012',
  '{"body":"Can you quote the side fence too?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-08-01 02:00Z', '2026-08-01 02:00Z', '2026-08-01 02:00Z', '2026-08-01 02:00Z', 'direct', 1),
 -- sixteen: our follow-up text and a supplier's email on the job since the quote: neither is the customer writing
 ('70b00000-0000-4000-8000-000000000016', '70000000-0000-4000-8000-000000000016', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ct7016',
  '{"body":"Just checking in on the quote"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff"}}',
  '2026-10-02 02:00Z', '2026-10-02 02:00Z', '2026-10-02 02:00Z', '2026-10-02 02:00Z', 'direct', 1),
 ('70b00000-0000-4000-8000-000000000116', '70000000-0000-4000-8000-000000000016', 'supplier.email_in', 'outlook-mail-capture', 'email', 'inbound', NULL,
  '{"body":"Colorbond stock is back in","from":"orders@supplier.example.test","subject":"Stock"}',
  '{"party_roles":{"counterpart_role":"supplier","sender_role":"supplier"}}',
  '2026-10-04 02:00Z', '2026-10-04 02:00Z', '2026-10-04 02:00Z', '2026-10-04 02:00Z', 'direct', 1),
 -- seventeen: the customer's text 2 days ago, placed on no job: not on the job, so it never counts
 ('70b00000-0000-4000-8000-000000000017', NULL, 'client.reply', 'ghl', 'sms', 'inbound', 'ct7017',
  '{"body":"Is the price still the same?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-10-05 02:00Z', '2026-10-05 02:00Z', '2026-10-05 02:00Z', '2026-10-05 02:00Z', NULL, NULL),
 -- twenty: the customer's missed call on the job 3 days ago
 ('70b00000-0000-4000-8000-000000000020', '70000000-0000-4000-8000-000000000020', 'client.call_logged', 'ghl', 'call', 'inbound', 'ct7020',
  '{"body":"Call. Provider status: no-answer. Duration: 0 seconds","call_status":"no-answer"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-10-04 02:00Z', '2026-10-04 02:00Z', '2026-10-04 02:00Z', '2026-10-04 02:00Z', 'direct', 1);

-- 1. The story.
DO $story$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; r record; s jsonb; j uuid;
BEGIN
 -- 29 days after the quote with no progress: R7 ends with the lead words (fails on the earlier bodies)
 SELECT * INTO r FROM public.context_job_record_loops(ARRAY['70000000-0000-4000-8000-000000000002'::uuid], asof) l WHERE l.rule = 'R7_quote_waiting';
 IF r.what IS DISTINCT FROM 'Quote Q-7002 v1 sent Tue 8 Sep 2026 (29 days), not viewed; no answer and no customer message since. '
                            || 'Lead not followed up since Tue 6 Oct 2026: 4 weeks after the last quote or message with no progress'
    OR r.shown_as IS DISTINCT FROM 'loop' OR r.owner IS DISTINCT FROM 'customer'
    OR r.why NOT LIKE '%; the lead is no longer followed up: no acceptance, customer invoice, booking or later status in the 4 weeks after %' THEN
  RAISE EXCEPTION 'lead cutoff contract: R7 of a lead 29 days after its quote ends with the lead words: %', row_to_json(r);
 END IF;
 -- ... and its first line says so in place of whose move, never the customer's move
 s := public.context_job_story('70000000-0000-4000-8000-000000000002', asof);
 IF s->'now'->>'line' IS DISTINCT FROM 'Quoted since Tue 8 Sep. Lead not followed up since Tue 6 Oct: 4 weeks after the last quote or message with no progress.'
    OR s->'now'->>'whose_move' IS DISTINCT FROM 'not_followed_up' OR s->'now'->'monitored' IS DISTINCT FROM 'false'::jsonb
    OR s->'now'->>'not_followed_up_since' IS DISTINCT FROM '2026-10-06' THEN
  RAISE EXCEPTION 'lead cutoff contract: the first line of a lead no longer followed up says so, never the customer''s move: %', s->'now';
 END IF;
 -- 27 days after: unchanged, the quote waits on the customer
 SELECT * INTO r FROM public.context_job_record_loops(ARRAY['70000000-0000-4000-8000-000000000001'::uuid], asof) l WHERE l.rule = 'R7_quote_waiting';
 IF r.what IS DISTINCT FROM 'Quote Q-7001 v1 sent Thu 10 Sep 2026 (27 days), not viewed; no answer and no customer message since'
    OR r.owner IS DISTINCT FROM 'customer' OR r.why LIKE '%no longer followed up%' THEN
  RAISE EXCEPTION 'lead cutoff contract: R7 of a lead 27 days after its quote is unchanged: %', row_to_json(r);
 END IF;
 s := public.context_job_story('70000000-0000-4000-8000-000000000001', asof);
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'customer' OR s->'now'->'monitored' IS DISTINCT FROM 'true'::jsonb
    OR s->'now'->'not_followed_up_since' IS DISTINCT FROM 'null'::jsonb OR s->'now'->>'line' LIKE '%Lead not followed up%'
    OR position('The customer''s move, waiting on the customer: Quote Q-7001 v1 sent Thu 10 Sep 2026 (27 days), not viewed; no answer and no customer message since'
                IN s->'now'->>'line') = 0 THEN
  RAISE EXCEPTION 'lead cutoff contract: a lead inside its 4 weeks still waits on the customer: %', s->'now';
 END IF;
 -- 40 days, no message: the line names the day the 4 weeks ran out
 s := public.context_job_story('70000000-0000-4000-8000-000000000004', asof);
 IF s->'now'->>'line' IS DISTINCT FROM 'Quoted since Fri 28 Aug. Lead not followed up since Fri 25 Sep: 4 weeks after the last quote or message with no progress.' THEN
  RAISE EXCEPTION 'lead cutoff contract: 4 weeks after the quote with nothing since: %', s->'now';
 END IF;
 -- a quote sent only by the job row's stamp: no R7, the line still says so
 s := public.context_job_story('70000000-0000-4000-8000-000000000013', asof);
 IF s->'now'->>'line' IS DISTINCT FROM 'Quoted. Lead not followed up since Mon 5 Oct: 4 weeks after the last quote or message with no progress.'
    OR s->'now'->>'whose_move' IS DISTINCT FROM 'not_followed_up' THEN
  RAISE EXCEPTION 'lead cutoff contract: a lead quoted by the job row''s stamp alone: %', s->'now';
 END IF;
 -- the customer in touch since by a text placed on no job (R7 owner unknown): the item still open is
 -- named after the lead words, without the lead words twice
 s := public.context_job_story('70000000-0000-4000-8000-000000000017', asof);
 IF s->'now'->>'line' IS DISTINCT FROM 'Quoted since Fri 28 Aug. Lead not followed up since Fri 25 Sep: 4 weeks after the last quote or message with no progress; '
                                        || 'open: Quote Q-7017 v1 sent Fri 28 Aug 2026 (40 days), not viewed; no answer recorded, but the customer was in touch since: '
                                        || 'a text Mon 5 Oct 2026 (not placed on any job).' THEN
  RAISE EXCEPTION 'lead cutoff contract: the item still open is named once, after the lead words: %', s->'now';
 END IF;
 -- never the customer's move, on every lead no longer followed up
 FOREACH j IN ARRAY ARRAY['70000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000004', '70000000-0000-4000-8000-000000000008',
   '70000000-0000-4000-8000-000000000011', '70000000-0000-4000-8000-000000000013', '70000000-0000-4000-8000-000000000016',
   '70000000-0000-4000-8000-000000000017']::uuid[] LOOP
  s := public.context_job_story(j, asof);
  IF s->'now'->>'whose_move' IS DISTINCT FROM 'not_followed_up' OR s->'now'->>'line' LIKE '%customer''s move%'
     OR s->'now'->>'line' LIKE '%waiting on the customer%' OR position('Lead not followed up since ' IN s->'now'->>'line') = 0 THEN
   RAISE EXCEPTION 'lead cutoff contract: job % is no longer followed up, never the customer''s move: %', j, s->'now';
  END IF;
 END LOOP;
 -- a customer message on day 25 keeps it followed up
 s := public.context_job_story('70000000-0000-4000-8000-000000000003', asof);
 IF s->'now'->>'whose_move' = 'not_followed_up' OR s->'now'->'monitored' IS DISTINCT FROM 'true'::jsonb OR s->'now'->>'line' LIKE '%Lead not followed up%' THEN
  RAISE EXCEPTION 'lead cutoff contract: a customer message on day 25 keeps the lead followed up: %', s->'now';
 END IF;
 -- the customer's email on day 35 brings it back: not followed up the day before, followed up from then
 s := public.context_job_story('70000000-0000-4000-8000-000000000005', '2026-10-01 02:00Z');
 IF s->'now'->>'whose_move' IS DISTINCT FROM 'not_followed_up'
    OR s->'now'->>'line' NOT LIKE 'Quoted since Fri 28 Aug. Lead not followed up since Fri 25 Sep: 4 weeks after the last quote or message with no progress%' THEN
  RAISE EXCEPTION 'lead cutoff contract: before the customer wrote on day 35 the lead was not followed up: %', s->'now';
 END IF;
 s := public.context_job_story('70000000-0000-4000-8000-000000000005', asof);
 IF s->'now'->>'whose_move' = 'not_followed_up' OR s->'now'->'monitored' IS DISTINCT FROM 'true'::jsonb OR s->'now'->>'line' LIKE '%Lead not followed up%' THEN
  RAISE EXCEPTION 'lead cutoff contract: the customer writing brings the lead back: %', s->'now';
 END IF;
 -- accepted on day 40 (the job row still at quoted): followed up again
 s := public.context_job_story('70000000-0000-4000-8000-000000000006', asof);
 IF s->'now'->>'whose_move' = 'not_followed_up' OR s->'now'->'monitored' IS DISTINCT FROM 'true'::jsonb THEN
  RAISE EXCEPTION 'lead cutoff contract: an accepted quote is progress: %', s->'now';
 END IF;
 -- the pure assembler with no lead passed in reads the job as followed up
 s := public.context_job_story_assemble('{"id":"x","status":"quoted","type":"fencing","created_at":"2026-08-01T00:00:00Z"}', '{}'::jsonb, NULL, NULL, asof, NULL);
 IF s->'now'->'monitored' IS DISTINCT FROM 'true'::jsonb OR s->'now'->>'whose_move' = 'not_followed_up' THEN
  RAISE EXCEPTION 'lead cutoff contract: with no lead passed in the job is followed up: %', s->'now';
 END IF;
END $story$;

-- 3. The rule, as of each instant.
DO $rule$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; got text; want text;
BEGIN
 SELECT string_agg(concat_ws(' ', m.job_number, m.monitored::text, m.state, to_char(m.quote_sent_at AT TIME ZONE 'UTC', 'MM-DD HH24:MI'),
                             to_char(m.customer_at AT TIME ZONE 'UTC', 'MM-DD HH24:MI'), to_char(m.cutoff_at AT TIME ZONE 'UTC', 'MM-DD HH24:MI')),
                   E'\n' ORDER BY m.job_number COLLATE "C") INTO got
 FROM public.context_lead_monitored_jobs(ARRAY(SELECT jb.id FROM public.jobs jb WHERE jb.job_number LIKE 'SWF-970%'), asof) m;
 want := concat_ws(E'\n',
  'SWF-97001 true within_4_weeks 09-10 02:00 10-08 02:00',
  'SWF-97002 false not_followed_up 09-08 02:00 10-06 02:00',
  'SWF-97003 true within_4_weeks 08-28 02:00 09-22 02:00 10-20 02:00',
  'SWF-97004 false not_followed_up 08-28 02:00 09-25 02:00',
  'SWF-97005 true within_4_weeks 08-28 02:00 10-02 02:00 10-30 02:00',
  'SWF-97006 true accepted 08-18 02:00',
  'SWF-97007 true invoiced 08-08 02:00',
  'SWF-97008 false not_followed_up 08-08 02:00 09-05 02:00',
  'SWF-97009 true invoiced 08-08 02:00',
  'SWF-97010 true booked 08-08 02:00',
  'SWF-97011 false not_followed_up 08-08 02:00 09-05 02:00',
  'SWF-97012 true quote_not_sent',
  'SWF-97013 false not_followed_up 09-07 02:00 10-05 02:00',
  'SWF-97014 true within_4_weeks 09-30 02:00 10-28 02:00',
  'SWF-97015 true not_quoted 08-08 02:00',
  'SWF-97016 false not_followed_up 08-28 02:00 09-25 02:00',
  'SWF-97017 false not_followed_up 08-28 02:00 09-25 02:00',
  'SWF-97018 true within_4_weeks 09-27 02:00 10-25 02:00',
  'SWF-97019 true not_quoted 08-08 02:00',
  'SWF-97020 true within_4_weeks 08-28 02:00 10-04 02:00 11-01 02:00');
 IF got IS DISTINCT FROM want THEN
  RAISE EXCEPTION 'lead cutoff contract: the rule as of Wed 7 Oct 2026 10:00 Perth:% got% want%', E'\n', E'\n' || got || E'\n', E'\n' || want;
 END IF;
 -- as of other instants: the day before the 4 weeks run out and the instant they do; day 24, before
 -- the day 25 message; before and at the day 35 email; before and at the acceptance on day 40;
 -- before the deposit and the booking were made
 SELECT string_agg(concat_ws(' ', x.n, m.monitored::text, m.state), ', ' ORDER BY x.o) INTO got
 FROM (VALUES (1, 'SWF-97004', '2026-09-25 01:59:59Z'::timestamptz), (2, 'SWF-97004', '2026-09-25 02:00Z'), (3, 'SWF-97003', '2026-09-21 02:00Z'),
              (4, 'SWF-97005', '2026-10-01 02:00Z'), (5, 'SWF-97005', '2026-10-02 02:00Z'), (6, 'SWF-97006', '2026-09-22 02:00Z'),
              (7, 'SWF-97006', '2026-09-27 02:00Z'), (8, 'SWF-97007', '2026-09-06 02:00Z'), (9, 'SWF-97010', '2026-09-16 02:00Z'),
              (10, 'SWF-97018', '2026-09-20 02:00Z')) x(o, n, at)
 JOIN public.jobs jb ON jb.job_number = x.n
 CROSS JOIN LATERAL public.context_lead_monitored_jobs(ARRAY[jb.id], x.at) m;
 want := 'SWF-97004 true within_4_weeks, SWF-97004 false not_followed_up, SWF-97003 true within_4_weeks, SWF-97005 false not_followed_up, '
         || 'SWF-97005 true within_4_weeks, SWF-97006 false not_followed_up, SWF-97006 true accepted, SWF-97007 false not_followed_up, '
         || 'SWF-97010 false not_followed_up, SWF-97018 false not_followed_up';
 IF got IS DISTINCT FROM want THEN
  RAISE EXCEPTION 'lead cutoff contract: the rule as of earlier instants: got % want %', got, want;
 END IF;
 -- every live job when the ids are null (never the cancelled one); the boolean form; an unknown job
 IF (SELECT count(*) FROM public.context_lead_monitored_jobs(NULL, asof) m WHERE m.job_number LIKE 'SWF-970%') <> 19
    OR EXISTS (SELECT 1 FROM public.context_lead_monitored_jobs(NULL, asof) m WHERE m.job_number = 'SWF-97019')
    OR (SELECT count(*) FROM public.context_lead_monitored_jobs(NULL, asof) m WHERE m.job_number LIKE 'SWF-970%' AND NOT m.monitored) <> 7 THEN
  RAISE EXCEPTION 'lead cutoff contract: with no ids the rule reads every live job';
 END IF;
 IF public.context_lead_monitored('70000000-0000-4000-8000-000000000002', asof) IS DISTINCT FROM false
    OR public.context_lead_monitored('70000000-0000-4000-8000-000000000001', asof) IS DISTINCT FROM true
    OR public.context_lead_monitored(gen_random_uuid(), asof) IS NOT NULL OR public.context_lead_monitored(NULL, asof) IS NOT NULL
    OR (SELECT count(*) FROM public.context_lead_monitored_jobs(ARRAY['70000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000002']::uuid[], asof)) <> 1 THEN
  RAISE EXCEPTION 'lead cutoff contract: the one-job form is the rule''s monitored, null for an unknown job, and a job is listed once';
 END IF;
END $rule$;
ROLLBACK;

-- 2. The ledger. The judge judges now, so these fixtures are placed relative to now (the same
-- whatever day the suite runs); the ledger is in shadow for these three jobs only, the backfill
-- hours open all day.
BEGIN;
SET LOCAL session_replication_role = replica;
ALTER TABLE public.business_events ALTER COLUMN context_captured_at SET DEFAULT now() - interval '90 days',
 ALTER COLUMN recorded_at SET DEFAULT now() - interval '90 days';
UPDATE public.context_ledger_settings SET mode = 'shadow', backfill_from_hour = NULL, backfill_to_hour = NULL,
 job_ids = ARRAY['70000000-0000-4000-8000-000000000101', '70000000-0000-4000-8000-000000000102', '70000000-0000-4000-8000-000000000103']::uuid[]
WHERE id;
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, ghl_contact_id, pricing_json, created_at, updated_at)
VALUES ('70000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-0000000000aa', 'SWF-97101', 'quoted', 'fencing', 'Lead A', 'ct7101', '{}', now() - interval '60 days', now() - interval '60 days'),
       ('70000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-0000000000aa', 'SWF-97102', 'quoted', 'fencing', 'Lead B', 'ct7102', '{}', now() - interval '60 days', now() - interval '60 days'),
       ('70000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-0000000000aa', 'SWF-97103', 'quoted', 'fencing', 'Lead C', 'ct7103', '{}', now() - interval '60 days', now() - interval '60 days');
INSERT INTO public.job_documents (id, job_id, type, quote_number, version, created_at, sent_at)
VALUES ('70e00000-0000-4000-8000-000000000101', '70000000-0000-4000-8000-000000000101', 'quote', 'Q-7101', 1, now() - interval '41 days', now() - interval '40 days'),
       ('70e00000-0000-4000-8000-000000000102', '70000000-0000-4000-8000-000000000102', 'quote', 'Q-7102', 1, now() - interval '6 days', now() - interval '5 days'),
       ('70e00000-0000-4000-8000-000000000103', '70000000-0000-4000-8000-000000000103', 'quote', 'Q-7103', 1, now() - interval '41 days', now() - interval '40 days');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  context_captured_at, attribution_status, attribution_confidence)
SELECT x.id::uuid, x.job::uuid, 'client.reply', 'ghl', 'sms', 'inbound', x.ct, jsonb_build_object('body', x.body),
       '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}', now() - x.ago, now() - x.ago, now() - x.ago, now() - x.ago, 'direct', 1
FROM (VALUES ('70b00000-0000-4000-8000-000000000101', '70000000-0000-4000-8000-000000000101', 'ct7101', 'Thanks, we will think about it', interval '39 days'),
             ('70b00000-0000-4000-8000-000000000102', '70000000-0000-4000-8000-000000000102', 'ct7102', 'Thanks, we will think about it', interval '4 days'),
             ('70b00000-0000-4000-8000-000000000103', '70000000-0000-4000-8000-000000000103', 'ct7103', 'Thanks, we will think about it', interval '39 days'),
             ('70b00000-0000-4000-8000-000000000203', '70000000-0000-4000-8000-000000000103', 'ct7103', 'Can we start in November?', interval '1 hour')) x(id, job, ct, body, ago);
DO $ledger$
DECLARE r record; c jsonb; due text;
BEGIN
 -- a lead no longer followed up is never due a read (fails on the earlier judge: never_read, due)
 SELECT * INTO r FROM public.context_ledger_judge(ARRAY['70000000-0000-4000-8000-000000000101'::uuid]) d;
 IF r.due OR r.blocked_reason IS DISTINCT FROM 'lead_not_monitored' OR r.evidence_rows <> 1 THEN
  RAISE EXCEPTION 'lead cutoff contract: a lead no longer followed up is blocked lead_not_monitored: %', row_to_json(r);
 END IF;
 -- a lead inside its 4 weeks, and one the customer wrote on an hour ago, are judged as before
 FOR r IN SELECT * FROM public.context_ledger_judge(ARRAY['70000000-0000-4000-8000-000000000102', '70000000-0000-4000-8000-000000000103']::uuid[]) LOOP
  IF NOT r.due OR r.kind IS DISTINCT FROM 'backfill' OR r.reason IS DISTINCT FROM 'never_read' OR r.blocked_reason IS NOT NULL THEN
   RAISE EXCEPTION 'lead cutoff contract: a lead still followed up is due a read as before: %', row_to_json(r);
  END IF;
 END LOOP;
 -- the due list never lists it
 SELECT string_agg(jb.job_number, ',' ORDER BY jb.job_number COLLATE "C") INTO due
 FROM public.context_ledger_due(200) d JOIN public.jobs jb ON jb.id = d.job_id;
 IF due IS DISTINCT FROM 'SWF-97102,SWF-97103' THEN
  RAISE EXCEPTION 'lead cutoff contract: the due list holds only the leads still followed up: %', due;
 END IF;
 -- and a claim answers not_due, naming why
 c := public.context_ledger_claim('70000000-0000-4000-8000-000000000101', 'backfill', (now() AT TIME ZONE 'Australia/Perth')::date);
 IF c ->> 'outcome' IS DISTINCT FROM 'not_due' OR c ->> 'reason' IS DISTINCT FROM 'lead_not_monitored'
    OR EXISTS (SELECT 1 FROM public.context_extraction_runs x WHERE x.job_id = '70000000-0000-4000-8000-000000000101' AND x.phase = 'ledger') THEN
  RAISE EXCEPTION 'lead cutoff contract: a claim of a lead no longer followed up answers not_due and opens no run: %', c;
 END IF;
END $ledger$;
ROLLBACK;

-- 4. Shape and access.
DO $shape$
DECLARE x record; p record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
   ('public.context_lead_monitored_jobs(uuid[],timestamptz)', false, 'Lead cutoff (20261007010000): %'),
   ('public.context_lead_monitored(uuid,timestamptz)', false, 'Lead cutoff (20261007010000): %'),
   ('public.context_job_record_loops(uuid[],timestamptz)', true,
    'Job record (20261006011000), story fixes (20261006033000), story safety (20261006040000): (lead cutoff, 20261007010000) %'),
   ('public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)', true, 'Job story (20261006014000), lead cutoff (20261007010000): %'),
   ('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)', false,
    'Job story (20261006014000), story fixes (20261006033000), story safety (20261006040000): (lead cutoff, 20261007010000) %'),
   ('public.context_ledger_judge(uuid[])', true, 'Context ledger store (20261006013000), story safety (20261006040000): (lead cutoff, 20261007010000) %')
 ) v(sig, definer, cmt) LOOP
  SELECT pr.prosecdef, pr.provolatile, pr.proconfig, pr.prolang INTO p FROM pg_proc pr WHERE pr.oid = to_regprocedure(x.sig);
  IF p IS NULL THEN RAISE EXCEPTION 'lead cutoff contract: % missing', x.sig; END IF;
  IF p.prosecdef IS DISTINCT FROM x.definer OR p.provolatile <> 's' OR p.prolang <> (SELECT l.oid FROM pg_language l WHERE l.lanname = 'sql')
     OR (x.definer AND p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']) OR (NOT x.definer AND p.proconfig IS NOT NULL) THEN
   RAISE EXCEPTION 'lead cutoff contract: % flags (definer %, volatility %, config %)', x.sig, p.prosecdef, p.provolatile, p.proconfig;
  END IF;
  IF has_function_privilege('anon', x.sig, 'EXECUTE') OR has_function_privilege('authenticated', x.sig, 'EXECUTE')
     OR NOT has_function_privilege('service_role', x.sig, 'EXECUTE') THEN
   RAISE EXCEPTION 'lead cutoff contract: % access wrong', x.sig;
  END IF;
  IF coalesce(obj_description(to_regprocedure(x.sig), 'pg_proc'), '') NOT LIKE x.cmt THEN
   RAISE EXCEPTION 'lead cutoff contract: % comment must keep its slice names first and name the lead cutoff', x.sig;
  END IF;
 END LOOP;
 IF pg_get_function_result('public.context_lead_monitored_jobs(uuid[],timestamptz)'::regprocedure)
    IS DISTINCT FROM 'TABLE(job_id uuid, job_number text, monitored boolean, state text, quote_sent_at timestamp with time zone, customer_at timestamp with time zone, cutoff_at timestamp with time zone)'
    OR pg_get_function_result('public.context_lead_monitored(uuid,timestamptz)'::regprocedure) IS DISTINCT FROM 'boolean' THEN
  RAISE EXCEPTION 'lead cutoff contract: the rule''s columns changed';
 END IF;
END $shape$;

-- 5. Re-applying the migration changes nothing (its guard accepts its own bodies).
BEGIN;
CREATE TEMP TABLE lead_cutoff_md5 AS
 SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS m, obj_description(p.oid, 'pg_proc') AS c FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('context_lead_monitored_jobs', 'context_lead_monitored', 'context_job_record_loops',
  'context_job_story', 'context_job_story_assemble', 'context_ledger_judge');
\ir ../../../migrations/20261007010000_context_lead_cutoff.sql
DO $again$
BEGIN
 IF (SELECT count(*) FROM lead_cutoff_md5) <> 6 OR EXISTS (SELECT 1 FROM lead_cutoff_md5 x JOIN pg_proc p ON p.oid = x.sig::regprocedure
       WHERE md5(p.prosrc) IS DISTINCT FROM x.m OR obj_description(p.oid, 'pg_proc') IS DISTINCT FROM x.c) THEN
  RAISE EXCEPTION 'lead cutoff contract: a re-apply must change nothing';
 END IF;
END $again$;
ROLLBACK;
