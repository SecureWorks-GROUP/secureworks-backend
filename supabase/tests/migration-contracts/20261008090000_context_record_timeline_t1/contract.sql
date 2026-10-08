-- Contract: 20261008090000_context_record_timeline_t1. The record timeline shows each record
-- milestone once, with the right date and words (proof-set test T1). Every fixture write is rolled
-- back. Job numbers, contacts, names and words are synthetic; the row shapes are those of the jobs
-- the 7 Oct 2026 go-live grade failed on T1 (SWF-261387, SWP-26991 and SWF-261501 for the scope
-- save; SWF-26282 for the stamps; SWMS-261050 for the assignment record and the deleted invoice;
-- SWF-261209 for first contact; SWR-261364 for repair stages), of two wrong values found on the
-- 8 Oct re-check (SWF-26545's status fold; SWP-26183's clock-off pair) and of the reference rows never
-- shown (the 5 Oct ghost correction's assignment_updated events). Every fixture row is dated
-- at a fixed instant in 2026, and every timeline is read as of a fixed instant (Wed 7 Oct 2026
-- 14:10 Perth), so no answer depends on the clock of the run. Each section fails on the 20261006040000
-- body:
--  1. A scope saved in the scoping tool is kind scope_saved, never a site visit; a recorded visit
--     outcome stays a site visit.
--  2. A job-row stage stamp written at the job's creation instant is no stage line: the job created
--     line says the record was made already in that stage, with no date for it. A stamp written
--     later, even seconds later, stays.
--  3. An assignment row with no booked date, marked complete the moment it was made and never
--     started or clocked, is kind booking_record with no state and no made_at, and has no
--     attendance line: it does not date a visit. A dated booking marked complete keeps its
--     attendance line; a dateless booking that is not complete stays a booking.
--  4. First contact is never a message from before the job was made, sent while the same person
--     (CRM contact, email or phone) was a party other than the client on another job still open
--     then, and the line says how many such earlier messages it left out. It stays when that other
--     job had closed, and when the person was the other job's own client.
--  5. Each repair stage change is one line with its from and to; a change to the same stage is none.
--  6. A deleted invoice's state is deleted (a voided one stays voided), on customer invoices and
--     supplier bills.
--  7. A fold of several status changes within minutes starts its path with the first change's from.
--  8. A clock-off sent again within a minute for the same booking with the same net hours is one
--     stint; two real stints still add up.
--  9. A booking row's details changed (assignment_updated) is a line: a booking change with its
--     booked day, and on a ghost row, or one its writer tags as a ghost correction, an observer copy.
-- 10. Shape: definer, stable, search path, service role only, the slice name first in the comment.
-- 11. Re-applying the migration changes nothing.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.t1_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'record timeline T1 contract: %', p_msg; END IF; END $$;

BEGIN;
SET LOCAL session_replication_role = replica;
-- a fixture row that names no capture time was captured the day the fixtures were written
ALTER TABLE public.business_events ALTER COLUMN context_captured_at SET DEFAULT '2026-10-06 12:00Z';

-- Jobs. Org and every date fixed.
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, client_email, ghl_contact_id, pricing_json,
  quoted_at, accepted_at, processing_at, completed_at, created_at, updated_at)
VALUES
 -- 1. scope saved (SWF-261387 shape): saved Mon 7 Sep, the visit was Thu 10 Sep
 ('8a000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000aa', 'SWF-T8101', 'quoted', 'fencing', 'Scope Client',
  NULL, 'ct81s', '{}', NULL, NULL, NULL, NULL, '2026-09-07 01:33:50Z', '2026-09-10 05:48Z'),
 -- 2. a job row made already quoted, accepted and complete at the CRM sync instant (SWF-26282 shape)
 ('8a000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000aa', 'SWF-T8102', 'final_payment', 'fencing', 'Sync Client',
  NULL, 'ct81y', '{}', '2026-04-22 03:26:38.385Z', '2026-04-22 03:26:38.385Z', NULL, '2026-04-22 03:26:38.385Z',
  '2026-04-22 03:26:38.385Z', '2026-09-15 03:12Z'),
 -- 2 and 3. a make-safe moved to processing 27 s after it was made (SWMS-261050 shape)
 ('8a000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000aa', 'SWMS-T8103', 'processing', 'makesafe', 'Builder Co',
  NULL, NULL, '{}', NULL, NULL, '2026-07-23 02:38:52.706Z', NULL, '2026-07-23 02:38:26.007Z', '2026-09-29 11:25Z'),
 -- 2. one stage at creation
 ('8a000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-0000000000aa', 'SWP-T8104', 'quoted', 'patio', 'Lead Client',
  NULL, NULL, '{}', '2026-02-19 02:18:13.503Z', NULL, NULL, NULL, '2026-02-19 02:18:13.503Z', '2026-02-19 02:18:13.503Z'),
 -- 4. the other job the person was a neighbour party on, still open (SWF-261209's SWF-26395)
 ('8a000000-0000-4000-8000-000000000040', '00000000-0000-4000-8000-0000000000aa', 'SWF-T8140', 'partially_accepted', 'fencing', 'Shared Fence Client',
  'k.client@example.test', 'ct81k', '{}', NULL, NULL, NULL, NULL, '2026-06-02 23:47:10Z', '2026-10-01 01:00Z'),
 -- 4. the person's own job, made weeks after the texts about the shared fence
 ('8a000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-0000000000aa', 'SWF-T8141', 'invoiced', 'fencing', 'Pat Person',
  'p.person@example.test', 'ct81p', '{}', NULL, NULL, NULL, NULL, '2026-08-14 08:05:42Z', '2026-10-02 01:00Z'),
 -- 4. control: the other job closed before the message
 ('8a000000-0000-4000-8000-000000000050', '00000000-0000-4000-8000-0000000000aa', 'SWF-T8150', 'complete', 'fencing', 'Old Job Client',
  NULL, 'ct81o', '{}', NULL, NULL, NULL, NULL, '2026-05-01 01:00Z', '2026-06-20 01:00Z'),
 ('8a000000-0000-4000-8000-000000000051', '00000000-0000-4000-8000-0000000000aa', 'SWF-T8151', 'quoted', 'fencing', 'Quinn Person',
  NULL, 'ct81q', '{}', NULL, NULL, NULL, NULL, '2026-08-14 01:00Z', '2026-08-20 01:00Z'),
 -- 4. control: the person is the other job's own client (a repeat client)
 ('8a000000-0000-4000-8000-000000000060', '00000000-0000-4000-8000-0000000000aa', 'SWF-T8160', 'final_payment', 'fencing', 'Rae Person',
  NULL, 'ct81r', '{}', NULL, NULL, NULL, NULL, '2026-05-01 01:00Z', '2026-09-01 01:00Z'),
 ('8a000000-0000-4000-8000-000000000061', '00000000-0000-4000-8000-0000000000aa', 'SWF-T8161', 'quoted', 'fencing', 'Rae Person',
  NULL, 'ct81r', '{}', NULL, NULL, NULL, NULL, '2026-08-14 01:00Z', '2026-08-20 01:00Z'),
 -- 5. repair stages (SWR-261364 shape)
 ('8a000000-0000-4000-8000-000000000080', '00000000-0000-4000-8000-0000000000aa', 'SWR-T8180', 'processing', 'repair', 'Builder Co',
  NULL, NULL, '{}', NULL, NULL, NULL, NULL, '2026-09-03 03:48:16Z', '2026-10-06 02:47Z'),
 -- 6. deleted and voided invoices (SWF-261387, SWMS-261050 shapes)
 ('8a000000-0000-4000-8000-000000000090', '00000000-0000-4000-8000-0000000000aa', 'SWF-T8190', 'quoted', 'fencing', 'Invoice Client',
  NULL, NULL, '{}', NULL, NULL, NULL, NULL, '2026-09-07 01:00Z', '2026-09-21 01:00Z'),
 -- 7. a status fold (SWF-26545 shape)
 ('8a000000-0000-4000-8000-0000000000a0', '00000000-0000-4000-8000-0000000000aa', 'SWF-T81A0', 'awaiting_supplier', 'fencing', 'Fold Client',
  NULL, NULL, '{}', NULL, NULL, NULL, NULL, '2026-06-08 01:00Z', '2026-09-30 01:00Z'),
 -- 8. a clock-off submitted twice (SWP-26183 shape) and a day of two real stints
 ('8a000000-0000-4000-8000-0000000000b0', '00000000-0000-4000-8000-0000000000aa', 'SWP-T81B0', 'in_progress', 'patio', 'Clock Client',
  NULL, NULL, '{}', NULL, NULL, NULL, NULL, '2026-05-05 01:00Z', '2026-09-25 01:00Z'),
 ('8a000000-0000-4000-8000-0000000000c0', '00000000-0000-4000-8000-0000000000aa', 'SWP-T81C0', 'in_progress', 'patio', 'Stint Client',
  NULL, NULL, '{}', NULL, NULL, NULL, NULL, '2026-05-05 01:00Z', '2026-09-25 01:00Z');

-- Parties. The person P (CRM contact ct81p, email, phone) is the neighbour party on SWF-T8140 with
-- no CRM contact there, as the live neighbour rows are; and the primary party on their own job.
INSERT INTO public.job_contacts (id, job_id, contact_type, client_name, client_email, client_phone, ghl_contact_id, is_primary, created_at, updated_at)
VALUES
 ('8ad00000-0000-4000-8000-000000000401', '8a000000-0000-4000-8000-000000000040', 'primary', 'Shared Fence Client', 'k.client@example.test',
  '0400 811 400', 'ct81k', true, '2026-06-02 23:47Z', '2026-06-02 23:47Z'),
 ('8ad00000-0000-4000-8000-000000000402', '8a000000-0000-4000-8000-000000000040', 'neighbour_c', 'Pat Person', 'p.person@example.test',
  '0400 811 811', NULL, false, '2026-06-02 23:47Z', '2026-06-02 23:47Z'),
 ('8ad00000-0000-4000-8000-000000000411', '8a000000-0000-4000-8000-000000000041', 'primary', 'Pat Person', 'p.person@example.test',
  '0400 811 811', 'ct81p', true, '2026-08-24 02:51Z', '2026-08-24 02:51Z'),
 -- Q was a neighbour party on a job that closed before Q's message
 ('8ad00000-0000-4000-8000-000000000502', '8a000000-0000-4000-8000-000000000050', 'neighbour_b', 'Quinn Person', NULL,
  '0400 811 822', NULL, false, '2026-05-01 01:00Z', '2026-05-01 01:00Z'),
 ('8ad00000-0000-4000-8000-000000000511', '8a000000-0000-4000-8000-000000000051', 'primary', 'Quinn Person', NULL,
  '0400 811 822', 'ct81q', true, '2026-08-14 01:00Z', '2026-08-14 01:00Z'),
 -- R is the other job's own client, and also listed there as a party by mistake
 ('8ad00000-0000-4000-8000-000000000602', '8a000000-0000-4000-8000-000000000060', 'neighbour_b', 'Rae Person', NULL,
  '0400 811 833', 'ct81r', false, '2026-05-01 01:00Z', '2026-05-01 01:00Z');

-- Messages on the person's own jobs: our texts to them, placed by their CRM contact.
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  attribution_status, attribution_confidence, match_method)
VALUES
 -- 4. weeks before the job, while P was a neighbour party on SWF-T8140 (about that fence's invoice)
 ('8ae00000-0000-4000-8000-000000000411', '8a000000-0000-4000-8000-000000000041', 'client.sms_out', 'ghl-proxy', 'sms', 'outbound', 'ct81p',
  '{"body":"Your share of the deposit for the shared fence is invoiced."}',
  '{"party_roles":{"basis":"job_customer","counterpart_role":"customer","sender_role":"staff","recipient_role":"customer","audience":"customer"}}',
  '2026-07-03 03:24:43Z', '2026-07-03 03:24:43Z', '2026-07-03 03:24:43Z', 'single_open', 1, 'contact_id'),
 ('8ae00000-0000-4000-8000-000000000412', '8a000000-0000-4000-8000-000000000041', 'client.sms_out', 'ghl-proxy', 'sms', 'outbound', 'ct81p',
  '{"body":"The shared fence is finished; your share of the balance is invoiced."}',
  '{"party_roles":{"basis":"job_customer","counterpart_role":"customer","sender_role":"staff","recipient_role":"customer","audience":"customer"}}',
  '2026-07-30 04:33:13Z', '2026-07-30 04:33:13Z', '2026-07-30 04:33:13Z', 'single_open', 1, 'contact_id'),
 -- 4. after the job was made: about this job
 ('8ae00000-0000-4000-8000-000000000413', '8a000000-0000-4000-8000-000000000041', 'client.sms_out', 'ghl-proxy', 'sms', 'outbound', 'ct81p',
  '{"body":"The deposit invoice for your own fence is sent."}',
  '{"party_roles":{"basis":"job_customer","counterpart_role":"customer","sender_role":"staff","recipient_role":"customer","audience":"customer"}}',
  '2026-09-07 06:23Z', '2026-09-07 06:23Z', '2026-09-07 06:23Z', 'single_open', 1, 'contact_id'),
 -- 4. control: Q's enquiry before Q's job, after the job Q was a party on had closed
 ('8ae00000-0000-4000-8000-000000000511', '8a000000-0000-4000-8000-000000000051', 'client.reply', 'ghl-proxy', 'sms', 'inbound', 'ct81q',
  '{"body":"Can you quote a fence at my place?"}',
  '{"party_roles":{"basis":"job_customer","counterpart_role":"customer","sender_role":"customer","recipient_role":"staff","audience":"customer"}}',
  '2026-07-03 03:00Z', '2026-07-03 03:00Z', '2026-07-03 03:00Z', 'single_open', 1, 'contact_id'),
 -- 4. control: R's enquiry before R's second job, while R's first job (R its client) was open
 ('8ae00000-0000-4000-8000-000000000611', '8a000000-0000-4000-8000-000000000061', 'client.reply', 'ghl-proxy', 'sms', 'inbound', 'ct81r',
  '{"body":"Could you also quote the side fence?"}',
  '{"party_roles":{"basis":"job_customer","counterpart_role":"customer","sender_role":"customer","recipient_role":"staff","audience":"customer"}}',
  '2026-08-01 03:00Z', '2026-08-01 03:00Z', '2026-08-01 03:00Z', 'single_open', 1, 'contact_id');

-- 1. the scope saves and the recorded visit
INSERT INTO public.job_events (id, job_id, event_type, detail_json, created_at)
VALUES ('8af00000-0000-4000-8000-000000000011', '8a000000-0000-4000-8000-000000000001', 'scope_saved', '{}', '2026-09-07 01:40Z'),
       ('8af00000-0000-4000-8000-000000000012', '8a000000-0000-4000-8000-000000000001', 'scope_saved', '{}', '2026-09-12 02:00Z');
INSERT INTO public.visit_outcomes (id, booking_key, contact_id, job_id, scoper_user_id, scoper_name, visit_start, outcome, reason,
  quote_owed, recorded_by_user_id, recorded_at)
VALUES ('8ab00000-0000-4000-8000-000000000011', 'bk-t81-1', 'ct81s', '8a000000-0000-4000-8000-000000000001',
        '8a900000-0000-4000-8000-000000000001', 'Sam Scoper', '2026-09-10 02:00Z', 'happened', NULL, false,
        '8a900000-0000-4000-8000-000000000001', '2026-09-10 05:00Z');

-- 2. a status change on the synced job
INSERT INTO public.job_events (id, job_id, event_type, detail_json, created_at)
VALUES ('8af00000-0000-4000-8000-000000000021', '8a000000-0000-4000-8000-000000000002', 'status_changed',
        '{"source":"ops_dashboard","new_status":"final_payment"}', '2026-09-15 03:12Z');

-- 3. the make-safe's bookings: attended 23 Jul (status only); the record the app made complete when
-- the report was submitted 29 Sep, with no booked date; and a dateless booking not complete
INSERT INTO public.job_assignments (id, job_id, role, scheduled_date, assignment_type, status, crew_name, is_ghost, created_at, completed_at,
  started_at, clocked_on_at)
VALUES
 ('8aa00000-0000-4000-8000-000000000031', '8a000000-0000-4000-8000-000000000003', 'lead_installer', '2026-07-23', 'install', 'complete',
  'Crew M', false, '2026-07-22 01:00Z', NULL, NULL, NULL),
 ('8aa00000-0000-4000-8000-000000000032', '8a000000-0000-4000-8000-000000000003', 'crew', NULL, 'install', 'complete',
  NULL, false, '2026-09-29 07:54:07.773Z', '2026-09-29 07:54:06.782Z', NULL, NULL),
 ('8aa00000-0000-4000-8000-000000000033', '8a000000-0000-4000-8000-000000000003', 'crew', NULL, 'install', 'scheduled',
  NULL, false, '2026-09-30 01:00Z', NULL, NULL, NULL);

-- 5. the repair job's stage changes, and a "change" to the same stage
INSERT INTO public.job_events (id, job_id, event_type, detail_json, created_at)
VALUES
 ('8af00000-0000-4000-8000-000000000081', '8a000000-0000-4000-8000-000000000080', 'repair_stage_changed',
  '{"from_stage":"wo_in","to_stage":"scoping","changed_at":"2026-09-08T09:45:21.439Z"}', '2026-09-08 09:45:21.555Z'),
 ('8af00000-0000-4000-8000-000000000082', '8a000000-0000-4000-8000-000000000080', 'repair_stage_changed',
  '{"from_stage":"scoping","to_stage":"scheduled"}', '2026-09-23 03:14:22Z'),
 ('8af00000-0000-4000-8000-000000000083', '8a000000-0000-4000-8000-000000000080', 'repair_stage_changed',
  '{"from_stage":"scheduled","to_stage":"on_site"}', '2026-10-01 01:19:11Z'),
 ('8af00000-0000-4000-8000-000000000084', '8a000000-0000-4000-8000-000000000080', 'repair_stage_changed',
  '{"from_stage":"on_site","to_stage":"complete"}', '2026-10-02 05:52:49Z'),
 ('8af00000-0000-4000-8000-000000000085', '8a000000-0000-4000-8000-000000000080', 'repair_stage_changed',
  '{"from_stage":"complete","to_stage":"on_site"}', '2026-10-05 06:04:48Z'),
 ('8af00000-0000-4000-8000-000000000086', '8a000000-0000-4000-8000-000000000080', 'repair_stage_changed',
  '{"from_stage":"on_site","to_stage":"complete"}', '2026-10-06 02:47:59Z'),
 ('8af00000-0000-4000-8000-000000000087', '8a000000-0000-4000-8000-000000000080', 'repair_stage_changed',
  '{"from_stage":"complete","to_stage":"complete"}', '2026-10-06 03:00Z');

-- 6. a deleted invoice, a voided invoice and a deleted supplier bill
INSERT INTO public.xero_invoices (org_id, id, job_id, xero_invoice_id, contact_name, invoice_number, invoice_type, status, reference,
  total, amount_due, amount_paid, invoice_date, due_date, raw_json, created_at, updated_at)
VALUES
 ('00000000-0000-4000-8000-0000000000aa', '8ac00000-0000-4000-8000-000000000091', '8a000000-0000-4000-8000-000000000090', 'x8191',
  'Invoice Client', 'INV-8191', 'ACCREC', 'DELETED', 'SWF-T8190', 2000.00, 0, 0, '2026-09-20', '2026-09-27', '{"Status":"DELETED"}',
  '2026-09-20 01:00Z', '2026-09-20 02:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '8ac00000-0000-4000-8000-000000000092', '8a000000-0000-4000-8000-000000000090', 'x8192',
  'Invoice Client', 'INV-8192', 'ACCREC', 'VOIDED', 'SWF-T8190-B', 500.00, 0, 0, '2026-09-21', '2026-09-28', '{"Status":"VOIDED"}',
  '2026-09-21 01:00Z', '2026-09-21 02:00Z'),
 ('00000000-0000-4000-8000-0000000000aa', '8ac00000-0000-4000-8000-000000000093', '8a000000-0000-4000-8000-000000000090', 'x8193',
  'Fence Supplies', 'BILL-8193', 'ACCPAY', 'DELETED', 'SWF-T8190', 310.00, 0, 0, '2026-09-21', '2026-10-05', '{"Status":"DELETED"}',
  '2026-09-21 01:00Z', '2026-09-21 02:00Z');

-- 7. two status changes within minutes, then a single one
INSERT INTO public.job_events (id, job_id, event_type, detail_json, created_at)
VALUES
 ('8af00000-0000-4000-8000-0000000000a1', '8a000000-0000-4000-8000-0000000000a0', 'status_changed',
  '{"old_status":"schedule_install","new_status":"awaiting_supplier"}', '2026-09-24 06:50Z'),
 ('8af00000-0000-4000-8000-0000000000a2', '8a000000-0000-4000-8000-0000000000a0', 'status_changed',
  '{"old_status":"awaiting_supplier","new_status":"processing"}', '2026-09-24 06:58Z'),
 ('8af00000-0000-4000-8000-0000000000a3', '8a000000-0000-4000-8000-0000000000a0', 'status_changed',
  '{"old_status":"processing","new_status":"awaiting_supplier"}', '2026-09-30 01:00Z');

-- 8. one booking clocked on once and off twice 0.6 s apart with the same hours; another with two
-- real stints the same Perth day
INSERT INTO public.job_assignments (id, job_id, role, scheduled_date, assignment_type, status, crew_name, is_ghost, created_at)
VALUES ('8aa00000-0000-4000-8000-0000000000b1', '8a000000-0000-4000-8000-0000000000b0', 'lead_installer', '2026-09-24', 'install', 'scheduled',
        'Crew B', false, '2026-09-20 01:00Z'),
       ('8aa00000-0000-4000-8000-0000000000c1', '8a000000-0000-4000-8000-0000000000c0', 'lead_installer', '2026-09-25', 'install', 'scheduled',
        'Crew C', false, '2026-09-20 01:00Z');
INSERT INTO public.job_events (id, job_id, event_type, detail_json, created_at)
VALUES
 ('8af00000-0000-4000-8000-0000000000b1', '8a000000-0000-4000-8000-0000000000b0', 'clock.clock_on',
  '{"assignment_id":"8aa00000-0000-4000-8000-0000000000b1"}', '2026-09-24 00:59:02.211Z'),
 ('8af00000-0000-4000-8000-0000000000b2', '8a000000-0000-4000-8000-0000000000b0', 'clock.clock_off',
  '{"assignment_id":"8aa00000-0000-4000-8000-0000000000b1","net_hours":11.27}', '2026-09-24 12:14:38.568Z'),
 ('8af00000-0000-4000-8000-0000000000b3', '8a000000-0000-4000-8000-0000000000b0', 'clock.clock_off',
  '{"assignment_id":"8aa00000-0000-4000-8000-0000000000b1","net_hours":11.27}', '2026-09-24 12:14:39.193Z'),
 ('8af00000-0000-4000-8000-0000000000c2', '8a000000-0000-4000-8000-0000000000c0', 'clock.clock_off',
  '{"assignment_id":"8aa00000-0000-4000-8000-0000000000c1","net_hours":4}', '2026-09-25 03:00Z'),
 ('8af00000-0000-4000-8000-0000000000c3', '8a000000-0000-4000-8000-0000000000c0', 'clock.clock_off',
  '{"assignment_id":"8aa00000-0000-4000-8000-0000000000c1","net_hours":3.5}', '2026-09-25 08:00Z');
-- 9. an observer copy (a ghost row) whose crew the 5 Oct correction changed, and a crew booking whose
-- details changed
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, pricing_json, created_at, updated_at)
VALUES ('8a000000-0000-4000-8000-0000000000d0', '00000000-0000-4000-8000-0000000000aa', 'SWF-T81D0', 'scheduled', 'fencing', 'Update Client',
        '{}', '2026-09-01 01:00Z', '2026-10-05 09:04Z');
INSERT INTO public.job_assignments (id, job_id, role, scheduled_date, assignment_type, status, crew_name, is_ghost, created_at)
VALUES ('8aa00000-0000-4000-8000-0000000000d1', '8a000000-0000-4000-8000-0000000000d0', 'observer', '2026-10-01', 'install', 'scheduled',
        NULL, true, '2026-09-20 01:00Z'),
       ('8aa00000-0000-4000-8000-0000000000d2', '8a000000-0000-4000-8000-0000000000d0', 'lead_installer', '2026-10-02', 'install', 'scheduled',
        'Crew D', false, '2026-09-20 01:00Z');
INSERT INTO public.job_events (id, job_id, event_type, detail_json, created_at)
VALUES
 ('8af00000-0000-4000-8000-0000000000d1', '8a000000-0000-4000-8000-0000000000d0', 'assignment_updated',
  '{"date":"2026-10-01","change":"ghost moved from one crew to another","source":"ghost_watcher_correction_2026_10_05","assignment_id":"8aa00000-0000-4000-8000-0000000000d1"}',
  '2026-10-05 09:04:02Z'),
 ('8af00000-0000-4000-8000-0000000000d2', '8a000000-0000-4000-8000-0000000000d0', 'assignment_updated',
  '{"date":"2026-10-02","assignment_id":"8aa00000-0000-4000-8000-0000000000d2"}', '2026-10-05 10:00Z');
SET LOCAL session_replication_role = origin;

-- 1. A scope saved is scope_saved, never a site visit.
DO $scope$
DECLARE asof constant timestamptz := '2026-10-07 06:10Z'; got text;
BEGIN
 SELECT string_agg(t.kind || '@' || t.perth_date || '@' || t.source_table, ',' ORDER BY t.at, t.source_id COLLATE "C") INTO got
 FROM public.context_job_record_timeline(ARRAY['8a000000-0000-4000-8000-000000000001'::uuid], asof) t
 WHERE t.source_table IN ('job_events', 'visit_outcomes');
 PERFORM pg_temp.t1_assert(got IS NOT DISTINCT FROM 'scope_saved@2026-09-07@job_events,site_visit@2026-09-10@visit_outcomes',
  'a scope save is scope_saved, never a site visit, and a recorded visit stays one: ' || coalesce(got, '<none>'));
 PERFORM pg_temp.t1_assert((SELECT t.what FROM public.context_job_record_timeline(ARRAY['8a000000-0000-4000-8000-000000000001'::uuid], asof) t
   WHERE t.source_id = '8af00000-0000-4000-8000-000000000011') = 'Scope first saved in the scoping tool',
  'the scope save keeps its words');
END $scope$;

-- 2. Stamps written at the creation instant are no stage line.
DO $stamps$
DECLARE asof constant timestamptz := '2026-10-07 06:10Z'; got text; n integer;
BEGIN
 SELECT count(*) INTO n FROM public.context_job_record_timeline(ARRAY['8a000000-0000-4000-8000-000000000002'::uuid], asof) t
 WHERE t.time_basis = 'stamp';
 PERFORM pg_temp.t1_assert(n = 0, 'a stamp written at the job''s creation instant is no stage line: ' || n);
 SELECT t.what INTO got FROM public.context_job_record_timeline(ARRAY['8a000000-0000-4000-8000-000000000002'::uuid], asof) t
 WHERE t.kind = 'job_created';
 PERFORM pg_temp.t1_assert(got = 'Job created (fencing), its record already marked quoted, accepted and complete when it was made '
   || '(when it reached those stages is not recorded)', 'the job created line names the stages its record was made in: ' || coalesce(got, '<none>'));
 SELECT t.what INTO got FROM public.context_job_record_timeline(ARRAY['8a000000-0000-4000-8000-000000000004'::uuid], asof) t
 WHERE t.kind = 'job_created';
 PERFORM pg_temp.t1_assert(got = 'Job created (patio), its record already marked quoted when it was made (when it reached that stage is not recorded)',
  'one stage at creation reads in the singular: ' || coalesce(got, '<none>'));
 -- a stamp written 27 s after creation is a real change and stays; no words added to the job created line
 SELECT string_agg(t.kind || ':' || t.time_basis || ':' || t.what, ' | ' ORDER BY t.at, t.what COLLATE "C") INTO got
 FROM public.context_job_record_timeline(ARRAY['8a000000-0000-4000-8000-000000000003'::uuid], asof) t
 WHERE t.source_table = 'jobs';
 PERFORM pg_temp.t1_assert(got = 'job_created:observed:Job created (makesafe) | status:stamp:Job record stamp: entered processing '
   || '(the job row keeps only the last time it entered this stage)', 'a stamp after creation stays: ' || coalesce(got, '<none>'));
 SELECT t.what INTO got FROM public.context_job_record_timeline(ARRAY['8a000000-0000-4000-8000-000000000002'::uuid], asof) t
 WHERE t.kind = 'status' AND t.source_table = 'job_events';
 PERFORM pg_temp.t1_assert(got = 'Status set to final payment', 'the status change stays: ' || coalesce(got, '<none>'));
END $stamps$;

-- 3. An assignment record is no booking and dates no visit.
DO $record$
DECLARE asof constant timestamptz := '2026-10-07 06:10Z'; got text; r record;
BEGIN
 SELECT string_agg(t.kind || ':' || coalesce(t.state, '-') || ':' || coalesce(t.made_at::text, '-'), ',' ORDER BY t.kind COLLATE "C") INTO got
 FROM public.context_job_record_timeline(ARRAY['8a000000-0000-4000-8000-000000000003'::uuid], asof) t
 WHERE t.source_id = '8aa00000-0000-4000-8000-000000000032';
 PERFORM pg_temp.t1_assert(got = 'booking_record:-:-',
  'a dateless row made complete the moment it was made is one booking_record line, no state, no made_at, no attendance: ' || coalesce(got, '<none>'));
 SELECT t.what, t.at, t.time_basis INTO r FROM public.context_job_record_timeline(ARRAY['8a000000-0000-4000-8000-000000000003'::uuid], asof) t
 WHERE t.source_id = '8aa00000-0000-4000-8000-000000000032';
 PERFORM pg_temp.t1_assert(r.what = 'Assignment record with no booked date (install, complete), completed the moment it was made: '
   || 'not a crew booking, and it does not date a visit'
   AND r.at = '2026-09-29 07:54:07.773Z' AND r.time_basis = 'observed', 'the record says what it is: ' || coalesce(r.what, '<none>'));
 -- the dated booking marked complete keeps its booking and attendance lines
 SELECT string_agg(t.kind || ':' || coalesce(t.state, '-'), ',' ORDER BY t.kind COLLATE "C") INTO got
 FROM public.context_job_record_timeline(ARRAY['8a000000-0000-4000-8000-000000000003'::uuid], asof) t
 WHERE t.source_id = '8aa00000-0000-4000-8000-000000000031';
 PERFORM pg_temp.t1_assert(got = 'attendance:attended,booking:attended', 'a dated booking marked complete stays attended: ' || coalesce(got, '<none>'));
 -- a dateless booking that is not complete stays a booking
 SELECT t.kind || ':' || coalesce(t.state, '-') || ':' || t.what INTO got
 FROM public.context_job_record_timeline(ARRAY['8a000000-0000-4000-8000-000000000003'::uuid], asof) t
 WHERE t.source_id = '8aa00000-0000-4000-8000-000000000033';
 PERFORM pg_temp.t1_assert(got = 'booking:scheduled:Booking: install with no date set (shown when it was made), scheduled',
  'a dateless booking not complete stays a booking: ' || coalesce(got, '<none>'));
END $record$;

-- 4. First contact is never another job's message.
DO $first$
DECLARE asof constant timestamptz := '2026-10-07 06:10Z'; got text;
BEGIN
 SELECT string_agg(t.source_id, ',' ORDER BY t.source_id COLLATE "C") INTO got
 FROM public.context_job_record_timeline(ARRAY['8a000000-0000-4000-8000-000000000041'::uuid], asof) t WHERE t.kind = 'first_contact';
 PERFORM pg_temp.t1_assert(got = '8ae00000-0000-4000-8000-000000000413',
  'texts from before the job, while the person was a neighbour party on another open job, are never its first contact: ' || coalesce(got, '<none>'));
 SELECT t.what INTO got FROM public.context_job_record_timeline(ARRAY['8a000000-0000-4000-8000-000000000041'::uuid], asof) t WHERE t.kind = 'first_contact';
 PERFORM pg_temp.t1_assert(got = 'First message with the customer on record (sms, from us); 2 earlier messages with them are left out: they were '
   || 'sent while this person was a party on another open job', 'the first contact says what it left out: ' || coalesce(got, '<none>'));
 SELECT t.what INTO got FROM public.context_job_record_timeline(ARRAY['8a000000-0000-4000-8000-000000000051'::uuid], asof) t WHERE t.kind = 'first_contact';
 PERFORM pg_temp.t1_assert(got = 'First message with the customer on record (sms, from the customer)',
  'nothing left out, nothing said: ' || coalesce(got, '<none>'));
 SELECT string_agg(t.source_id, ',' ORDER BY t.source_id COLLATE "C") INTO got
 FROM public.context_job_record_timeline(ARRAY['8a000000-0000-4000-8000-000000000051'::uuid], asof) t WHERE t.kind = 'first_contact';
 PERFORM pg_temp.t1_assert(got = '8ae00000-0000-4000-8000-000000000511',
  'a message after the other job closed stays the first contact: ' || coalesce(got, '<none>'));
 SELECT string_agg(t.source_id, ',' ORDER BY t.source_id COLLATE "C") INTO got
 FROM public.context_job_record_timeline(ARRAY['8a000000-0000-4000-8000-000000000061'::uuid], asof) t WHERE t.kind = 'first_contact';
 PERFORM pg_temp.t1_assert(got = '8ae00000-0000-4000-8000-000000000611',
  'a repeat client''s own other job never takes their first contact: ' || coalesce(got, '<none>'));
 -- the job read together with the others gives the same answer
 SELECT string_agg(t.source_id, ',' ORDER BY t.source_id COLLATE "C") INTO got
 FROM public.context_job_record_timeline(ARRAY['8a000000-0000-4000-8000-000000000041', '8a000000-0000-4000-8000-000000000051',
   '8a000000-0000-4000-8000-000000000061', '8a000000-0000-4000-8000-000000000040']::uuid[], asof) t WHERE t.kind = 'first_contact';
 PERFORM pg_temp.t1_assert(got = '8ae00000-0000-4000-8000-000000000413,8ae00000-0000-4000-8000-000000000511,8ae00000-0000-4000-8000-000000000611',
  'first contact is per job when jobs are read together: ' || coalesce(got, '<none>'));
END $first$;

-- 5. Repair stage changes are lines.
DO $stages$
DECLARE asof constant timestamptz := '2026-10-07 06:10Z'; got text;
BEGIN
 SELECT string_agg(t.perth_date || ' ' || t.what, ' | ' ORDER BY t.at) INTO got
 FROM public.context_job_record_timeline(ARRAY['8a000000-0000-4000-8000-000000000080'::uuid], asof) t WHERE t.kind = 'repair_stage';
 PERFORM pg_temp.t1_assert(got = '2026-09-08 Repair stage set to scoping (from work order in) | 2026-09-23 Repair stage set to scheduled (from scoping) | '
   || '2026-10-01 Repair stage set to on site (from scheduled) | 2026-10-02 Repair stage set to complete (from on site) | '
   || '2026-10-05 Repair stage set to on site (from complete) | 2026-10-06 Repair stage set to complete (from on site)',
  'each repair stage change is a line with its from and to, a change to the same stage none: ' || coalesce(got, '<none>'));
 PERFORM pg_temp.t1_assert(NOT EXISTS (SELECT 1 FROM public.context_job_record_timeline(ARRAY['8a000000-0000-4000-8000-000000000080'::uuid], asof) t
   WHERE t.kind = 'repair_stage' AND (t.state IS NOT NULL OR t.time_basis <> 'observed' OR t.source_table <> 'job_events')),
  'a stage line cites its job event, observed, with no state');
END $stages$;

-- 6. A deleted invoice is deleted.
DO $deleted$
DECLARE asof constant timestamptz := '2026-10-07 06:10Z'; got text;
BEGIN
 SELECT string_agg(t.source_id || '=' || coalesce(t.state, '-'), ',' ORDER BY t.source_id COLLATE "C") INTO got
 FROM public.context_job_record_timeline(ARRAY['8a000000-0000-4000-8000-000000000090'::uuid], asof) t WHERE t.source_table = 'xero_invoices';
 PERFORM pg_temp.t1_assert(got = '8ac00000-0000-4000-8000-000000000091=deleted,8ac00000-0000-4000-8000-000000000092=voided,'
   || '8ac00000-0000-4000-8000-000000000093=deleted', 'a deleted invoice or bill is deleted, a voided one voided: ' || coalesce(got, '<none>'));
 PERFORM pg_temp.t1_assert((SELECT t.what FROM public.context_job_record_timeline(ARRAY['8a000000-0000-4000-8000-000000000090'::uuid], asof) t
   WHERE t.source_id = '8ac00000-0000-4000-8000-000000000091') LIKE '%: total $2,000.00, deleted in Xero (never counted)',
  'the deleted invoice keeps its words');
END $deleted$;

-- 7. A status fold names where it started.
DO $fold$
DECLARE asof constant timestamptz := '2026-10-07 06:10Z'; got text;
BEGIN
 SELECT string_agg(t.what, ' | ' ORDER BY t.at) INTO got
 FROM public.context_job_record_timeline(ARRAY['8a000000-0000-4000-8000-0000000000a0'::uuid], asof) t WHERE t.kind = 'status';
 PERFORM pg_temp.t1_assert(got = 'Status changed 2 times within minutes: schedule install -> awaiting supplier -> processing; it ended at processing'
   || ' | Status set to awaiting supplier (from processing)', 'a fold of changes shows every from and to: ' || coalesce(got, '<none>'));
END $fold$;

-- 8. A clock-off submitted twice is one stint.
DO $clock$
DECLARE asof constant timestamptz := '2026-10-07 06:10Z'; got text;
BEGIN
 SELECT t.what INTO got FROM public.context_job_record_timeline(ARRAY['8a000000-0000-4000-8000-0000000000b0'::uuid], asof) t
 WHERE t.state = 'clock.clock_off';
 PERFORM pg_temp.t1_assert(got = 'Crew clocked off for the Thu 24 Sep 2026 booking (11.27 hours net); recorded 2 times that day, first at 20:14',
  'a clock-off sent again within a minute with the same hours is one stint: ' || coalesce(got, '<none>'));
 SELECT t.what INTO got FROM public.context_job_record_timeline(ARRAY['8a000000-0000-4000-8000-0000000000c0'::uuid], asof) t
 WHERE t.state = 'clock.clock_off';
 PERFORM pg_temp.t1_assert(got = 'Crew clocked off for the Fri 25 Sep 2026 booking (7.5 hours net that day, all stints added); recorded 2 times that day, first at 11:00',
  'two real stints still add up: ' || coalesce(got, '<none>'));
END $clock$;

-- 9. A booking row's details changed is a line.
DO $updated$
DECLARE asof constant timestamptz := '2026-10-07 06:10Z'; got text;
BEGIN
 SELECT string_agg(t.kind || ':' || coalesce(t.state, '-') || ':' || t.perth_date || ':' || t.what, ' | ' ORDER BY t.at) INTO got
 FROM public.context_job_record_timeline(ARRAY['8a000000-0000-4000-8000-0000000000d0'::uuid], asof) t WHERE t.source_table = 'job_events';
 PERFORM pg_temp.t1_assert(got = 'booking_mirror:-:2026-10-05:Observer copy, not a crew booking: Booking record updated (booked Thu 1 Oct 2026)'
   || ' | booking_change:-:2026-10-05:Booking record updated (booked Fri 2 Oct 2026)',
  'a booking row''s details changed is a line, an observer copy''s a booking_mirror: ' || coalesce(got, '<none>'));
END $updated$;
ROLLBACK;

-- 10. Shape.
DO $shape$
DECLARE p record; f constant text := 'public.context_job_record_timeline(uuid[],timestamptz)';
BEGIN
 SELECT pr.prosecdef, pr.provolatile, pr.proconfig, obj_description(pr.oid, 'pg_proc') AS c INTO p FROM pg_proc pr WHERE pr.oid = to_regprocedure(f);
 PERFORM pg_temp.t1_assert(p.prosecdef AND p.provolatile = 's' AND p.proconfig = ARRAY['search_path=public, pg_temp'],
  'the timeline stays a stable definer with search_path public, pg_temp');
 PERFORM pg_temp.t1_assert(p.c LIKE 'Job record (20261006011000), story fixes (20261006033000), story safety (20261006040000): (record timeline T1, 20261008090000) %',
  'the comment keeps the slice name first and names this slice');
 PERFORM pg_temp.t1_assert(has_function_privilege('service_role', f, 'EXECUTE') AND NOT has_function_privilege('anon', f, 'EXECUTE')
   AND NOT has_function_privilege('authenticated', f, 'EXECUTE'), 'service role only');
 PERFORM pg_temp.t1_assert(NOT EXISTS (SELECT 1 FROM pg_proc pp, aclexplode(coalesce(pp.proacl, acldefault('f', pp.proowner))) a
   WHERE pp.oid = to_regprocedure(f) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'), 'not executable by PUBLIC');
END $shape$;

-- 11. Re-applying the migration changes nothing (its guard accepts its own body).
BEGIN;
CREATE TEMP TABLE t1_before AS
 SELECT md5(p.prosrc) AS m, obj_description(p.oid, 'pg_proc') AS c, p.proacl::text AS acl
 FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_job_record_timeline(uuid[],timestamptz)');
\ir ../../../migrations/20261008090000_context_record_timeline_t1.sql
DO $again$
BEGIN
 PERFORM pg_temp.t1_assert(EXISTS (SELECT 1 FROM t1_before b, pg_proc p
   WHERE p.oid = to_regprocedure('public.context_job_record_timeline(uuid[],timestamptz)')
     AND md5(p.prosrc) = b.m AND obj_description(p.oid, 'pg_proc') = b.c AND p.proacl::text = b.acl), 'a re-apply must change nothing');
END $again$;
ROLLBACK;
