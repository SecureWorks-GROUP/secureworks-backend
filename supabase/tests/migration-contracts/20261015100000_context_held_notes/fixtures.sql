-- Fixtures for the held notes contract (included by contract.sql inside its transactions).
-- Robin has two fence jobs, A and B; C is another customer's job.
SELECT pg_temp.hn_job('7f000000-0000-4000-8000-0000000000a1', 'SWF-970001', '2026-09-01 00:00Z');
SELECT pg_temp.hn_job('7f000000-0000-4000-8000-0000000000b1', 'SWF-970002', '2026-09-20 00:00Z');
INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, client_email, ghl_contact_id, site_suburb, metadata, created_at)
VALUES ('7f000000-0000-4000-8000-0000000000c1', '00000000-0000-0000-0000-000000000001', 'scheduled', 'fencing', 'SWF-970003', 'Sam Onejob',
 'sam.onejob@example.test', 'hn-ct-sam', 'Testville', '{}', '2026-09-01 00:00Z');
-- P: a text placed on A
SELECT pg_temp.hn_ev('7fb00000-0000-4000-8000-000000000001', '7f000000-0000-4000-8000-0000000000a1', 'client.sms_in', 'sms', 'inbound',
 'Can you confirm the gate width please', '2026-10-05 01:00Z', NULL, '{}', 'ghl:hn-01');
-- H: a call transcript held on no job, A and B its candidates; the promise exists only here
SELECT pg_temp.hn_ev('7fb00000-0000-4000-8000-000000000002', NULL, 'call.transcript_completed', 'call', 'inbound',
 'Robin said the rear is very windy. We will tell the crew to add extra concrete at the windy rear corner.', '2026-10-06 02:00Z',
 ARRAY['7f000000-0000-4000-8000-0000000000a1', '7f000000-0000-4000-8000-0000000000b1']::uuid[],
 '{"ghl_call_id":"hn-ct-robin:2026-10-06T02:00:00.000Z"}', 'ghltx:hn-02');
-- H2: our text held on no job; C2, a copy of it, sits placed on B
SELECT pg_temp.hn_ev('7fb00000-0000-4000-8000-000000000003', NULL, 'client.sms_out', 'sms', 'outbound',
 'We will send the photos tomorrow.', '2026-10-06 03:00Z',
 ARRAY['7f000000-0000-4000-8000-0000000000a1', '7f000000-0000-4000-8000-0000000000b1']::uuid[], '{}', 'ghl:hn-03');
SELECT pg_temp.hn_ev('7fb00000-0000-4000-8000-000000000004', '7f000000-0000-4000-8000-0000000000b1', 'client.sms_out', 'sms', 'outbound',
 'We will send the photos tomorrow.', '2026-10-06 03:00:30Z', NULL, '{}', 'ghl:hn-04');
-- H3: a transcript held on no job whose call row K3 is placed on B
SELECT pg_temp.hn_ev('7fb00000-0000-4000-8000-000000000005', NULL, 'call.transcript_completed', 'call', 'outbound',
 'Thanks Robin, I can drop the spare gate off on Friday.', '2026-10-06 04:00Z',
 ARRAY['7f000000-0000-4000-8000-0000000000a1', '7f000000-0000-4000-8000-0000000000b1']::uuid[], '{"ghl_call_id":"hn-call-3"}', 'ghltx:hn-call-3');
SELECT pg_temp.hn_ev('7fb00000-0000-4000-8000-000000000006', '7f000000-0000-4000-8000-0000000000b1', 'client.call_logged', 'call', 'outbound',
 'Outbound call, 2 minutes', '2026-10-06 04:00Z', NULL, '{}', 'ghl:hn-call-3');
-- the reader's lane on, in shadow, as the ledger store contracts set it
UPDATE public.automation_switches SET capture = true, attribution = true, extraction = true, all_stop = false WHERE id = 1;
UPDATE public.context_ledger_settings SET mode = 'shadow', calls_per_day = 50, reader = 'luna-ledger:v1', job_ids = NULL;
