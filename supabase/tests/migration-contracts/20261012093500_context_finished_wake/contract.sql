-- Contract for 20261012093500_context_finished_wake: the owner's ruling of 12 Oct 2026 (decision D5).
-- A finished job (cancelled, archived, complete, completed or lost) is read again while it has a
-- real inbound message of its customer's inside 30 days. Failing first: section 1 runs first and
-- reads only the rule (context_lead_monitored_jobs), which exists before this migration, and fails
-- on its earlier body (break-contract.sql runs this migration's rollback and expects section 1's
-- first check to fail).
--  1. The rule, as of a fixed instant (Mon 12 Oct 2026 10:00 Perth): a finished job is awake while
--     the instant is inside 30 days after its customer's newest real inbound message on the job (a
--     text, an email, a call, their old-inbox mail from the client's address), in every finished
--     status; never for our own text, a workflow text, a supplier's mail, a staff member's or our
--     own address's inbound mail, a marked copy, a message on the customer's other job, or a holding
--     job; the window's edges (30 days to the instant is quiet, an hour inside is awake); a finished
--     job's monitored is true as before; a quiet finished job's row is what it always was
--     (not_quoted, no customer_at); a live job's row is unchanged; with no ids only the awake
--     finished jobs are listed; the one-job form is the same row; earlier and later instants.
--  2. The ledger (instants relative to now, since the judge judges now): an awake finished job never
--     read is due a backfill and claimed; one with a reading and a newer customer message is due an
--     update; a quiet one is not_live and a claim answers not_due; a holding job is never live; the
--     rollout list and the mode still decide.
--  3. The story is unchanged: a finished job, awake or quiet, keeps now.monitored true and is never
--     called a lead not followed up.
--  4. The scorecard: live_jobs and monitored_jobs count an awake finished job, never a quiet one; the
--     per-job page lists it.
--  5. The wake function: its number, flags and access.
--  6. Shape and access of the replaced bodies: flags, grants, the rule's columns, slice names first.
--  7. Re-applying changes nothing.
--  8. The service role reads the rule directly with finished jobs in the set, in a fresh session with
--     the table grants production has.
-- Every fixture row is synthetic and rolled back; user triggers are off for it, and the column
-- defaults that would stamp the wall clock are pinned inside each fixture transaction. The jobs are
-- shaped as SWF-261469 and SWF-261334 were: a fence installed, a customer disputing the work by text,
-- email and call after the job was closed.

-- 1 shares these fixtures (fixed instant 2026-10-12 02:00Z).
BEGIN;
SET LOCAL session_replication_role = replica;
ALTER TABLE public.business_events ALTER COLUMN context_captured_at SET DEFAULT '2026-07-01 00:00Z',
 ALTER COLUMN recorded_at SET DEFAULT '2026-07-01 00:00Z', ALTER COLUMN occurred_at SET DEFAULT '2026-07-01 00:00Z';
ALTER TABLE public.jobs ALTER COLUMN created_at SET DEFAULT '2026-07-01 00:00Z', ALTER COLUMN updated_at SET DEFAULT '2026-07-01 00:00Z';
ALTER TABLE public.inbox_events ALTER COLUMN received_at SET DEFAULT '2026-07-01 00:00Z';

INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, client_email, ghl_contact_id, pricing_json, metadata, created_at, updated_at)
VALUES
 -- archived the day after the customer's complaint, their text 3 days ago (one); their text 30 days
 -- ago to the instant (two); their text 29 days 23 hours ago (three)
 ('9b000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000aa', 'SWF-98001', 'archived', 'fencing', 'Wake One', NULL, 'ct9801', '{}', '{}', '2026-08-01 02:00Z', '2026-10-10 02:00Z'),
 ('9b000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000aa', 'SWF-98002', 'archived', 'fencing', 'Wake Two', NULL, 'ct9802', '{}', '{}', '2026-08-01 02:00Z', '2026-09-13 02:00Z'),
 ('9b000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000aa', 'SWF-98003', 'archived', 'fencing', 'Wake Three', NULL, 'ct9803', '{}', '{}', '2026-08-01 02:00Z', '2026-09-13 02:00Z'),
 -- cancelled, only our own text 2 days ago (four); complete, a workflow text and a supplier's mail 2
 -- days ago (five); complete, the customer's email 5 days ago (six); lost, the customer's call
 -- yesterday (seven)
 ('9b000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-0000000000aa', 'SWF-98004', 'cancelled', 'fencing', 'Wake Four', NULL, 'ct9804', '{}', '{}', '2026-08-01 02:00Z', '2026-09-01 02:00Z'),
 ('9b000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-0000000000aa', 'SWF-98005', 'complete', 'fencing', 'Wake Five', 'w5@example.test', 'ct9805', '{}', '{}', '2026-08-01 02:00Z', '2026-09-01 02:00Z'),
 ('9b000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-0000000000aa', 'SWF-98006', 'complete', 'fencing', 'Wake Six', 'w6@example.test', 'ct9806', '{}', '{}', '2026-08-01 02:00Z', '2026-09-01 02:00Z'),
 ('9b000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-0000000000aa', 'SWP-98007', 'lost', 'patio', 'Wake Seven', NULL, 'ct9807', '{}', '{}', '2026-08-01 02:00Z', '2026-09-01 02:00Z'),
 -- archived: mail from one of our own addresses, a crew member's inbound text and a marked copy of
 -- the customer's text, all 2 days ago (eight); a holding job the customer texted yesterday (nine);
 -- the customer's old-inbox mail from the client's address 4 days ago (ten)
 ('9b000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-0000000000aa', 'SWF-98008', 'archived', 'fencing', 'Wake Eight', 'w8@example.test', 'ct9808', '{}', '{}', '2026-08-01 02:00Z', '2026-09-01 02:00Z'),
 ('9b000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-0000000000aa', 'SWF-98009', 'archived', 'fencing', 'Wake Nine', NULL, 'ct9809', '{}', '{"do_not_schedule":"true"}', '2026-08-01 02:00Z', '2026-09-01 02:00Z'),
 ('9b000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-0000000000aa', 'SWF-98010', 'archived', 'fencing', 'Wake Ten', 'w10@example.test', 'ct9810', '{}', '{}', '2026-08-01 02:00Z', '2026-09-01 02:00Z'),
 -- one customer, two jobs: an archived one with nothing on it (eleven) and a live one their text of 2
 -- days ago is on (twelve)
 ('9b000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-0000000000aa', 'SWF-98011', 'archived', 'fencing', 'Wake Eleven', NULL, 'ct9811', '{}', '{}', '2026-08-01 02:00Z', '2026-09-01 02:00Z'),
 ('9b000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-0000000000aa', 'SWF-98012', 'accepted', 'fencing', 'Wake Eleven', NULL, 'ct9811', '{}', '{}', '2026-09-20 02:00Z', '2026-09-20 02:00Z'),
 -- archived with no message at all (thirteen)
 ('9b000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-0000000000aa', 'SWF-98013', 'archived', 'fencing', 'Wake Thirteen', NULL, 'ct9813', '{}', '{}', '2026-08-01 02:00Z', '2026-09-01 02:00Z');
UPDATE public.jobs SET accepted_at = '2026-09-21 02:00Z' WHERE id = '9b000000-0000-4000-8000-000000000012';

INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  context_captured_at, attribution_status, attribution_confidence, candidate_job_ids)
VALUES
 -- one: the customer disputes the work 3 days ago, and an older text of theirs
 ('9b0b0000-0000-4000-8000-000000000011', '9b000000-0000-4000-8000-000000000001', 'client.reply', 'ghl', 'sms', 'inbound', 'ct9801',
  '{"body":"The plinths are not set below the paving as quoted"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
  '2026-10-09 02:00Z', '2026-10-09 02:00Z', '2026-10-09 02:00Z', '2026-10-09 02:00Z', 'direct', 1, NULL),
 ('9b0b0000-0000-4000-8000-000000000012', '9b000000-0000-4000-8000-000000000001', 'client.reply', 'ghl', 'sms', 'inbound', 'ct9801',
  '{"body":"When is the install?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
  '2026-08-20 02:00Z', '2026-08-20 02:00Z', '2026-08-20 02:00Z', '2026-08-20 02:00Z', 'direct', 1, NULL),
 -- two: 30 days to the instant; three: an hour inside
 ('9b0b0000-0000-4000-8000-000000000021', '9b000000-0000-4000-8000-000000000002', 'client.reply', 'ghl', 'sms', 'inbound', 'ct9802',
  '{"body":"Thanks, the fence looks good"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
  '2026-09-12 02:00Z', '2026-09-12 02:00Z', '2026-09-12 02:00Z', '2026-09-12 02:00Z', 'direct', 1, NULL),
 ('9b0b0000-0000-4000-8000-000000000031', '9b000000-0000-4000-8000-000000000003', 'client.reply', 'ghl', 'sms', 'inbound', 'ct9803',
  '{"body":"Thanks, the fence looks good"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
  '2026-09-12 03:00Z', '2026-09-12 03:00Z', '2026-09-12 03:00Z', '2026-09-12 03:00Z', 'direct', 1, NULL),
 -- four: our own text to the customer 2 days ago
 ('9b0b0000-0000-4000-8000-000000000041', '9b000000-0000-4000-8000-000000000004', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ct9804',
  '{"body":"Sorry to hear you are not going ahead"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff","recipient_role":"customer","audience":"customer"}}',
  '2026-10-10 02:00Z', '2026-10-10 02:00Z', '2026-10-10 02:00Z', '2026-10-10 02:00Z', 'direct', 1, NULL),
 -- five: a workflow text of ours and a supplier's inbound mail, both 2 days ago
 ('9b0b0000-0000-4000-8000-000000000051', '9b000000-0000-4000-8000-000000000005', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ct9805',
  '{"body":"How did we go? Leave us a review","sent_by_kind":"workflow"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff","audience":"customer"}}',
  '2026-10-10 02:00Z', '2026-10-10 02:00Z', '2026-10-10 02:00Z', '2026-10-10 02:00Z', 'direct', 1, NULL),
 ('9b0b0000-0000-4000-8000-000000000052', '9b000000-0000-4000-8000-000000000005', 'supplier.email_in', 'outlook-mail-capture', 'email', 'inbound', NULL,
  '{"body":"Invoice attached for the sheets","from":"accounts@supplier.example.test","subject":"Invoice"}',
  '{"party_roles":{"counterpart_role":"supplier","sender_role":"supplier","audience":"supplier"}}',
  '2026-10-10 02:00Z', '2026-10-10 02:00Z', '2026-10-10 02:00Z', '2026-10-10 02:00Z', 'direct', 1, NULL),
 -- six: the customer's email from the client's address 5 days ago
 ('9b0b0000-0000-4000-8000-000000000061', '9b000000-0000-4000-8000-000000000006', 'client.email_in', 'outlook-mail-capture', 'email', 'inbound', NULL,
  '{"body":"Three panels are loose near the letterbox, photos attached","from":"w6@example.test","subject":"Fence defects"}',
  '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
  '2026-10-07 02:00Z', '2026-10-07 02:00Z', '2026-10-07 02:00Z', '2026-10-07 02:00Z', 'direct', 1, NULL),
 -- seven: the customer's call yesterday
 ('9b0b0000-0000-4000-8000-000000000071', '9b000000-0000-4000-8000-000000000007', 'client.call_logged', 'ghl', 'call', 'inbound', 'ct9807',
  '{"body":"Inbound call. Provider status: completed","call_status":"completed"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
  '2026-10-11 02:00Z', '2026-10-11 02:00Z', '2026-10-11 02:00Z', '2026-10-11 02:00Z', 'direct', 1, NULL),
 -- eight: inbound mail from one of our own addresses, a crew member's inbound text, and a marked
 -- copy of a customer text, all 2 days ago
 ('9b0b0000-0000-4000-8000-000000000081', '9b000000-0000-4000-8000-000000000008', 'client.email_in', 'outlook-mail-capture', 'email', 'inbound', NULL,
  '{"body":"Forwarding the customer file","from":"sales@secureworkswa.com.au","subject":"Fwd: fence"}',
  '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
  '2026-10-10 02:00Z', '2026-10-10 02:00Z', '2026-10-10 02:00Z', '2026-10-10 02:00Z', 'direct', 1, NULL),
 ('9b0b0000-0000-4000-8000-000000000082', '9b000000-0000-4000-8000-000000000008', 'client.reply', 'ghl', 'sms', 'inbound', 'ctCrew98',
  '{"body":"On site now"}', '{"party_roles":{"counterpart_role":"crew","sender_role":"crew","audience":"internal"}}',
  '2026-10-10 02:00Z', '2026-10-10 02:00Z', '2026-10-10 02:00Z', '2026-10-10 02:00Z', 'direct', 1, NULL),
 ('9b0b0000-0000-4000-8000-000000000083', '9b000000-0000-4000-8000-000000000008', 'client.reply', 'ghl', 'sms', 'inbound', 'ct9808',
  '{"body":"Still waiting on the fix"}', '{"duplicate_of":"9b0b0000-0000-4000-8000-0000000000ff","party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
  '2026-10-10 02:00Z', '2026-10-10 02:00Z', '2026-10-10 02:00Z', '2026-10-10 02:00Z', 'direct', 1, NULL),
 -- nine: the customer's text yesterday, on a holding job
 ('9b0b0000-0000-4000-8000-000000000091', '9b000000-0000-4000-8000-000000000009', 'client.reply', 'ghl', 'sms', 'inbound', 'ct9809',
  '{"body":"Any update?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
  '2026-10-11 02:00Z', '2026-10-11 02:00Z', '2026-10-11 02:00Z', '2026-10-11 02:00Z', 'direct', 1, NULL),
 -- twelve: the customer's text 2 days ago, on their live job (never on eleven)
 ('9b0b0000-0000-4000-8000-000000000121', '9b000000-0000-4000-8000-000000000012', 'client.reply', 'ghl', 'sms', 'inbound', 'ct9811',
  '{"body":"Can we bring the second fence forward?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
  '2026-10-10 02:00Z', '2026-10-10 02:00Z', '2026-10-10 02:00Z', '2026-10-10 02:00Z', 'direct', 1, NULL);

INSERT INTO public.inbox_events (id, job_id, mailbox, from_email, from_name, subject, body_preview, received_at, processed_at, classification, graph_message_id)
VALUES
 -- ten: the customer's old-inbox mail from the client's address, placed on the job, 4 days ago
 ('9b0c0000-0000-4000-8000-000000000101', '9b000000-0000-4000-8000-000000000010', 'admin@secureworkswa.com.au', 'w10@example.test', 'Wake Ten',
  'Fence not as quoted', 'The front run is the wrong height', '2026-10-08 02:00Z', '2026-10-08 02:01Z', 'client', 'gm-98101');

-- 1. The rule, as of each instant.
DO $rule$
DECLARE asof constant timestamptz := '2026-10-12 02:00Z'; got text; want text; r record; o record;
 ids constant uuid[] := ARRAY['9b000000-0000-4000-8000-000000000001', '9b000000-0000-4000-8000-000000000002', '9b000000-0000-4000-8000-000000000003',
   '9b000000-0000-4000-8000-000000000004', '9b000000-0000-4000-8000-000000000005', '9b000000-0000-4000-8000-000000000006',
   '9b000000-0000-4000-8000-000000000007', '9b000000-0000-4000-8000-000000000008', '9b000000-0000-4000-8000-000000000009',
   '9b000000-0000-4000-8000-000000000010', '9b000000-0000-4000-8000-000000000011', '9b000000-0000-4000-8000-000000000012',
   '9b000000-0000-4000-8000-000000000013']::uuid[];
BEGIN
 -- (fails first on the earlier rule: every finished job reads not_quoted with no customer_at)
 SELECT string_agg(concat_ws(' ', m.job_number, m.monitored::text, m.state,
                             coalesce(to_char(m.customer_at AT TIME ZONE 'UTC', 'MM-DD HH24:MI'), '-'), coalesce(to_char(m.cutoff_at AT TIME ZONE 'UTC', 'MM-DD HH24:MI'), '-')),
                   E'\n' ORDER BY m.job_number COLLATE "C") INTO got
 FROM public.context_lead_monitored_jobs(ids, asof) m;
 want := concat_ws(E'\n',
  'SWF-98001 true finished_awake 10-09 02:00 11-08 02:00',
  'SWF-98002 true not_quoted - -',
  'SWF-98003 true finished_awake 09-12 03:00 10-12 03:00',
  'SWF-98004 true not_quoted - -',
  'SWF-98005 true not_quoted - -',
  'SWF-98006 true finished_awake 10-07 02:00 11-06 02:00',
  'SWF-98008 true not_quoted - -',
  'SWF-98009 true not_quoted - -',
  'SWF-98010 true finished_awake 10-08 02:00 11-07 02:00',
  'SWF-98011 true not_quoted - -',
  'SWF-98012 true not_quoted - -',
  'SWF-98013 true not_quoted - -',
  'SWP-98007 true finished_awake 10-11 02:00 11-10 02:00');
 IF got IS DISTINCT FROM want THEN
  RAISE EXCEPTION 'finished wake contract: the rule as of Mon 12 Oct 2026 10:00 Perth: %', E'\n' || got;
 END IF;
 -- with no ids: the awake finished jobs and the live job are listed, a quiet finished job never
 SELECT string_agg(m.job_number || ' ' || m.state, ', ' ORDER BY m.job_number COLLATE "C") INTO got
 FROM public.context_lead_monitored_jobs(NULL, asof) m WHERE m.job_number LIKE 'SW_-980%';
 IF got IS DISTINCT FROM 'SWF-98001 finished_awake, SWF-98003 finished_awake, SWF-98006 finished_awake, SWF-98010 finished_awake, SWF-98012 not_quoted, SWP-98007 finished_awake' THEN
  RAISE EXCEPTION 'finished wake contract: the rule''s list with no ids: %', got;
 END IF;
 -- the one-job form is the set form's row
 SELECT * INTO r FROM public.context_lead_monitored_jobs(ARRAY['9b000000-0000-4000-8000-000000000001'::uuid], asof);
 SELECT * INTO o FROM public.context_lead_monitored('9b000000-0000-4000-8000-000000000001', asof);
 IF o IS DISTINCT FROM r OR o.state IS DISTINCT FROM 'finished_awake' THEN
  RAISE EXCEPTION 'finished wake contract: the one-job form: % against %', row_to_json(o), row_to_json(r);
 END IF;
 -- before the customer's dispute the job was quiet (its older text was 49 days before that instant)...
 SELECT * INTO r FROM public.context_lead_monitored_jobs(ARRAY['9b000000-0000-4000-8000-000000000001'::uuid], '2026-10-08 02:00Z');
 IF r.state IS DISTINCT FROM 'not_quoted' OR r.monitored IS DISTINCT FROM true OR r.cutoff_at IS NOT NULL THEN
  RAISE EXCEPTION 'finished wake contract: quiet before the customer wrote: %', row_to_json(r);
 END IF;
 -- ...awake up to the hour before the 30 days run out, quiet at the hour they do
 SELECT * INTO r FROM public.context_lead_monitored_jobs(ARRAY['9b000000-0000-4000-8000-000000000001'::uuid], '2026-11-08 01:00Z');
 IF r.state IS DISTINCT FROM 'finished_awake' OR r.cutoff_at IS DISTINCT FROM '2026-11-08 02:00Z'::timestamptz THEN
  RAISE EXCEPTION 'finished wake contract: awake an hour before the window ends: %', row_to_json(r);
 END IF;
 SELECT * INTO r FROM public.context_lead_monitored_jobs(ARRAY['9b000000-0000-4000-8000-000000000001'::uuid], '2026-11-08 02:00Z');
 IF r.state IS DISTINCT FROM 'not_quoted' OR r.monitored IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'finished wake contract: quiet when the window ends: %', row_to_json(r);
 END IF;
 IF EXISTS (SELECT 1 FROM public.context_lead_monitored_jobs(NULL, '2026-11-08 02:00Z') m WHERE m.job_number = 'SWF-98001') THEN
  RAISE EXCEPTION 'finished wake contract: a finished job whose window has run out is not listed';
 END IF;
END $rule$;
ROLLBACK;

-- 2. The ledger. The judge judges now, so these fixtures are placed relative to now; the ledger is in
-- shadow mode with a rollout list for the first checks.
BEGIN;
SET LOCAL session_replication_role = replica;
ALTER TABLE public.business_events ALTER COLUMN context_captured_at SET DEFAULT now() - interval '90 days',
 ALTER COLUMN recorded_at SET DEFAULT now() - interval '90 days';
UPDATE public.automation_switches SET capture = true, attribution = true, extraction = true, all_stop = false WHERE id = 1;
UPDATE public.context_ledger_settings SET mode = 'shadow', backfill_from_hour = NULL, backfill_to_hour = NULL,
 job_ids = ARRAY['9b000000-0000-4000-8000-000000000101', '9b000000-0000-4000-8000-000000000102', '9b000000-0000-4000-8000-000000000103',
                 '9b000000-0000-4000-8000-000000000104', '9b000000-0000-4000-8000-000000000105']::uuid[]
WHERE id;
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, ghl_contact_id, pricing_json, metadata, created_at, updated_at)
VALUES ('9b000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-0000000000aa', 'SWF-98101', 'archived', 'fencing', 'Ledger A', 'ct98101', '{}', '{}', now() - interval '90 days', now() - interval '1 day'),
       ('9b000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-0000000000aa', 'SWF-98102', 'archived', 'fencing', 'Ledger Q', 'ct98102', '{}', '{}', now() - interval '90 days', now() - interval '40 days'),
       ('9b000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-0000000000aa', 'SWF-98103', 'complete', 'fencing', 'Ledger U', 'ct98103', '{}', '{}', now() - interval '90 days', now() - interval '20 days'),
       ('9b000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-0000000000aa', 'SWF-98104', 'archived', 'fencing', 'Ledger H', 'ct98104', '{}', '{"do_not_schedule":"true"}', now() - interval '90 days', now() - interval '40 days'),
       ('9b000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-0000000000aa', 'SWF-98105', 'cancelled', 'fencing', 'Ledger C', 'ct98105', '{}', '{}', now() - interval '90 days', now() - interval '40 days'),
       ('9b000000-0000-4000-8000-000000000106', '00000000-0000-4000-8000-0000000000aa', 'SWF-98106', 'lost', 'fencing', 'Ledger R', 'ct98106', '{}', '{}', now() - interval '90 days', now() - interval '40 days');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  context_captured_at, attribution_status, attribution_confidence)
SELECT x.id::uuid, x.job::uuid, x.kind, 'ghl', 'sms', x.dir, x.ct, jsonb_build_object('body', x.body),
       CASE WHEN x.dir = 'inbound' THEN '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}'::jsonb
            ELSE '{"party_roles":{"counterpart_role":"customer","sender_role":"staff","recipient_role":"customer","audience":"customer"}}'::jsonb END,
       now() - x.ago, now() - x.ago, now() - x.ago, now() - x.ago, 'direct', 1
FROM (VALUES ('9b0b0000-0000-4000-8000-000000000101', '9b000000-0000-4000-8000-000000000101', 'client.reply', 'inbound', 'ct98101', 'The plinths are too high, can you come back and fix it?', interval '3 days'),
             ('9b0b0000-0000-4000-8000-000000000102', '9b000000-0000-4000-8000-000000000102', 'client.reply', 'inbound', 'ct98102', 'Thanks for the fence', interval '45 days'),
             ('9b0b0000-0000-4000-8000-000000000103', '9b000000-0000-4000-8000-000000000103', 'client.reply', 'inbound', 'ct98103', 'When is the install?', interval '60 days'),
             ('9b0b0000-0000-4000-8000-000000000113', '9b000000-0000-4000-8000-000000000103', 'client.reply', 'inbound', 'ct98103', 'A panel has come loose near the gate', interval '2 days'),
             ('9b0b0000-0000-4000-8000-000000000104', '9b000000-0000-4000-8000-000000000104', 'client.reply', 'inbound', 'ct98104', 'Any update?', interval '1 day'),
             ('9b0b0000-0000-4000-8000-000000000105', '9b000000-0000-4000-8000-000000000105', 'client.sms_out', 'outbound', 'ct98105', 'Sorry to hear you are not going ahead', interval '2 days'),
             ('9b0b0000-0000-4000-8000-000000000106', '9b000000-0000-4000-8000-000000000106', 'client.reply', 'inbound', 'ct98106', 'Actually, could you requote?', interval '1 day')
     ) x(id, job, kind, dir, ct, body, ago);
-- the complete job was read 20 days ago, before the customer's newer text
INSERT INTO public.context_ledger_generations (job_id, kind, status, reader, evidence_until, promoted_at, created_at, finished_at, updated_at, checks)
SELECT '9b000000-0000-4000-8000-000000000103', 'backfill', 'live', (SELECT st.reader FROM public.context_ledger_settings st WHERE st.id),
       now() - interval '20 days', now() - interval '20 days', now() - interval '20 days', now() - interval '20 days', now() - interval '20 days',
       '{"passed": true, "store": {"pass": true}}';
DO $ledger$
DECLARE r record; c jsonb; due text;
 six constant uuid[] := ARRAY['9b000000-0000-4000-8000-000000000101', '9b000000-0000-4000-8000-000000000102', '9b000000-0000-4000-8000-000000000103',
   '9b000000-0000-4000-8000-000000000104', '9b000000-0000-4000-8000-000000000105', '9b000000-0000-4000-8000-000000000106']::uuid[];
BEGIN
 -- the judgement, job by job (fails on the earlier judge: every finished job not_live)
 FOR r IN SELECT d.*, jb.job_number FROM public.context_ledger_judge(six) d JOIN public.jobs jb ON jb.id = d.job_id LOOP
  -- (the CASE sits in parentheses: PL/pgSQL reads an IF condition up to its first THEN outside them)
  IF NOT coalesce((CASE r.job_number
     -- archived, the customer's text 3 days ago, never read: a backfill
     WHEN 'SWF-98101' THEN r.due AND r.kind = 'backfill' AND r.reason = 'never_read' AND r.blocked_reason IS NULL AND r.evidence_rows = 1
     -- archived, the customer's last text 45 days ago: not live, as before
     WHEN 'SWF-98102' THEN NOT r.due AND r.blocked_reason = 'not_live'
     -- complete, read 20 days ago, the customer's text 2 days ago: an update
     WHEN 'SWF-98103' THEN r.due AND r.kind = 'update' AND r.reason = 'new_evidence' AND r.blocked_reason IS NULL
     -- a holding job is never woken; a cancelled job with only our own text is not live
     WHEN 'SWF-98104' THEN NOT r.due AND r.blocked_reason = 'not_live'
     WHEN 'SWF-98105' THEN NOT r.due AND r.blocked_reason = 'not_live'
     -- an awake finished job off the rollout list
     WHEN 'SWF-98106' THEN NOT r.due AND r.kind = 'backfill' AND r.blocked_reason = 'not_in_rollout' END), false) THEN
   RAISE EXCEPTION 'finished wake contract: judgement of %: %', r.job_number, row_to_json(r);
  END IF;
 END LOOP;
 IF (SELECT count(*) FROM public.context_ledger_judge(six)) <> 6 THEN
  RAISE EXCEPTION 'finished wake contract: the judge must answer for each of the six jobs';
 END IF;
 -- the due list holds the awake finished jobs on the rollout list: the update first, then the backfill
 SELECT string_agg(jb.job_number || ' ' || x.kind, ',' ORDER BY x.ord) INTO due
 FROM public.context_ledger_due(200) WITH ORDINALITY x(job_id, kind, reason, priority, newest_evidence_at, ord) JOIN public.jobs jb ON jb.id = x.job_id;
 IF due IS DISTINCT FROM 'SWF-98103 update,SWF-98101 backfill' THEN
  RAISE EXCEPTION 'finished wake contract: the due list with a rollout list: %', due;
 END IF;
 -- with no rollout list, every awake finished job (the rest of the stack's jobs left out of the answer)
 UPDATE public.context_ledger_settings SET job_ids = NULL WHERE id;
 SELECT string_agg(jb.job_number, ',' ORDER BY x.ord) INTO due
 FROM public.context_ledger_due(200) WITH ORDINALITY x(job_id, kind, reason, priority, newest_evidence_at, ord) JOIN public.jobs jb ON jb.id = x.job_id
 WHERE jb.job_number LIKE 'SWF-981%';
 IF due IS DISTINCT FROM 'SWF-98103,SWF-98106,SWF-98101' THEN
  RAISE EXCEPTION 'finished wake contract: the due list with no rollout list: %', due;
 END IF;
 -- a claim of an awake finished job opens a run; a quiet one answers not_due, naming why
 c := public.context_ledger_claim('9b000000-0000-4000-8000-000000000101', 'backfill', (now() AT TIME ZONE 'Australia/Perth')::date);
 IF c ->> 'outcome' IS DISTINCT FROM 'claimed' OR c ->> 'kind' IS DISTINCT FROM 'backfill'
    OR NOT EXISTS (SELECT 1 FROM public.context_extraction_runs x WHERE x.job_id = '9b000000-0000-4000-8000-000000000101' AND x.phase = 'ledger' AND x.status = 'running') THEN
  RAISE EXCEPTION 'finished wake contract: an awake finished job is claimed: %', c;
 END IF;
 c := public.context_ledger_claim('9b000000-0000-4000-8000-000000000102', 'backfill', (now() AT TIME ZONE 'Australia/Perth')::date);
 IF c ->> 'outcome' IS DISTINCT FROM 'not_due' OR c ->> 'reason' IS DISTINCT FROM 'not_live'
    OR EXISTS (SELECT 1 FROM public.context_extraction_runs x WHERE x.job_id = '9b000000-0000-4000-8000-000000000102' AND x.phase = 'ledger') THEN
  RAISE EXCEPTION 'finished wake contract: a claim of a quiet finished job answers not_due and opens no run: %', c;
 END IF;
 -- the mode off: nothing is due
 UPDATE public.context_ledger_settings SET mode = 'off' WHERE id;
 IF EXISTS (SELECT 1 FROM public.context_ledger_due(200)) THEN
  RAISE EXCEPTION 'finished wake contract: mode off, the due list must be empty';
 END IF;
END $ledger$;
ROLLBACK;

-- 3. The story is unchanged (fixed instant Mon 12 Oct 2026 10:00 Perth): awake or quiet, a finished
-- job keeps now.monitored true and is never called a lead not followed up.
BEGIN;
SET LOCAL session_replication_role = replica;
ALTER TABLE public.business_events ALTER COLUMN context_captured_at SET DEFAULT '2026-07-01 00:00Z',
 ALTER COLUMN recorded_at SET DEFAULT '2026-07-01 00:00Z', ALTER COLUMN occurred_at SET DEFAULT '2026-07-01 00:00Z';
ALTER TABLE public.jobs ALTER COLUMN created_at SET DEFAULT '2026-07-01 00:00Z', ALTER COLUMN updated_at SET DEFAULT '2026-07-01 00:00Z';
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, ghl_contact_id, pricing_json, metadata, created_at, updated_at)
VALUES ('9b000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-0000000000aa', 'SWF-98201', 'archived', 'fencing', 'Story Awake', 'ct98201', '{}', '{}', '2026-08-01 02:00Z', '2026-10-10 02:00Z'),
       ('9b000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-0000000000aa', 'SWF-98202', 'archived', 'fencing', 'Story Quiet', 'ct98202', '{}', '{}', '2026-08-01 02:00Z', '2026-09-01 02:00Z');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  context_captured_at, attribution_status, attribution_confidence, candidate_job_ids)
VALUES ('9b0b0000-0000-4000-8000-000000000201', '9b000000-0000-4000-8000-000000000201', 'client.reply', 'ghl', 'sms', 'inbound', 'ct98201',
        '{"body":"The plinths are not set below the paving"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
        '2026-10-09 02:00Z', '2026-10-09 02:00Z', '2026-10-09 02:00Z', '2026-10-09 02:00Z', 'direct', 1, NULL),
       ('9b0b0000-0000-4000-8000-000000000202', '9b000000-0000-4000-8000-000000000202', 'client.reply', 'ghl', 'sms', 'inbound', 'ct98202',
        '{"body":"Thanks for the fence"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
        '2026-08-25 02:00Z', '2026-08-25 02:00Z', '2026-08-25 02:00Z', '2026-08-25 02:00Z', 'direct', 1, NULL);
DO $story$
DECLARE asof constant timestamptz := '2026-10-12 02:00Z'; s jsonb; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES ('9b000000-0000-4000-8000-000000000201'::uuid, 'finished_awake'), ('9b000000-0000-4000-8000-000000000202'::uuid, 'not_quoted')) v(id, state) LOOP
  IF (SELECT m.state FROM public.context_lead_monitored(x.id, asof) m) IS DISTINCT FROM x.state THEN
   RAISE EXCEPTION 'finished wake contract: the story fixture % must be %', x.id, x.state;
  END IF;
  s := public.context_job_story(x.id, asof);
  IF s->'now'->'monitored' IS DISTINCT FROM 'true'::jsonb OR s->'now'->>'whose_move' IS NOT DISTINCT FROM 'not_followed_up'
     OR s->'now'->>'not_followed_up_since' IS NOT NULL OR s->'now'->>'line' LIKE '%not followed up%' THEN
   RAISE EXCEPTION 'finished wake contract: the story of a finished job (%) is unchanged: %', x.state, s->'now';
  END IF;
 END LOOP;
END $story$;
ROLLBACK;

-- 4. The scorecard, as of Mon 12 Oct 2026 12:00 Perth: its scope is read before and after the
-- fixtures are added, so the change counted is the fixtures' own whatever else the stack holds.
BEGIN;
SET LOCAL session_replication_role = replica;
ALTER TABLE public.business_events ALTER COLUMN context_captured_at SET DEFAULT '2026-07-01 00:00Z',
 ALTER COLUMN recorded_at SET DEFAULT '2026-07-01 00:00Z', ALTER COLUMN occurred_at SET DEFAULT '2026-07-01 00:00Z';
DO $before$
DECLARE s jsonb := public.context_scorecard('2026-10-12 04:00Z');
BEGIN
 PERFORM set_config('finished_wake.live_before', s->>'live_jobs', true);
 PERFORM set_config('finished_wake.mon_before', s->>'monitored_jobs', true);
 PERFORM set_config('finished_wake.off_before', s->>'leads_not_followed_up', true);
END $before$;
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, client_email, ghl_contact_id, pricing_json, metadata, created_at, updated_at)
VALUES ('9b000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-0000000000aa', 'SWF-98301', 'archived', 'fencing', 'Card Awake', 'c1@example.test', 'ct98301', '{}', '{}', '2026-08-01 02:00Z', '2026-10-10 02:00Z'),
       ('9b000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-0000000000aa', 'SWF-98302', 'archived', 'fencing', 'Card Quiet', 'c2@example.test', 'ct98302', '{}', '{}', '2026-08-01 02:00Z', '2026-09-01 02:00Z'),
       ('9b000000-0000-4000-8000-000000000303', '00000000-0000-4000-8000-0000000000aa', 'SWF-98303', 'cancelled', 'fencing', 'Card Ours', 'c3@example.test', 'ct98303', '{}', '{}', '2026-08-01 02:00Z', '2026-09-01 02:00Z');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  context_captured_at, attribution_status, attribution_confidence, candidate_job_ids)
VALUES ('9b0b0000-0000-4000-8000-000000000301', '9b000000-0000-4000-8000-000000000301', 'client.reply', 'ghl', 'sms', 'inbound', 'ct98301',
        '{"body":"The gate does not latch"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
        '2026-10-10 02:00Z', '2026-10-10 02:00Z', '2026-10-10 02:00Z', '2026-10-10 02:00Z', 'direct', 1, NULL),
       ('9b0b0000-0000-4000-8000-000000000302', '9b000000-0000-4000-8000-000000000302', 'client.reply', 'ghl', 'sms', 'inbound', 'ct98302',
        '{"body":"Thanks for the fence"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
        '2026-08-25 02:00Z', '2026-08-25 02:00Z', '2026-08-25 02:00Z', '2026-08-25 02:00Z', 'direct', 1, NULL),
       ('9b0b0000-0000-4000-8000-000000000303', '9b000000-0000-4000-8000-000000000303', 'client.sms_out', 'ghl', 'sms', 'outbound', 'ct98303',
        '{"body":"Sorry to hear you are not going ahead"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"staff","recipient_role":"customer","audience":"customer"}}',
        '2026-10-10 02:00Z', '2026-10-10 02:00Z', '2026-10-10 02:00Z', '2026-10-10 02:00Z', 'direct', 1, NULL);
DO $card$
DECLARE s jsonb := public.context_scorecard('2026-10-12 04:00Z'); got text; after uuid; j jsonb; n integer := 0;
 -- (the page's own cursor, next, is the job id to pass as p_after; null on the last page)
BEGIN
 -- the awake finished job joins the live and the monitored jobs; the quiet one and the cancelled one
 -- with only our own text join neither; the leads not followed up are untouched
 IF (s->>'live_jobs')::integer IS DISTINCT FROM current_setting('finished_wake.live_before')::integer + 1
    OR (s->>'monitored_jobs')::integer IS DISTINCT FROM current_setting('finished_wake.mon_before')::integer + 1
    OR (s->>'leads_not_followed_up')::integer IS DISTINCT FROM current_setting('finished_wake.off_before')::integer THEN
  RAISE EXCEPTION 'finished wake contract: scorecard scope: live % (was %), monitored % (was %), not followed up % (was %)',
   s->>'live_jobs', current_setting('finished_wake.live_before'), s->>'monitored_jobs', current_setting('finished_wake.mon_before'),
   s->>'leads_not_followed_up', current_setting('finished_wake.off_before');
 END IF;
 -- the per-job pages list the awake finished job and neither of the others
 LOOP
  j := public.context_scorecard_jobs(after, 300, '2026-10-12 04:00Z');
  SELECT concat_ws(',', got, string_agg(x->>'job_number', ',' ORDER BY x->>'job_number' COLLATE "C")) INTO got
  FROM jsonb_array_elements(j->'jobs') x WHERE x->>'job_number' LIKE 'SWF-983%';
  after := nullif(j->>'next', '')::uuid;
  n := n + 1;
  EXIT WHEN after IS NULL OR n > 50;
 END LOOP;
 IF got IS DISTINCT FROM 'SWF-98301' THEN
  RAISE EXCEPTION 'finished wake contract: the scorecard''s job pages list the awake finished job only: %', got;
 END IF;
END $card$;
ROLLBACK;

-- 5. The wake function: 30 days.
DO $window$
DECLARE p record;
BEGIN
 IF public.context_finished_wake_hours() IS DISTINCT FROM 720 THEN
  RAISE EXCEPTION 'finished wake contract: the wake window is 720 hours (30 days): %', public.context_finished_wake_hours();
 END IF;
 SELECT pr.prosecdef, pr.provolatile, pr.proconfig INTO p FROM pg_proc pr WHERE pr.oid = 'public.context_finished_wake_hours()'::regprocedure;
 IF p.prosecdef OR p.provolatile <> 'i' OR p.proconfig IS NOT NULL THEN
  RAISE EXCEPTION 'finished wake contract: the wake function must be immutable and inlinable (definer %, volatility %, config %)',
   p.prosecdef, p.provolatile, p.proconfig;
 END IF;
 IF has_function_privilege('anon', 'public.context_finished_wake_hours()', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.context_finished_wake_hours()', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.context_finished_wake_hours()', 'EXECUTE')
    OR coalesce(obj_description('public.context_finished_wake_hours()'::regprocedure, 'pg_proc'), '') NOT LIKE 'Finished wake (20261012093500): %' THEN
  RAISE EXCEPTION 'finished wake contract: the wake function''s access or comment';
 END IF;
END $window$;

-- 6. Shape and access of the replaced bodies.
DO $shape$
DECLARE x record; p record; rule_shape constant text :=
 'TABLE(job_id uuid, job_number text, monitored boolean, state text, quote_sent_at timestamp with time zone, customer_at timestamp with time zone, cutoff_at timestamp with time zone)';
BEGIN
 FOR x IN SELECT * FROM (VALUES
   ('public.context_lead_monitored_jobs(uuid[],timestamptz)', 'Lead cutoff (20261007010000): (scoping pipeline, 20261009133000) (finished wake, 20261012093500) %Earlier (scoping pipeline): %'),
   ('public.context_ledger_judge(uuid[])',
    'Context ledger store (20261006013000), story safety (20261006040000): (scoping pipeline, 20261009133000) (finished wake, 20261012093500) %Earlier (scoping pipeline): %'),
   ('public.context_ledger_due(integer)', 'Context ledger store (20261006013000): (scoping pipeline, 20261009133000) (finished wake, 20261012093500) %Earlier (scoping pipeline): %')
 ) v(sig, cmt) LOOP
  SELECT pr.prosecdef, pr.provolatile, pr.proconfig, pr.prolang INTO p FROM pg_proc pr WHERE pr.oid = to_regprocedure(x.sig);
  IF p IS NULL THEN RAISE EXCEPTION 'finished wake contract: % missing', x.sig; END IF;
  IF NOT p.prosecdef OR p.provolatile <> 's' OR p.prolang <> (SELECT l.oid FROM pg_language l WHERE l.lanname = 'sql')
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
   RAISE EXCEPTION 'finished wake contract: % flags (definer %, volatility %, config %)', x.sig, p.prosecdef, p.provolatile, p.proconfig;
  END IF;
  IF has_function_privilege('anon', x.sig, 'EXECUTE') OR has_function_privilege('authenticated', x.sig, 'EXECUTE')
     OR NOT has_function_privilege('service_role', x.sig, 'EXECUTE') THEN
   RAISE EXCEPTION 'finished wake contract: % access wrong', x.sig;
  END IF;
  IF coalesce(obj_description(to_regprocedure(x.sig), 'pg_proc'), '') NOT LIKE x.cmt THEN
   RAISE EXCEPTION 'finished wake contract: % comment must keep its slice names first and name the finished wake', x.sig;
  END IF;
 END LOOP;
 IF pg_get_function_result('public.context_lead_monitored_jobs(uuid[],timestamptz)'::regprocedure) IS DISTINCT FROM rule_shape
    OR pg_get_function_result('public.context_lead_monitored(uuid,timestamptz)'::regprocedure) IS DISTINCT FROM rule_shape THEN
  RAISE EXCEPTION 'finished wake contract: the rule''s columns changed';
 END IF;
 -- the one-job form keeps its slice names first, and its comment says what it now returns
 IF coalesce(obj_description('public.context_lead_monitored(uuid,timestamptz)'::regprocedure, 'pg_proc'), '')
      NOT LIKE 'Lead cutoff (20261007010000): (scoping pipeline, 20261009133000) %(finished wake, 20261012093500) for a finished job%'
    OR has_function_privilege('anon', 'public.context_lead_monitored(uuid,timestamptz)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.context_lead_monitored(uuid,timestamptz)', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.context_lead_monitored(uuid,timestamptz)', 'EXECUTE') THEN
  RAISE EXCEPTION 'finished wake contract: the one-job form''s comment or access';
 END IF;
END $shape$;

-- 7. Re-applying the migration changes nothing (its guard accepts its own bodies).
BEGIN;
-- (the rebuild order, 20261012164500, replaced the due list since: its down goes first, so the
-- re-apply starts from this migration's own bodies)
SELECT coalesce(obj_description(to_regprocedure('public.context_ledger_due(integer)'), 'pg_proc'), '') LIKE '%(rebuild order, 20261012164500)%' AS rebuild_order_live \gset
\if :rebuild_order_live
\ir ../../../rollbacks/20261012164500_context_rebuild_order_down.sql
\endif
-- (the rebuild request, 20261013153000, replaced the judge since: its down goes first, so the
-- re-apply starts from this migration's own bodies)
SELECT to_regprocedure('public.context_ledger_request_rebuild(uuid,text,text)') IS NOT NULL AS rebuild_request_live \gset
\if :rebuild_request_live
-- (held notes, 20261015100000) replaced the judge, the item check, the story's ledger read, the packet and
-- the story since: its down goes first, inside this transaction only.
SELECT to_regprocedure('public.context_ledger_held_cite(uuid,jsonb)') IS NOT NULL AS held_notes_live \gset
\if :held_notes_live
\ir ../../../rollbacks/20261015100000_context_held_notes_down.sql
\endif
\ir ../../../rollbacks/20261013153000_context_rebuild_request_down.sql
\endif
CREATE TEMP TABLE finished_wake_md5 AS
 SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS m, obj_description(p.oid, 'pg_proc') AS c FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('context_finished_wake_hours', 'context_lead_monitored_jobs', 'context_lead_monitored',
  'context_ledger_judge', 'context_ledger_due');
\ir ../../../migrations/20261012093500_context_finished_wake.sql
DO $again$
BEGIN
 IF (SELECT count(*) FROM finished_wake_md5) <> 5 OR EXISTS (SELECT 1 FROM finished_wake_md5 x JOIN pg_proc p ON p.oid = x.sig::regprocedure
       WHERE md5(p.prosrc) IS DISTINCT FROM x.m OR obj_description(p.oid, 'pg_proc') IS DISTINCT FROM x.c) THEN
  RAISE EXCEPTION 'finished wake contract: a re-apply must change nothing';
 END IF;
END $again$;
ROLLBACK;

-- 8. The service role reads the rule directly with finished jobs in the set: a fresh session, so no
-- plan cached earlier hides a missing grant, and the table grants production gives the service role.
-- The wake reads the record layer's message helper, whose crew and staff template helper
-- (context_internal_text_role) 20261005090000 revoked from the service role, so a rule that ran as
-- its caller would be refused.
\c
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, ghl_contact_id, pricing_json, metadata, created_at, updated_at)
VALUES ('9b000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-0000000000aa', 'SWF-98401', 'archived', 'fencing', 'Wake SR', 'ct98401', '{}', '{}', '2026-07-01 00:00Z', '2026-07-01 00:00Z'),
       ('9b000000-0000-4000-8000-000000000402', '00000000-0000-4000-8000-0000000000aa', 'SWF-98402', 'cancelled', 'fencing', 'Wake SR Two', 'ct98402', '{}', '{}', '2026-07-01 00:00Z', '2026-07-01 00:00Z');
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, payload, metadata, occurred_at, recorded_at, event_at,
  context_captured_at, attribution_status, attribution_confidence)
VALUES ('9b0b0000-0000-4000-8000-000000000401', '9b000000-0000-4000-8000-000000000401', 'client.reply', 'ghl', 'sms', 'inbound', 'ct98401',
        '{"body":"The fence is leaning, can someone come out?"}', '{"party_roles":{"counterpart_role":"customer","sender_role":"customer","audience":"customer"}}',
        '2026-10-10 02:00Z', '2026-10-10 02:00Z', '2026-10-10 02:00Z', '2026-10-10 02:00Z', 'direct', 1);
GRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role;
SET LOCAL ROLE service_role;
DO $service$
DECLARE asof constant timestamptz := '2026-10-12 02:00Z'; got text;
BEGIN
 IF has_function_privilege('service_role', 'public.context_internal_text_role(public.business_events)', 'EXECUTE') THEN
  RAISE EXCEPTION 'finished wake contract: the ladder helper is meant to stay revoked from the service role here';
 END IF;
 BEGIN
  SELECT string_agg(concat_ws(' ', m.job_number, m.monitored::text, m.state), ', ' ORDER BY m.job_number COLLATE "C") INTO got
  FROM public.context_lead_monitored_jobs(ARRAY['9b000000-0000-4000-8000-000000000401', '9b000000-0000-4000-8000-000000000402']::uuid[], asof) m;
  IF got IS DISTINCT FROM 'SWF-98401 true finished_awake, SWF-98402 true not_quoted' THEN
   RAISE EXCEPTION 'finished wake contract: the service role read the set form wrong: %', got;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.context_lead_monitored_jobs(NULL, asof) m WHERE m.job_number = 'SWF-98401' AND m.state = 'finished_awake')
     OR EXISTS (SELECT 1 FROM public.context_lead_monitored_jobs(NULL, asof) m WHERE m.job_number = 'SWF-98402') THEN
   RAISE EXCEPTION 'finished wake contract: the service role read the live set wrong';
  END IF;
 EXCEPTION WHEN insufficient_privilege THEN
  RAISE EXCEPTION 'finished wake contract: the service role must read the rule with finished jobs in the set: % (%)', SQLERRM, SQLSTATE;
 END;
END $service$;
RESET ROLE;
ROLLBACK;
