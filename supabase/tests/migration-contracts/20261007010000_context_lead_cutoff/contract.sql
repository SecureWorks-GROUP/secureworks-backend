-- Contract for 20261007010000_context_lead_cutoff: the owner's lead rule of 7 Oct 2026. A lead
-- still at quoted with no progress stops being followed up 28 days after the newer of its newest
-- quote send and the customer's newest text, email or call, wherever it is placed, and comes back
-- the moment it progresses or the customer writes. Failing first: section 1 runs first and, like
-- section 2, reads only bodies that exist before this migration (the record loops and the story
-- read; the judge, the due list and the claim), and each fails on the earlier bodies
-- (break-contract.sql puts them back and expects section 1's first check to fail). The rule's own
-- functions are read only after section 1.
--  1. The story (fixed instant Wed 7 Oct 2026 10:00 Perth): R7 on a lead 29 days after its quote
--     ends "Lead not followed up since <day>: 4 weeks after the last quote or message with no
--     progress"; 27 days after is unchanged; the first line of a lead no longer followed up says so
--     in place of whose move and never that it is the customer's move (whose_move
--     not_followed_up, now.monitored false, now.not_followed_up_since its day), with the item still
--     open on it unless that is the quote waiting on the customer; a customer message on day 25
--     keeps it followed up; one on day 35 brings it back; a paid supplier bill keeps it followed up;
--     the customer in touch off the job in the 4 weeks (an answered call or a text placed on no job,
--     a text in the placement queue, mail withheld because they have another job, mail from their
--     address with no CRM contact, old-inbox mail placed on no job, a text on their other job) keeps
--     it followed up and the line names that contact, never "Lead not followed up"; and the rule's
--     customer_at is never older than a customer message the story names.
--  2. The ledger (instants relative to now, since the judge judges now): a lead no longer followed
--     up is blocked lead_not_monitored, never on the due list, and a claim answers not_due; a lead
--     inside its 4 weeks, one the customer wrote on an hour ago, one the customer texted off the job
--     two hours ago and one with a paid supplier bill are due as before.
--  3. The rule, as of each instant: 27 and 29 days; day 25 and day 35 customer messages; accepted
--     after 40 days; a deposit (paid, voided, draft); a supplier bill (paid; voided, beside a deleted
--     customer invoice); a booking (standing, or only ghost, observer or cancelled ones); never sent;
--     the job row's quoted stamp when no quote document was sent; a later status; ours and a
--     supplier's never count; the customer's messages off the job count (each kind above, and one
--     older than 4 weeks starts the clock); a missed call counts; the newest of two sends; every
--     live job when the ids are null; the one-job form is the same row, and the shape the other
--     readers detect (a set of job_id and monitored) answers as the set form does.
--  4. Shape and access: both rule functions are SECURITY DEFINER with search_path public, pg_temp
--     (the loops and the judge are), service role only; the replaced bodies keep their flags, grants
--     and slice names first.
--  5. Re-applying changes nothing.
--  6. The service role reads the rule directly with a lead in the set, in a fresh session with the
--     table grants production has, while the record layer's ladder helper stays revoked from it.
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
ALTER TABLE public.inbox_events ALTER COLUMN received_at SET DEFAULT '2026-07-01 00:00Z';

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
 ('70000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-0000000000aa', 'SWF-97020', 'quoted', 'fencing', 'Lead Twenty', NULL, 'ct7020', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 -- a supplier bill paid (twenty-one); a supplier bill voided beside a customer invoice deleted (twenty-two)
 ('70000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-0000000000aa', 'SWF-97021', 'quoted', 'fencing', 'Lead Twenty-One', NULL, 'ct7021', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 ('70000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-0000000000aa', 'SWF-97022', 'quoted', 'fencing', 'Lead Twenty-Two', NULL, 'ct7022', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 -- the customer in touch off the job: an answered call placed on no job (twenty-three), a text in the
 -- placement queue (twenty-four), mail withheld because they have another job (twenty-five, whose
 -- other job is twenty-six), mail from their address with no CRM contact placed on no job
 -- (twenty-seven), a text on their other job (twenty-eight, whose other job is twenty-nine), old-inbox
 -- mail from their address placed on no job (thirty), and a text placed on no job 5 weeks ago (thirty-one)
 ('70000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-0000000000aa', 'SWF-97023', 'quoted', 'fencing', 'Lead Twenty-Three', NULL, 'ct7023', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 ('70000000-0000-4000-8000-000000000024', '00000000-0000-4000-8000-0000000000aa', 'SWF-97024', 'quoted', 'fencing', 'Lead Twenty-Four', NULL, 'ct7024', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 ('70000000-0000-4000-8000-000000000025', '00000000-0000-4000-8000-0000000000aa', 'SWF-97025', 'quoted', 'fencing', 'Lead Twenty-Five', 'lead25@example.test', 'ct7025', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 ('70000000-0000-4000-8000-000000000026', '00000000-0000-4000-8000-0000000000aa', 'SWF-97026', 'complete', 'fencing', 'Lead Twenty-Five', 'lead25@example.test', 'ct7026', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 ('70000000-0000-4000-8000-000000000027', '00000000-0000-4000-8000-0000000000aa', 'SWF-97027', 'quoted', 'fencing', 'Lead Twenty-Seven', 'lead27@example.test', 'ct7027', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 ('70000000-0000-4000-8000-000000000028', '00000000-0000-4000-8000-0000000000aa', 'SWF-97028', 'quoted', 'fencing', 'Lead Twenty-Eight', NULL, 'ct7028', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 ('70000000-0000-4000-8000-000000000029', '00000000-0000-4000-8000-0000000000aa', 'SWF-97029', 'accepted', 'patio', 'Lead Twenty-Eight', NULL, 'ct7028', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 ('70000000-0000-4000-8000-000000000030', '00000000-0000-4000-8000-0000000000aa', 'SWF-97030', 'quoted', 'fencing', 'Lead Thirty', 'lead30@example.test', 'ct7030', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 ('70000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-0000000000aa', 'SWF-97031', 'quoted', 'fencing', 'Lead Thirty-One', NULL, 'ct7031', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 -- thirty-two: the client's address is our own mailbox (SWP-26634's shape), shared with a finished job
 -- (thirty-three): our mail from it is never the customer's
 ('70000000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-0000000000aa', 'SWF-97032', 'quoted', 'fencing', 'Lead Thirty-Two', 'office@secureworkswa.com.au', 'ct7032', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
 ('70000000-0000-4000-8000-000000000033', '00000000-0000-4000-8000-0000000000aa', 'SWF-97033', 'complete', 'fencing', 'Lead Thirty-Three', 'office@secureworkswa.com.au', 'ct7033', '{}', NULL, NULL, '2026-07-01 00:00Z', '2026-07-01 00:00Z');

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
 ('70e00000-0000-4000-8000-000000000019', '70000000-0000-4000-8000-000000000019', 'quote', 'Q-7019', 1, '2026-08-08 01:00Z', '2026-08-08 02:00Z', NULL, NULL, NULL, NULL),
 -- 60 days: twenty-one to twenty-five, twenty-seven, twenty-eight, thirty and thirty-one
 ('70e00000-0000-4000-8000-000000000021', '70000000-0000-4000-8000-000000000021', 'quote', 'Q-7021', 1, '2026-08-08 01:00Z', '2026-08-08 02:00Z', NULL, NULL, NULL, NULL),
 ('70e00000-0000-4000-8000-000000000022', '70000000-0000-4000-8000-000000000022', 'quote', 'Q-7022', 1, '2026-08-08 01:00Z', '2026-08-08 02:00Z', NULL, NULL, NULL, NULL),
 ('70e00000-0000-4000-8000-000000000023', '70000000-0000-4000-8000-000000000023', 'quote', 'Q-7023', 1, '2026-08-08 01:00Z', '2026-08-08 02:00Z', NULL, NULL, NULL, NULL),
 ('70e00000-0000-4000-8000-000000000024', '70000000-0000-4000-8000-000000000024', 'quote', 'Q-7024', 1, '2026-08-08 01:00Z', '2026-08-08 02:00Z', NULL, NULL, NULL, NULL),
 ('70e00000-0000-4000-8000-000000000025', '70000000-0000-4000-8000-000000000025', 'quote', 'Q-7025', 1, '2026-08-08 01:00Z', '2026-08-08 02:00Z', NULL, NULL, NULL, NULL),
 ('70e00000-0000-4000-8000-000000000027', '70000000-0000-4000-8000-000000000027', 'quote', 'Q-7027', 1, '2026-08-08 01:00Z', '2026-08-08 02:00Z', NULL, NULL, NULL, NULL),
 ('70e00000-0000-4000-8000-000000000028', '70000000-0000-4000-8000-000000000028', 'quote', 'Q-7028', 1, '2026-08-08 01:00Z', '2026-08-08 02:00Z', NULL, NULL, NULL, NULL),
 ('70e00000-0000-4000-8000-000000000030', '70000000-0000-4000-8000-000000000030', 'quote', 'Q-7030', 1, '2026-08-08 01:00Z', '2026-08-08 02:00Z', NULL, NULL, NULL, NULL),
 ('70e00000-0000-4000-8000-000000000031', '70000000-0000-4000-8000-000000000031', 'quote', 'Q-7031', 1, '2026-08-08 01:00Z', '2026-08-08 02:00Z', NULL, NULL, NULL, NULL),
 ('70e00000-0000-4000-8000-000000000032', '70000000-0000-4000-8000-000000000032', 'quote', 'Q-7032', 1, '2026-08-08 01:00Z', '2026-08-08 02:00Z', NULL, NULL, NULL, NULL);

INSERT INTO public.xero_invoices (id, org_id, xero_invoice_id, invoice_number, invoice_type, status, amount_due, amount_paid, fully_paid_on, job_id,
  due_date, total, invoice_date, reference, contact_name, created_at, updated_at, synced_at)
VALUES
 ('70f00000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-0000000000aa', 'x7007', 'INV-7007', 'ACCREC', 'PAID', 0, 500, '2026-09-08', '70000000-0000-4000-8000-000000000007',
  '2026-09-14', 500, '2026-09-07', 'SWF-97007-DEP', 'Lead Seven', '2026-09-07 02:00Z', '2026-09-08 02:00Z', '2026-09-08 02:00Z'),
 ('70f00000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-0000000000aa', 'x7008', 'INV-7008', 'ACCREC', 'VOIDED', 0, 0, NULL, '70000000-0000-4000-8000-000000000008',
  '2026-09-14', 500, '2026-09-07', 'SWF-97008-DEP', 'Lead Eight', '2026-09-07 02:00Z', '2026-09-08 02:00Z', '2026-09-08 02:00Z'),
 ('70f00000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-0000000000aa', 'x7009', 'INV-7009', 'ACCREC', 'DRAFT', 500, 0, NULL, '70000000-0000-4000-8000-000000000009',
  '2026-09-14', 500, '2026-09-07', 'SWF-97009-DEP', 'Lead Nine', '2026-09-07 02:00Z', '2026-09-08 02:00Z', '2026-09-08 02:00Z'),
 -- twenty-one: a supplier's bill for the job's materials, paid (made on 20 Sep, after the 4 weeks ran out)
 ('70f00000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-0000000000aa', 'x7021', 'BILL-7021', 'ACCPAY', 'PAID', 0, 820, '2026-09-25', '70000000-0000-4000-8000-000000000021',
  '2026-10-20', 820, '2026-09-20', 'SWF-97021', 'Fixture Supplies', '2026-09-20 02:00Z', '2026-09-25 02:00Z', '2026-09-25 02:00Z'),
 -- twenty-two: a supplier's bill voided and a customer invoice deleted: neither is progress
 ('70f00000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-0000000000aa', 'x7022', 'BILL-7022', 'ACCPAY', 'VOIDED', 0, 0, NULL, '70000000-0000-4000-8000-000000000022',
  '2026-10-20', 640, '2026-09-20', 'SWF-97022', 'Fixture Supplies', '2026-09-20 02:00Z', '2026-09-25 02:00Z', '2026-09-25 02:00Z'),
 ('70f00000-0000-4000-8000-000000000122', '00000000-0000-4000-8000-0000000000aa', 'x7122', 'INV-7122', 'ACCREC', 'DELETED', 0, 0, NULL, '70000000-0000-4000-8000-000000000022',
  '2026-09-27', 500, '2026-09-20', 'SWF-97022-DEP', 'Lead Twenty-Two', '2026-09-20 02:00Z', '2026-09-25 02:00Z', '2026-09-25 02:00Z');

INSERT INTO public.job_assignments (id, job_id, role, scheduled_date, assignment_type, status, crew_name, is_ghost, created_at)
VALUES
 ('70a00000-0000-4000-8000-000000000010', '70000000-0000-4000-8000-000000000010', 'lead_installer', '2026-10-14', 'install', 'scheduled', 'Crew L', false, '2026-09-17 02:00Z'),
 ('70a00000-0000-4000-8000-000000000011', '70000000-0000-4000-8000-000000000011', 'lead_installer', '2026-10-14', 'install', 'scheduled', 'Crew L', true, '2026-09-17 02:00Z'),
 ('70a00000-0000-4000-8000-000000000111', '70000000-0000-4000-8000-000000000011', 'observer', '2026-10-14', 'install', 'scheduled', 'Crew L', false, '2026-09-17 02:00Z'),
 ('70a00000-0000-4000-8000-000000000211', '70000000-0000-4000-8000-000000000011', 'lead_installer', '2026-10-15', 'install', 'cancelled', 'Crew L', false, '2026-09-17 02:00Z');

INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  context_captured_at, attribution_status, attribution_confidence, candidate_job_ids)
VALUES
 -- three: the customer's text on day 25 after the quote
 ('70b00000-0000-4000-8000-000000000003', '70000000-0000-4000-8000-000000000003', 'client.reply', 'ghl', 'sms', 'inbound', 'ct7003',
  '{"body":"Still thinking about the colour, will let you know"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-09-22 02:00Z', '2026-09-22 02:00Z', '2026-09-22 02:00Z', '2026-09-22 02:00Z', 'direct', 1, NULL),
 -- five: the customer's email on day 35 after the quote
 ('70b00000-0000-4000-8000-000000000005', '70000000-0000-4000-8000-000000000005', 'client.email_in', 'outlook-mail-capture', 'email', 'inbound', 'ct7005',
  '{"body":"We are ready to go ahead, what are the next steps?","from":"lead5@example.test","subject":"Fence quote"}',
  '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-10-02 02:00Z', '2026-10-02 02:00Z', '2026-10-02 02:00Z', '2026-10-02 02:00Z', 'direct', 1, NULL),
 -- twelve: the customer's text long before any quote went out (never sent: no clock)
 ('70b00000-0000-4000-8000-000000000012', '70000000-0000-4000-8000-000000000012', 'client.reply', 'ghl', 'sms', 'inbound', 'ct7012',
  '{"body":"Can you quote the side fence too?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-08-01 02:00Z', '2026-08-01 02:00Z', '2026-08-01 02:00Z', '2026-08-01 02:00Z', 'direct', 1, NULL),
 -- sixteen: our follow-up text and a supplier's email on the job since the quote: neither is the customer writing
 ('70b00000-0000-4000-8000-000000000016', '70000000-0000-4000-8000-000000000016', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ct7016',
  '{"body":"Just checking in on the quote"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff"}}',
  '2026-10-02 02:00Z', '2026-10-02 02:00Z', '2026-10-02 02:00Z', '2026-10-02 02:00Z', 'direct', 1, NULL),
 ('70b00000-0000-4000-8000-000000000116', '70000000-0000-4000-8000-000000000016', 'supplier.email_in', 'outlook-mail-capture', 'email', 'inbound', NULL,
  '{"body":"Colorbond stock is back in","from":"orders@supplier.example.test","subject":"Stock"}',
  '{"party_roles":{"counterpart_role":"supplier","sender_role":"supplier"}}',
  '2026-10-04 02:00Z', '2026-10-04 02:00Z', '2026-10-04 02:00Z', '2026-10-04 02:00Z', 'direct', 1, NULL),
 -- seventeen: the customer's text 2 days ago, placed on no job: the customer's newest message, so the
 -- lead is followed up again and the line names it
 ('70b00000-0000-4000-8000-000000000017', NULL, 'client.reply', 'ghl', 'sms', 'inbound', 'ct7017',
  '{"body":"Is the price still the same?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-10-05 02:00Z', '2026-10-05 02:00Z', '2026-10-05 02:00Z', '2026-10-05 02:00Z', NULL, NULL, NULL),
 -- twenty: the customer's missed call on the job 3 days ago
 ('70b00000-0000-4000-8000-000000000020', '70000000-0000-4000-8000-000000000020', 'client.call_logged', 'ghl', 'call', 'inbound', 'ct7020',
  '{"body":"Call. Provider status: no-answer. Duration: 0 seconds","call_status":"no-answer"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-10-04 02:00Z', '2026-10-04 02:00Z', '2026-10-04 02:00Z', '2026-10-04 02:00Z', 'direct', 1, NULL),
 -- twenty-three: the customer's answered call 2 days ago, placed on no job (SWF-26189's shape)
 ('70b00000-0000-4000-8000-000000000023', NULL, 'client.call_logged', 'ghl', 'call', 'inbound', 'ct7023',
  '{"body":"Call. Provider status: completed. Duration: 214 seconds","call_status":"completed"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-10-05 02:00Z', '2026-10-05 02:00Z', '2026-10-05 02:00Z', '2026-10-05 02:00Z', NULL, NULL, NULL),
 -- twenty-four: the customer's text 5 days ago in the placement queue, this job its candidate
 ('70b00000-0000-4000-8000-000000000024', NULL, 'client.reply', 'ghl', 'sms', 'inbound', 'ct7024',
  '{"body":"Could you do it in black?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-10-02 02:00Z', '2026-10-02 02:00Z', '2026-10-02 02:00Z', '2026-10-02 02:00Z', 'unplaced', NULL, ARRAY['70000000-0000-4000-8000-000000000024'::uuid]),
 -- twenty-seven: the customer's email 6 days ago from the client's address, no CRM contact, placed on no job
 ('70b00000-0000-4000-8000-000000000027', NULL, 'client.email_in', 'outlook-mail-capture', 'email', 'inbound', NULL,
  '{"body":"Is the quote still good for November?","from":"Lead Twenty-Seven <lead27@example.test>","subject":"Fence"}',
  '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-10-01 02:00Z', '2026-10-01 02:00Z', '2026-10-01 02:00Z', '2026-10-01 02:00Z', 'unplaced', NULL, NULL),
 -- twenty-eight: the customer's text 4 days ago on their other job (twenty-nine)
 ('70b00000-0000-4000-8000-000000000028', '70000000-0000-4000-8000-000000000029', 'client.reply', 'ghl', 'sms', 'inbound', 'ct7028',
  '{"body":"Also keen on the fence quote still"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-10-03 02:00Z', '2026-10-03 02:00Z', '2026-10-03 02:00Z', '2026-10-03 02:00Z', 'direct', 1, NULL),
 -- thirty-one: the customer's text placed on no job 5 weeks ago (35 days), nothing since
 ('70b00000-0000-4000-8000-000000000031', NULL, 'client.reply', 'ghl', 'sms', 'inbound', 'ct7031',
  '{"body":"We will be in touch after the holidays"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-09-02 02:00Z', '2026-09-02 02:00Z', '2026-09-02 02:00Z', '2026-09-02 02:00Z', NULL, NULL, NULL),
 -- thirty-two: mail from our own mailbox (the client's address on the job) with no CRM contact, placed on no job, 3 days ago
 ('70b00000-0000-4000-8000-000000000032', NULL, 'client.email_in', 'outlook-mail-capture', 'email', 'inbound', NULL,
  '{"body":"Weekly schedule attached","from":"SecureWorks Office <office@secureworkswa.com.au>","subject":"Schedule"}',
  '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
  '2026-10-04 02:00Z', '2026-10-04 02:00Z', '2026-10-04 02:00Z', '2026-10-04 02:00Z', 'admin_bucket', NULL, NULL);

-- twenty-five: their mail from the client's address placed on no job, withheld (they have another job);
-- thirty: their mail from the client's address placed on no job (no other job), from the old inbox
INSERT INTO public.inbox_events (id, job_id, from_email, subject, body_preview, received_at, processed_at, graph_message_id, mailbox, classification)
VALUES ('70d00000-0000-4000-8000-000000000025', NULL, 'lead25@example.test', 'Fence', 'When could you start?', '2026-10-04 02:00Z', '2026-10-04 02:00Z',
        'g70-25', 'office@example.test', 'client_reply'),
       ('70d00000-0000-4000-8000-000000000030', NULL, 'lead30@example.test', 'Fence', 'Still interested, can we talk?', '2026-10-03 06:00Z', '2026-10-03 06:00Z',
        'g70-30', 'office@example.test', 'client_reply'),
       -- thirty-two: our own mailbox's mail, placed on no job 2 days ago (withheld: the address is on two jobs)
       ('70d00000-0000-4000-8000-000000000032', NULL, 'office@secureworkswa.com.au', 'Roster', 'Next week''s roster', '2026-10-05 02:00Z', '2026-10-05 02:00Z',
        'g70-32', 'office@example.test', 'client_reply');

-- 1. The story.
DO $story$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; r record; s jsonb; j uuid; x record;
BEGIN
 -- 29 days after the quote with no progress: R7 ends with the lead words (fails on the earlier bodies)
 SELECT * INTO r FROM public.context_job_record_loops(ARRAY['70000000-0000-4000-8000-000000000002'::uuid], asof) l WHERE l.rule = 'R7_quote_waiting';
 IF r.what IS DISTINCT FROM 'Quote Q-7002 v1 sent Tue 8 Sep 2026 (29 days), not viewed; no answer and no customer message since. '
                            || 'Lead not followed up since Tue 6 Oct 2026: 4 weeks after the last quote or message with no progress'
    OR r.shown_as IS DISTINCT FROM 'loop' OR r.owner IS DISTINCT FROM 'customer'
    OR r.why NOT LIKE '%; the lead is no longer followed up: no acceptance, invoice or bill, booking or later status in the 4 weeks after %'
    OR r.why LIKE '%on the job%' THEN
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
 -- the customer in touch since by a text placed on no job 5 weeks ago (R7 owner unknown): the 4 weeks
 -- run from that text, and the item still open is named after the lead words, without the lead words twice
 s := public.context_job_story('70000000-0000-4000-8000-000000000031', asof);
 IF s->'now'->>'line' IS DISTINCT FROM 'Quoted since Sat 8 Aug. Lead not followed up since Wed 30 Sep: 4 weeks after the last quote or message with no progress; '
                                        || 'open: Quote Q-7031 v1 sent Sat 8 Aug 2026 (60 days), not viewed; no answer recorded, but the customer was in touch since: '
                                        || 'a text Wed 2 Sep 2026 (not placed on any job).'
    OR s->'now'->>'whose_move' IS DISTINCT FROM 'not_followed_up' OR s->'now'->>'not_followed_up_since' IS DISTINCT FROM '2026-09-30' THEN
  RAISE EXCEPTION 'lead cutoff contract: the item still open is named once, after the lead words: %', s->'now';
 END IF;
 -- never the customer's move, on every lead no longer followed up
 FOREACH j IN ARRAY ARRAY['70000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000004', '70000000-0000-4000-8000-000000000008',
   '70000000-0000-4000-8000-000000000011', '70000000-0000-4000-8000-000000000013', '70000000-0000-4000-8000-000000000016',
   '70000000-0000-4000-8000-000000000022', '70000000-0000-4000-8000-000000000031', '70000000-0000-4000-8000-000000000032']::uuid[] LOOP
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
 -- a supplier's bill paid on the job (SWF-26106's shape) is progress: never "Lead not followed up"
 s := public.context_job_story('70000000-0000-4000-8000-000000000021', asof);
 IF s->'now'->>'whose_move' = 'not_followed_up' OR s->'now'->'monitored' IS DISTINCT FROM 'true'::jsonb
    OR s->'now'->'not_followed_up_since' IS DISTINCT FROM 'null'::jsonb OR s->'now'->>'line' LIKE '%Lead not followed up%' THEN
  RAISE EXCEPTION 'lead cutoff contract: a paid supplier bill keeps the lead followed up: %', s->'now';
 END IF;
 SELECT * INTO r FROM public.context_job_record_loops(ARRAY['70000000-0000-4000-8000-000000000021'::uuid], asof) l WHERE l.rule = 'R7_quote_waiting';
 IF r.what LIKE '%Lead not followed up%' OR r.why LIKE '%no longer followed up%' THEN
  RAISE EXCEPTION 'lead cutoff contract: R7 of a lead with a paid supplier bill has no lead words: %', row_to_json(r);
 END IF;
 -- the customer in touch off the job in the 4 weeks (SWF-26189, SWP-26634 and SWF-26544's shapes): followed
 -- up, whose move unclear, and the line names that contact, never "Lead not followed up" beside it
 FOR x IN SELECT * FROM (VALUES
   ('70000000-0000-4000-8000-000000000017'::uuid, 'Quote Q-7017 v1 sent Fri 28 Aug 2026 (40 days), not viewed; no answer recorded, but the customer was in touch since: a text Mon 5 Oct 2026 (not placed on any job)'),
   ('70000000-0000-4000-8000-000000000023', 'Quote Q-7023 v1 sent Sat 8 Aug 2026 (60 days), not viewed; no answer recorded, but the customer was in touch since: an answered call Mon 5 Oct 2026 (not placed on any job)'),
   ('70000000-0000-4000-8000-000000000024', 'Quote Q-7024 v1 sent Sat 8 Aug 2026 (60 days), not viewed; no answer recorded, but the customer was in touch since: a text Fri 2 Oct 2026 (not placed on any job)'),
   -- (the first line cuts the item at a word, 200 characters)
   ('70000000-0000-4000-8000-000000000025', 'Quote Q-7025 v1 sent Sat 8 Aug 2026 (60 days), not viewed; no answer recorded, but the customer was in touch since: an email Sun 4 Oct 2026 (not placed on any job; it may be about another of their...'),
   ('70000000-0000-4000-8000-000000000027', 'Quote Q-7027 v1 sent Sat 8 Aug 2026 (60 days), not viewed; no answer recorded, but the customer was in touch since: an email Thu 1 Oct 2026 (not placed on any job)'),
   ('70000000-0000-4000-8000-000000000028', 'Quote Q-7028 v1 sent Sat 8 Aug 2026 (60 days), not viewed; no answer recorded, but the customer was in touch since: a text Sat 3 Oct 2026 (on job SWF-97029)'),
   ('70000000-0000-4000-8000-000000000030', 'Quote Q-7030 v1 sent Sat 8 Aug 2026 (60 days), not viewed; no answer recorded, but the customer was in touch since: an email Sat 3 Oct 2026 (not placed on any job)')
  ) v(id, words) LOOP
  s := public.context_job_story(x.id, asof);
  IF s->'now'->>'whose_move' IS DISTINCT FROM 'unknown' OR s->'now'->'monitored' IS DISTINCT FROM 'true'::jsonb
     OR s->'now'->'not_followed_up_since' IS DISTINCT FROM 'null'::jsonb OR s->'now'->>'line' LIKE '%Lead not followed up%'
     OR position('Whose move is unclear, open: ' || x.words IN s->'now'->>'line') = 0 THEN
   RAISE EXCEPTION 'lead cutoff contract: the customer in touch off the job keeps job % followed up, the contact named: %', x.id, s->'now';
  END IF;
 END LOOP;
 -- the client's address is our own mailbox (SWP-26634's shape): our mail from it, withheld or by
 -- address, is never the customer's, so the lead is not followed up and neither R7 nor the first line
 -- names it as their contact
 SELECT * INTO r FROM public.context_job_record_loops(ARRAY['70000000-0000-4000-8000-000000000032'::uuid], asof) l WHERE l.rule = 'R7_quote_waiting';
 IF r.owner IS DISTINCT FROM 'customer' OR r.what LIKE '%in touch since%'
    OR r.what IS DISTINCT FROM 'Quote Q-7032 v1 sent Sat 8 Aug 2026 (60 days), not viewed; no answer and no customer message since. '
                               || 'Lead not followed up since Sat 5 Sep 2026: 4 weeks after the last quote or message with no progress' THEN
  RAISE EXCEPTION 'lead cutoff contract: our own mail is never the customer''s contact since the quote: %', row_to_json(r);
 END IF;
 s := public.context_job_story('70000000-0000-4000-8000-000000000032', asof);
 IF s->'now'->>'line' IS DISTINCT FROM 'Quoted since Sat 8 Aug. Lead not followed up since Sat 5 Sep: 4 weeks after the last quote or message with no progress.'
    OR s->'now'->>'whose_move' IS DISTINCT FROM 'not_followed_up' THEN
  RAISE EXCEPTION 'lead cutoff contract: the first line never names our own mail as the customer''s: %', s->'now';
 END IF;
 -- the pure assembler with no lead passed in reads the job as followed up
 s := public.context_job_story_assemble('{"id":"x","status":"quoted","type":"fencing","created_at":"2026-08-01T00:00:00Z"}', '{}'::jsonb, NULL, NULL, asof, NULL);
 IF s->'now'->'monitored' IS DISTINCT FROM 'true'::jsonb OR s->'now'->>'whose_move' = 'not_followed_up' THEN
  RAISE EXCEPTION 'lead cutoff contract: with no lead passed in the job is followed up: %', s->'now';
 END IF;
END $story$;

-- 3. The rule, as of each instant.
DO $rule$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; got text; want text; bad text;
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
  'SWF-97017 true within_4_weeks 08-28 02:00 10-05 02:00 11-02 02:00',
  'SWF-97018 true within_4_weeks 09-27 02:00 10-25 02:00',
  'SWF-97019 true not_quoted 08-08 02:00',
  'SWF-97020 true within_4_weeks 08-28 02:00 10-04 02:00 11-01 02:00',
  'SWF-97021 true billed 08-08 02:00',
  'SWF-97022 false not_followed_up 08-08 02:00 09-05 02:00',
  'SWF-97023 true within_4_weeks 08-08 02:00 10-05 02:00 11-02 02:00',
  'SWF-97024 true within_4_weeks 08-08 02:00 10-02 02:00 10-30 02:00',
  'SWF-97025 true within_4_weeks 08-08 02:00 10-04 02:00 11-01 02:00',
  'SWF-97026 true not_quoted',
  'SWF-97027 true within_4_weeks 08-08 02:00 10-01 02:00 10-29 02:00',
  'SWF-97028 true within_4_weeks 08-08 02:00 10-03 02:00 10-31 02:00',
  'SWF-97029 true not_quoted',
  'SWF-97030 true within_4_weeks 08-08 02:00 10-03 06:00 10-31 06:00',
  'SWF-97031 false not_followed_up 08-08 02:00 09-02 02:00 09-30 02:00',
  'SWF-97032 false not_followed_up 08-08 02:00 09-05 02:00',
  'SWF-97033 true not_quoted');
 IF got IS DISTINCT FROM want THEN
  RAISE EXCEPTION 'lead cutoff contract: the rule as of Wed 7 Oct 2026 10:00 Perth:% got% want%', E'\n', E'\n' || got || E'\n', E'\n' || want;
 END IF;
 -- as of other instants: the day before the 4 weeks run out and the instant they do; day 24, before
 -- the day 25 message; before and at the day 35 email; before and at the acceptance on day 40;
 -- before the deposit, the booking and the supplier's bill were made; before the customer's call
 -- placed on no job; either side of the 4 weeks after the customer's text placed on no job
 SELECT string_agg(concat_ws(' ', x.n, m.monitored::text, m.state), ', ' ORDER BY x.o) INTO got
 FROM (VALUES (1, 'SWF-97004', '2026-09-25 01:59:59Z'::timestamptz), (2, 'SWF-97004', '2026-09-25 02:00Z'), (3, 'SWF-97003', '2026-09-21 02:00Z'),
              (4, 'SWF-97005', '2026-10-01 02:00Z'), (5, 'SWF-97005', '2026-10-02 02:00Z'), (6, 'SWF-97006', '2026-09-22 02:00Z'),
              (7, 'SWF-97006', '2026-09-27 02:00Z'), (8, 'SWF-97007', '2026-09-06 02:00Z'), (9, 'SWF-97010', '2026-09-16 02:00Z'),
              (10, 'SWF-97018', '2026-09-20 02:00Z'), (11, 'SWF-97021', '2026-09-19 02:00Z'), (12, 'SWF-97021', '2026-09-20 02:00Z'),
              (13, 'SWF-97023', '2026-10-04 02:00Z'), (14, 'SWF-97031', '2026-09-30 01:59:59Z'), (15, 'SWF-97031', '2026-09-30 02:00Z')) x(o, n, at)
 JOIN public.jobs jb ON jb.job_number = x.n
 CROSS JOIN LATERAL public.context_lead_monitored_jobs(ARRAY[jb.id], x.at) m;
 want := 'SWF-97004 true within_4_weeks, SWF-97004 false not_followed_up, SWF-97003 true within_4_weeks, SWF-97005 false not_followed_up, '
         || 'SWF-97005 true within_4_weeks, SWF-97006 false not_followed_up, SWF-97006 true accepted, SWF-97007 false not_followed_up, '
         || 'SWF-97010 false not_followed_up, SWF-97018 false not_followed_up, SWF-97021 false not_followed_up, SWF-97021 true billed, '
         || 'SWF-97023 false not_followed_up, SWF-97031 true within_4_weeks, SWF-97031 false not_followed_up';
 IF got IS DISTINCT FROM want THEN
  RAISE EXCEPTION 'lead cutoff contract: the rule as of earlier instants: got % want %', got, want;
 END IF;
 -- every live job when the ids are null (never the cancelled or the complete one); an unknown job
 IF (SELECT count(*) FROM public.context_lead_monitored_jobs(NULL, asof) m WHERE m.job_number LIKE 'SWF-970%') <> 30
    OR EXISTS (SELECT 1 FROM public.context_lead_monitored_jobs(NULL, asof) m WHERE m.job_number IN ('SWF-97019', 'SWF-97026', 'SWF-97033'))
    OR (SELECT count(*) FROM public.context_lead_monitored_jobs(NULL, asof) m WHERE m.job_number LIKE 'SWF-970%' AND NOT m.monitored) <> 9 THEN
  RAISE EXCEPTION 'lead cutoff contract: with no ids the rule reads every live job';
 END IF;
 IF (SELECT count(*) FROM public.context_lead_monitored_jobs(ARRAY['70000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000002']::uuid[], asof)) <> 1
    OR EXISTS (SELECT 1 FROM public.context_lead_monitored_jobs(ARRAY[gen_random_uuid()], asof)) THEN
  RAISE EXCEPTION 'lead cutoff contract: a job is listed once, and an unknown job is not listed';
 END IF;
 -- the one-job form is the set form's row for that job (a set of job_id and monitored, as the deep
 -- email load and the daily history top-up read it); an unknown job, or none, has no row
 SELECT string_agg(jb.job_number, ',' ORDER BY jb.job_number COLLATE "C") INTO got
 FROM public.jobs jb CROSS JOIN LATERAL public.context_lead_monitored(jb.id, asof) lm
 WHERE jb.job_number LIKE 'SWF-970%' AND jb.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost') AND lm.monitored IS FALSE;
 IF got IS DISTINCT FROM 'SWF-97002,SWF-97004,SWF-97008,SWF-97011,SWF-97013,SWF-97016,SWF-97022,SWF-97031,SWF-97032'
    OR EXISTS (SELECT 1 FROM public.jobs jb CROSS JOIN LATERAL public.context_lead_monitored(jb.id, asof) lm
               JOIN public.context_lead_monitored_jobs(ARRAY(SELECT o.id FROM public.jobs o WHERE o.job_number LIKE 'SWF-970%'), asof) m ON m.job_id = jb.id
               WHERE jb.job_number LIKE 'SWF-970%' AND (lm.job_id, lm.job_number, lm.monitored, lm.state, lm.quote_sent_at, lm.customer_at, lm.cutoff_at)
                     IS DISTINCT FROM (m.job_id, m.job_number, m.monitored, m.state, m.quote_sent_at, m.customer_at, m.cutoff_at))
    OR (SELECT count(*) FROM public.context_lead_monitored('70000000-0000-4000-8000-000000000002', asof)) <> 1
    OR EXISTS (SELECT 1 FROM public.context_lead_monitored(gen_random_uuid(), asof))
    OR EXISTS (SELECT 1 FROM public.context_lead_monitored(NULL, asof)) THEN
  RAISE EXCEPTION 'lead cutoff contract: the one-job form is the set form''s row, none for an unknown job: %', got;
 END IF;
 -- the rule's customer_at is never older than a customer message the story names (the contact facts:
 -- the job's own newest, theirs placed on no job, withheld, on their other jobs and by their address),
 -- so the line never calls a lead not followed up beside a newer message of the customer's. (The
 -- story's meta still counts withheld and by-address mail as theirs when the client's address is one
 -- of our own, SWF-97032; the first line never names it there, section 1.)
 SELECT string_agg(m.job_number || ' ' || coalesce(to_char(m.customer_at AT TIME ZONE 'UTC', 'MM-DD HH24:MI'), 'none') || ' < '
                   || to_char(f.at AT TIME ZONE 'UTC', 'MM-DD HH24:MI'), '; ' ORDER BY m.job_number COLLATE "C") INTO bad
 FROM public.context_lead_monitored_jobs(ARRAY(SELECT jb.id FROM public.jobs jb WHERE jb.job_number LIKE 'SWF-970%'), asof) m
 CROSS JOIN LATERAL (SELECT public.context_job_story_meta(m.job_id, asof) AS mt) mm
 CROSS JOIN LATERAL (
  SELECT max(z.at) AS at FROM (
   SELECT (mm.mt -> 'off_job' ->> 'newest_customer_at')::timestamptz AS at
   UNION ALL SELECT (mm.mt -> 'unplaced' ->> 'newest_customer_at')::timestamptz
   UNION ALL SELECT (mm.mt -> 'withheld_mail' ->> 'newest_at')::timestamptz
   UNION ALL SELECT (c.last_customer_message ->> 'at')::timestamptz FROM public.context_job_record_contact(ARRAY[m.job_id], asof) c) z) f
 WHERE m.state IN ('within_4_weeks', 'not_followed_up') AND f.at > coalesce(m.customer_at, '-infinity'::timestamptz) AND m.job_number <> 'SWF-97032';
 IF bad IS NOT NULL THEN
  RAISE EXCEPTION 'lead cutoff contract: the rule missed a customer message the story names: %', bad;
 END IF;
END $rule$;
ROLLBACK;

-- 2. The ledger. The judge judges now, so these fixtures are placed relative to now (the same
-- whatever day the suite runs); the ledger is in shadow for these five jobs only, the backfill
-- hours open all day.
BEGIN;
SET LOCAL session_replication_role = replica;
ALTER TABLE public.business_events ALTER COLUMN context_captured_at SET DEFAULT now() - interval '90 days',
 ALTER COLUMN recorded_at SET DEFAULT now() - interval '90 days';
UPDATE public.context_ledger_settings SET mode = 'shadow', backfill_from_hour = NULL, backfill_to_hour = NULL,
 job_ids = ARRAY['70000000-0000-4000-8000-000000000101', '70000000-0000-4000-8000-000000000102', '70000000-0000-4000-8000-000000000103',
                 '70000000-0000-4000-8000-000000000104', '70000000-0000-4000-8000-000000000105']::uuid[]
WHERE id;
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, ghl_contact_id, pricing_json, created_at, updated_at)
VALUES ('70000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-0000000000aa', 'SWF-97101', 'quoted', 'fencing', 'Lead A', 'ct7101', '{}', now() - interval '60 days', now() - interval '60 days'),
       ('70000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-0000000000aa', 'SWF-97102', 'quoted', 'fencing', 'Lead B', 'ct7102', '{}', now() - interval '60 days', now() - interval '60 days'),
       ('70000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-0000000000aa', 'SWF-97103', 'quoted', 'fencing', 'Lead C', 'ct7103', '{}', now() - interval '60 days', now() - interval '60 days'),
       ('70000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-0000000000aa', 'SWF-97104', 'quoted', 'fencing', 'Lead D', 'ct7104', '{}', now() - interval '60 days', now() - interval '60 days'),
       ('70000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-0000000000aa', 'SWF-97105', 'quoted', 'fencing', 'Lead E', 'ct7105', '{}', now() - interval '60 days', now() - interval '60 days');
INSERT INTO public.job_documents (id, job_id, type, quote_number, version, created_at, sent_at)
VALUES ('70e00000-0000-4000-8000-000000000101', '70000000-0000-4000-8000-000000000101', 'quote', 'Q-7101', 1, now() - interval '41 days', now() - interval '40 days'),
       ('70e00000-0000-4000-8000-000000000102', '70000000-0000-4000-8000-000000000102', 'quote', 'Q-7102', 1, now() - interval '6 days', now() - interval '5 days'),
       ('70e00000-0000-4000-8000-000000000103', '70000000-0000-4000-8000-000000000103', 'quote', 'Q-7103', 1, now() - interval '41 days', now() - interval '40 days'),
       ('70e00000-0000-4000-8000-000000000104', '70000000-0000-4000-8000-000000000104', 'quote', 'Q-7104', 1, now() - interval '41 days', now() - interval '40 days'),
       ('70e00000-0000-4000-8000-000000000105', '70000000-0000-4000-8000-000000000105', 'quote', 'Q-7105', 1, now() - interval '41 days', now() - interval '40 days');
INSERT INTO public.xero_invoices (id, org_id, xero_invoice_id, invoice_number, invoice_type, status, amount_due, amount_paid, job_id, total, reference,
  contact_name, created_at, updated_at, synced_at)
VALUES ('70f00000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-0000000000aa', 'x7105', 'BILL-7105', 'ACCPAY', 'PAID', 0, 410,
        '70000000-0000-4000-8000-000000000105', 410, 'SWF-97105', 'Fixture Supplies', now() - interval '10 days', now() - interval '10 days', now() - interval '10 days');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  context_captured_at, attribution_status, attribution_confidence)
SELECT x.id::uuid, x.job::uuid, 'client.reply', 'ghl', 'sms', 'inbound', x.ct, jsonb_build_object('body', x.body),
       '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}', now() - x.ago, now() - x.ago, now() - x.ago, now() - x.ago,
       CASE WHEN x.job IS NOT NULL THEN 'direct' END, CASE WHEN x.job IS NOT NULL THEN 1 END
FROM (VALUES ('70b00000-0000-4000-8000-000000000101', '70000000-0000-4000-8000-000000000101', 'ct7101', 'Thanks, we will think about it', interval '39 days'),
             ('70b00000-0000-4000-8000-000000000102', '70000000-0000-4000-8000-000000000102', 'ct7102', 'Thanks, we will think about it', interval '4 days'),
             ('70b00000-0000-4000-8000-000000000103', '70000000-0000-4000-8000-000000000103', 'ct7103', 'Thanks, we will think about it', interval '39 days'),
             ('70b00000-0000-4000-8000-000000000203', '70000000-0000-4000-8000-000000000103', 'ct7103', 'Can we start in November?', interval '1 hour'),
             ('70b00000-0000-4000-8000-000000000104', '70000000-0000-4000-8000-000000000104', 'ct7104', 'Thanks, we will think about it', interval '39 days'),
             -- the customer's text placed on no job two hours ago
             ('70b00000-0000-4000-8000-000000000204', NULL, 'ct7104', 'Are you free to talk tomorrow?', interval '2 hours'),
             ('70b00000-0000-4000-8000-000000000105', '70000000-0000-4000-8000-000000000105', 'ct7105', 'Thanks, we will think about it', interval '39 days')
     ) x(id, job, ct, body, ago);
DO $ledger$
DECLARE r record; c jsonb; due text;
BEGIN
 -- a lead no longer followed up is never due a read (fails on the earlier judge: never_read, due)
 SELECT * INTO r FROM public.context_ledger_judge(ARRAY['70000000-0000-4000-8000-000000000101'::uuid]) d;
 IF r.due OR r.blocked_reason IS DISTINCT FROM 'lead_not_monitored' OR r.evidence_rows <> 1 THEN
  RAISE EXCEPTION 'lead cutoff contract: a lead no longer followed up is blocked lead_not_monitored: %', row_to_json(r);
 END IF;
 -- a lead inside its 4 weeks, one the customer wrote on an hour ago, one the customer texted off the
 -- job two hours ago and one with a paid supplier bill are judged as before
 FOR r IN SELECT * FROM public.context_ledger_judge(ARRAY['70000000-0000-4000-8000-000000000102', '70000000-0000-4000-8000-000000000103',
            '70000000-0000-4000-8000-000000000104', '70000000-0000-4000-8000-000000000105']::uuid[]) LOOP
  IF NOT r.due OR r.kind IS DISTINCT FROM 'backfill' OR r.reason IS DISTINCT FROM 'never_read' OR r.blocked_reason IS NOT NULL THEN
   RAISE EXCEPTION 'lead cutoff contract: a lead still followed up is due a read as before: %', row_to_json(r);
  END IF;
 END LOOP;
 -- the due list never lists it
 SELECT string_agg(jb.job_number, ',' ORDER BY jb.job_number COLLATE "C") INTO due
 FROM public.context_ledger_due(200) d JOIN public.jobs jb ON jb.id = d.job_id;
 IF due IS DISTINCT FROM 'SWF-97102,SWF-97103,SWF-97104,SWF-97105' THEN
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
DECLARE x record; p record; rule_shape constant text :=
 'TABLE(job_id uuid, job_number text, monitored boolean, state text, quote_sent_at timestamp with time zone, customer_at timestamp with time zone, cutoff_at timestamp with time zone)';
BEGIN
 FOR x IN SELECT * FROM (VALUES
   ('public.context_lead_monitored_jobs(uuid[],timestamptz)', true, 'Lead cutoff (20261007010000): %'),
   ('public.context_lead_monitored(uuid,timestamptz)', true, 'Lead cutoff (20261007010000): %'),
   ('public.context_job_record_loops(uuid[],timestamptz)', true,
    'Job record (20261006011000), story fixes (20261006033000), story safety (20261006040000): (lead cutoff, 20261007010000) %'),
   ('public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)', true, 'Job story (20261006014000), lead cutoff (20261007010000): %'),
   ('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)', false,
    'Job story (20261006014000), story fixes (20261006033000), story safety (20261006040000): (lead cutoff, 20261007010000) %'),
   -- (widened by notes freshness, 20261009132000, which names itself first and keeps this slice's text after "Earlier")
   ('public.context_ledger_judge(uuid[])', true, 'Context ledger store (20261006013000), story safety (20261006040000): %(lead cutoff, 20261007010000) %')
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
 -- both forms return the same set of rows; the readers that detect the rule (a set returning
 -- function whose result columns include job_id uuid and monitored boolean) find the one-job form
 IF pg_get_function_result('public.context_lead_monitored_jobs(uuid[],timestamptz)'::regprocedure) IS DISTINCT FROM rule_shape
    OR pg_get_function_result('public.context_lead_monitored(uuid,timestamptz)'::regprocedure) IS DISTINCT FROM rule_shape
    OR NOT (SELECT bool_and(pr.proretset) FROM pg_proc pr
            WHERE pr.oid IN ('public.context_lead_monitored_jobs(uuid[],timestamptz)'::regprocedure, 'public.context_lead_monitored(uuid,timestamptz)'::regprocedure))
    OR (SELECT count(*) FROM pg_proc pr
        CROSS JOIN LATERAL unnest(pr.proargnames, pr.proallargtypes, pr.proargmodes::text[]) AS a(n, typ, m)
        WHERE pr.oid = to_regprocedure('public.context_lead_monitored(uuid,timestamp with time zone)') AND pr.proretset AND a.m IN ('o', 't')
          AND ((a.n = 'job_id' AND a.typ = 'uuid'::regtype::oid) OR (a.n = 'monitored' AND a.typ = 'boolean'::regtype::oid))) <> 2 THEN
  RAISE EXCEPTION 'lead cutoff contract: the rule''s columns changed';
 END IF;
END $shape$;

-- 5. Re-applying the migration changes nothing (its guard accepts its own bodies). When the scoping
-- pipeline (20261009133000) has replaced four of these bodies since, it is rolled back first inside
-- this transaction, so the re-apply starts from this migration's own bodies.
SELECT to_regprocedure('public.context_lead_window_hours(text)') IS NOT NULL AS scoping_pipeline_live \gset
BEGIN;
\if :scoping_pipeline_live
\ir ../../../rollbacks/20261009133000_context_scoping_pipeline_down.sql
\endif
SELECT to_regprocedure('public.context_ledger_row_unread(timestamptz,boolean,timestamptz)') IS NOT NULL AS notes_freshness_live \gset
\if :notes_freshness_live
\ir ../../../rollbacks/20261009132000_context_notes_freshness_down.sql
\endif
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

-- 6. The service role reads the rule directly (a door, an ops check, a reader of its own), with a lead
-- in the set: a fresh session, so no plan cached earlier hides a missing grant, and the table grants
-- production gives the service role, so the only thing between it and the rows is the rule's own
-- access. The record layer's messages run the ladder's crew and staff helper on our outbound texts
-- (context_internal_text_role, which 20261005090000 revoked from the service role), so a rule that
-- ran as its caller would be refused here (production: permission denied for that helper).
\c
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, ghl_contact_id, pricing_json, created_at, updated_at)
VALUES ('70000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-0000000000aa', 'SWF-97301', 'quoted', 'fencing', 'Lead SR', 'ct7301', '{}', '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
       ('70000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-0000000000aa', 'SWF-97302', 'quoted', 'fencing', 'Lead SR Two', 'ct7302', '{}', '2026-07-01 00:00Z', '2026-07-01 00:00Z');
INSERT INTO public.job_documents (id, job_id, type, quote_number, version, created_at, sent_at)
VALUES ('70e00000-0000-4000-8000-000000000301', '70000000-0000-4000-8000-000000000301', 'quote', 'Q-7301', 1, '2026-08-08 01:00Z', '2026-08-08 02:00Z'),
       ('70e00000-0000-4000-8000-000000000302', '70000000-0000-4000-8000-000000000302', 'quote', 'Q-7302', 1, '2026-08-08 01:00Z', '2026-08-08 02:00Z');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  context_captured_at, attribution_status, attribution_confidence)
VALUES ('70b00000-0000-4000-8000-000000000301', '70000000-0000-4000-8000-000000000301', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ct7301',
        '{"body":"Just checking in on the quote"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff"}}',
        '2026-09-02 02:00Z', '2026-09-02 02:00Z', '2026-09-02 02:00Z', '2026-09-02 02:00Z', 'direct', 1),
       ('70b00000-0000-4000-8000-000000000302', NULL, 'client.reply', 'ghl', 'sms', 'inbound', 'ct7302',
        '{"body":"Can we talk next week?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer"}}',
        '2026-10-05 02:00Z', '2026-10-05 02:00Z', '2026-10-05 02:00Z', '2026-10-05 02:00Z', NULL, NULL);
GRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role;
SET LOCAL ROLE service_role;
DO $service$
DECLARE asof constant timestamptz := '2026-10-07 02:00Z'; got text;
BEGIN
 IF has_function_privilege('service_role', 'public.context_internal_text_role(public.business_events)', 'EXECUTE') THEN
  RAISE EXCEPTION 'lead cutoff contract: the ladder helper is meant to stay revoked from the service role here';
 END IF;
 BEGIN
  SELECT string_agg(concat_ws(' ', m.job_number, m.monitored::text, m.state), ', ' ORDER BY m.job_number COLLATE "C") INTO got
  FROM public.context_lead_monitored_jobs(ARRAY['70000000-0000-4000-8000-000000000301', '70000000-0000-4000-8000-000000000302']::uuid[], asof) m;
  IF got IS DISTINCT FROM 'SWF-97301 false not_followed_up, SWF-97302 true within_4_weeks' THEN
   RAISE EXCEPTION 'lead cutoff contract: the service role read the set form wrong: %', got;
  END IF;
  SELECT string_agg(concat_ws(' ', m.job_number, m.monitored::text, m.state), ', ') INTO got
  FROM public.context_lead_monitored('70000000-0000-4000-8000-000000000301', asof) m;
  IF got IS DISTINCT FROM 'SWF-97301 false not_followed_up' THEN
   RAISE EXCEPTION 'lead cutoff contract: the service role read the one-job form wrong: %', got;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.context_lead_monitored_jobs(NULL, asof) m WHERE m.job_number = 'SWF-97301' AND NOT m.monitored) THEN
   RAISE EXCEPTION 'lead cutoff contract: the service role read the live set wrong';
  END IF;
 EXCEPTION WHEN insufficient_privilege THEN
  RAISE EXCEPTION 'lead cutoff contract: the service role must read the rule with a lead in the set: % (%)', SQLERRM, SQLSTATE;
 END;
END $service$;
RESET ROLE;
ROLLBACK;
