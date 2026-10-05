-- Contract for 20261006032000_context_scorecard: the scorecard is read only and
-- service-role only; it answers rows 1 to 14 with a status, a number and both
-- thresholds on every lane; a capture lane is graded in Perth working minutes
-- (nights and Sundays never count), backfill never keeps a lane alive, and a
-- lane past its threshold raises lane_quiet; a history load with no progress
-- for 3 runs raises history_load_stalled; and the per-job page grades each
-- live job. Every fixture row is synthetic and rolled back; user triggers are
-- off for it. The instant measured is Tue 6 Oct 2026 12:00 Perth (04:00Z).

-- 1. Shape and access.
DO $shape$
DECLARE f text; p record;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_scorecard(timestamptz)','public.context_scorecard_jobs(uuid,integer,timestamptz)'] LOOP
  SELECT pr.prosecdef, pr.provolatile, pr.proconfig INTO p FROM pg_proc pr WHERE pr.oid = to_regprocedure(f);
  IF p IS NULL THEN RAISE EXCEPTION 'scorecard contract: % missing', f; END IF;
  IF NOT p.prosecdef OR p.provolatile <> 's' OR NOT ('search_path=public, pg_temp' = ANY (p.proconfig)) THEN
   RAISE EXCEPTION 'scorecard contract: % must be STABLE SECURITY DEFINER with search_path public, pg_temp', f;
  END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_scorecard_policy()','public.context_scorecard_lane_of(text,text,text,text,text,jsonb)',
   'public.context_scorecard(timestamptz)','public.context_scorecard_jobs(uuid,integer,timestamptz)'] LOOP
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
     OR has_function_privilege('public', f, 'EXECUTE') OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
   RAISE EXCEPTION 'scorecard contract: % access wrong', f;
  END IF;
  IF obj_description(to_regprocedure(f), 'pg_proc') NOT LIKE 'Context scorecard (20261006032000)%' THEN
   RAISE EXCEPTION 'scorecard contract: % comment does not name the migration', f;
  END IF;
 END LOOP;
 -- The per-row lane helper stays inlinable: plain SQL, no SET clause, not a definer.
 SELECT pr.prosecdef, pr.proconfig, pr.provolatile, l.lanname INTO p FROM pg_proc pr JOIN pg_language l ON l.oid = pr.prolang
 WHERE pr.oid = 'public.context_scorecard_lane_of(text,text,text,text,text,jsonb)'::regprocedure;
 IF p.prosecdef OR p.proconfig IS NOT NULL OR p.provolatile <> 'i' OR p.lanname <> 'sql' THEN
  RAISE EXCEPTION 'scorecard contract: the lane helper must stay an inlinable immutable SQL function';
 END IF;
END $shape$;

-- 2. The owner's thresholds are where the policy says.
DO $policy$
DECLARE pol jsonb := public.context_scorecard_policy();
BEGIN
 IF (pol->'lane_quiet'->'texts'->>'alarm_after')::int <> 120 OR (pol->'lane_quiet'->'emails_in'->>'alarm_after')::int <> 60
    OR (pol->'lane_quiet'->'xero'->>'alarm_after')::int <> 660 OR (pol->>'history_stall_runs')::int <> 3
    OR (SELECT count(*) FROM jsonb_object_keys(pol->'lane_quiet')) <> 10
    OR EXISTS (SELECT 1 FROM jsonb_each(pol->'lane_quiet') k
               WHERE (k.value->>'warn_after')::int > (k.value->>'alarm_after')::int OR nullif(k.value->>'label', '') IS NULL) THEN
  RAISE EXCEPTION 'scorecard contract: policy thresholds wrong: %', pol->'lane_quiet';
 END IF;
END $policy$;

-- 3. The lane rule.
DO $lanes$
BEGIN
 IF public.context_scorecard_lane_of('client.reply', 'ghl', 'sms', 'inbound', 'hi', '{}') IS DISTINCT FROM 'texts'
    OR public.context_scorecard_lane_of('client.sms_out', 'ops-api', 'sms', 'outbound', 'x', '{"recipient_role":"crew"}') IS DISTINCT FROM 'crew_staff_texts'
    OR public.context_scorecard_lane_of('client.sms_out', 'ops-api', 'sms', 'outbound', 'New job assigned: SWF-1', '{}') IS DISTINCT FROM 'crew_staff_texts'
    OR public.context_scorecard_lane_of('call.transcript_completed', 'ghl-call-transcript', 'call', 'inbound', NULL, '{}') IS DISTINCT FROM 'call_transcripts'
    OR public.context_scorecard_lane_of('client.call_logged', 'ghl', 'call', 'inbound', NULL, '{}') IS DISTINCT FROM 'calls'
    OR public.context_scorecard_lane_of('client.email_in', 'outlook-mail-capture', 'email', 'inbound', NULL, '{}') IS DISTINCT FROM 'emails_in'
    OR public.context_scorecard_lane_of('client.email_out', 'outlook-mail-capture', 'email', 'outbound', NULL, '{}') IS DISTINCT FROM 'emails_out'
    OR public.context_scorecard_lane_of('invoice.paid', 'xero-sync-trigger', NULL, NULL, NULL, '{}') IS DISTINCT FROM 'xero'
    OR public.context_scorecard_lane_of('quote.sent', 'send-quote/send', 'quote', 'outbound', NULL, '{}') IS DISTINCT FROM 'quotes'
    OR public.context_scorecard_lane_of('schedule.assignment_created', 'app/office', NULL, NULL, NULL, '{}') IS DISTINCT FROM 'bookings'
    OR public.context_scorecard_lane_of('document.uploaded', 'app/office', NULL, NULL, NULL, '{}') IS DISTINCT FROM 'documents'
    OR public.context_scorecard_lane_of('note.added', 'ops-api/add_note', 'note', 'internal', NULL, '{}') IS NOT NULL THEN
  RAISE EXCEPTION 'scorecard contract: lane rule wrong';
 END IF;
END $lanes$;

-- 4. It answers inside a read-only transaction, with 14 rows of graded lanes.
BEGIN READ ONLY;
DO $ro$
DECLARE s jsonb := public.context_scorecard('2026-10-06 04:00Z'); j jsonb := public.context_scorecard_jobs(NULL, 5, '2026-10-06 04:00Z');
BEGIN
 IF s->>'version' <> 'context-scorecard-v1' OR jsonb_array_length(s->'rows') <> 14
    OR (SELECT array_agg((r->>'row')::int ORDER BY o) FROM jsonb_array_elements(s->'rows') WITH ORDINALITY AS x(r, o))
       <> ARRAY[1,2,3,4,5,6,7,8,9,10,11,12,13,14] THEN
  RAISE EXCEPTION 'scorecard contract: rows wrong: %', s->'rows';
 END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(s->'rows') r, jsonb_array_elements(r->'lanes') l
            WHERE l->>'status' NOT IN ('green', 'amber', 'red') OR NOT (l ? 'number' AND l ? 'green' AND l ? 'amber' AND l ? 'unit' AND l ? 'value' AND l ? 'lane'))
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(s->'rows') r WHERE jsonb_array_length(r->'lanes') = 0)
 THEN RAISE EXCEPTION 'scorecard contract: a lane lacks status, number or thresholds'; END IF;
 -- A row is its worst lane, and the summary agrees with the rows.
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(s->'rows') r
            WHERE r->>'status' <> CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(r->'lanes') l WHERE l->>'status' = 'red') THEN 'red'
                                       WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(r->'lanes') l WHERE l->>'status' = 'amber') THEN 'amber' ELSE 'green' END)
    OR (s->'summary'->>'red')::int <> jsonb_array_length(s->'summary'->'red_rows')
    OR (s->'summary'->>'done')::boolean
 THEN RAISE EXCEPTION 'scorecard contract: row status or summary wrong: %', s->'summary'; END IF;
 -- What SQL cannot measure is red with the reason, never green.
 IF (SELECT r->>'status' FROM jsonb_array_elements(s->'rows') r WHERE r->>'row' = '9') <> 'red' THEN
  RAISE EXCEPTION 'scorecard contract: an unmeasured row read green';
 END IF;
 IF j->>'version' <> 'context-scorecard-jobs-v1' OR jsonb_typeof(j->'jobs') <> 'array' THEN
  RAISE EXCEPTION 'scorecard contract: jobs page shape wrong';
 END IF;
END $ro$;
ROLLBACK;

-- 5. Fixtures: three live jobs and one lost job, messages in every graded state.
BEGIN;
SET LOCAL session_replication_role = replica;

CREATE TEMP TABLE sc_before ON COMMIT DROP AS SELECT public.context_scorecard('2026-10-06 04:00Z') AS s;

CREATE FUNCTION pg_temp.lane(s jsonb, p_row int, p_lane text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT l FROM jsonb_array_elements(s->'rows') r, jsonb_array_elements(r->'lanes') l
 WHERE (r->>'row')::int = p_row AND l->>'lane' = p_lane
$$;
CREATE FUNCTION pg_temp.job_row(j jsonb, p_job uuid, p_row int) RETURNS jsonb LANGUAGE sql AS $$
 SELECT r FROM jsonb_array_elements(j->'jobs') x, jsonb_array_elements(x->'rows') r
 WHERE (x->>'job_id')::uuid = p_job AND (r->>'row')::int = p_row
$$;

INSERT INTO public.jobs (id, org_id, job_number, status, type, client_email, ghl_contact_id, created_at)
VALUES ('5c000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000aa', 'SWF-SC01', 'accepted', 'fencing', 'sc.one@example.test', NULL, '2026-08-01 02:00Z'),
       ('5c000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000aa', 'SWF-SC02', 'processing', 'fencing', NULL, 'ctSC2', '2026-09-01 02:00Z'),
       ('5c000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000aa', 'SWF-SC03', 'quoted', 'fencing', NULL, NULL, '2026-09-15 02:00Z'),
       ('5c000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-0000000000aa', 'SWF-SC04', 'lost', 'fencing', 'sc.four@example.test', NULL, '2026-09-15 02:00Z');

INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, metadata, body_preview, payload,
  occurred_at, recorded_at, context_captured_at, event_at, attribution_status, candidate_job_ids)
VALUES
 -- texts: the newest live one landed Tue 09:00 Perth (180 working minutes before noon); one names only one side.
 ('5ce00000-0000-4000-8000-000000000001', '5c000000-0000-4000-8000-000000000001', 'client.reply', 'ghl-message-reconcile', 'sms', 'inbound',
  '{"capture_mode":"live","party_roles":{"sender_role":"customer","recipient_role":"staff","audience":"customer"}}', 'Can you come Monday?', '{}',
  '2026-10-06 01:00Z', '2026-10-06 01:00Z', '2026-10-06 01:00Z', '2026-08-21 02:00Z', 'direct', NULL),
 ('5ce00000-0000-4000-8000-000000000002', NULL, 'client.reply', 'ghl-message-reconcile', 'sms', 'inbound',
  '{"capture_mode":"live","party_roles":{"sender_role":"unknown","recipient_role":"staff","audience":"unknown"}}', 'Who is this?', '{}',
  '2026-10-06 00:30Z', '2026-10-06 00:30Z', '2026-10-06 00:30Z', '2026-10-06 00:30Z', 'admin_bucket', ARRAY['5c000000-0000-4000-8000-000000000001'::uuid]),
 -- a text captured after the instant measured never counts.
 ('5ce00000-0000-4000-8000-000000000003', '5c000000-0000-4000-8000-000000000001', 'client.reply', 'ghl-message-reconcile', 'sms', 'inbound',
  '{"capture_mode":"live","party_roles":{"sender_role":"customer","recipient_role":"staff","audience":"customer"}}', 'Later', '{}',
  '2026-10-06 05:00Z', '2026-10-06 05:00Z', '2026-10-06 05:00Z', '2026-10-06 05:00Z', 'direct', NULL),
 -- a call 90 working minutes ago, unplaced with no candidate.
 ('5ce00000-0000-4000-8000-000000000004', NULL, 'client.call_logged', 'ghl-message-reconcile', 'call', 'inbound',
  '{"capture_mode":"live","party_roles":{"sender_role":"customer","recipient_role":"staff","audience":"customer"}}', NULL, '{}',
  '2026-10-06 02:30Z', '2026-10-06 02:30Z', '2026-10-06 02:30Z', '2026-10-06 02:30Z', 'unplaced', NULL),
 -- email in 20 minutes ago; email out 15 minutes ago with the recipient unknown.
 ('5ce00000-0000-4000-8000-000000000005', '5c000000-0000-4000-8000-000000000001', 'client.email_in', 'outlook-mail-capture', 'email', 'inbound',
  '{"capture_mode":"live","party_roles":{"sender_role":"customer","recipient_role":"staff","audience":"customer"}}', NULL, '{}',
  '2026-10-06 03:40Z', '2026-10-06 03:40Z', '2026-10-06 03:40Z', '2026-08-02 02:00Z', 'direct', NULL),
 ('5ce00000-0000-4000-8000-000000000006', '5c000000-0000-4000-8000-000000000001', 'client.email_out', 'outlook-mail-capture', 'email', 'outbound',
  '{"capture_mode":"live","party_roles":{"sender_role":"staff","recipient_role":"unknown","audience":"unknown"}}', NULL, '{}',
  '2026-10-06 03:45Z', '2026-10-06 03:45Z', '2026-10-06 03:45Z', '2026-10-06 03:45Z', 'direct', NULL),
 -- Xero: only a backfill row (it never keeps the lane alive), on job one.
 ('5ce00000-0000-4000-8000-000000000007', '5c000000-0000-4000-8000-000000000001', 'invoice.raised', 'xero-history', 'invoice', 'internal',
  '{"capture_mode":"backfill"}', NULL, '{}',
  '2026-10-06 03:00Z', '2026-10-06 03:00Z', '2026-10-06 03:00Z', '2026-09-01 02:00Z', 'direct', NULL),
 -- a quote Mon 17:30 Perth: 30 + 300 working minutes, never the 18.5 clock hours.
 ('5ce00000-0000-4000-8000-000000000008', NULL, 'quote.sent', 'send-quote/send', 'quote', 'outbound',
  '{}', NULL, '{}', '2026-10-05 09:30Z', '2026-10-05 09:30Z', '2026-10-05 09:30Z', '2026-10-05 09:30Z', 'unplaced', NULL),
 -- a booking Sat 17:00 Perth: Sunday is not a working day (60 + 660 + 300 = 1020).
 ('5ce00000-0000-4000-8000-000000000009', '5c000000-0000-4000-8000-000000000003', 'schedule.assignment_created', 'app/office', 'assignment', 'internal',
  '{}', NULL, '{}', '2026-10-03 09:00Z', '2026-10-03 09:00Z', '2026-10-03 09:00Z', '2026-10-03 09:00Z', 'direct', NULL),
 -- crew texts since the internal-text rule: one right, one not labelled internal, one off its job.
 ('5ce00000-0000-4000-8000-00000000000a', '5c000000-0000-4000-8000-000000000001', 'client.sms_out', 'ops-api', 'sms', 'outbound',
  '{"capture_mode":"live","recipient_role":"crew","audience":"internal","party_roles":{"sender_role":"staff","recipient_role":"crew","audience":"internal"}}',
  'Job ready for crew: SWF-SC01', '{}', '2026-10-05 02:00Z', '2026-10-05 02:00Z', '2026-10-05 02:00Z', '2026-10-05 02:00Z', 'direct', NULL),
 ('5ce00000-0000-4000-8000-00000000000b', '5c000000-0000-4000-8000-000000000001', 'client.sms_out', 'ops-api', 'sms', 'outbound',
  '{"capture_mode":"live","recipient_role":"crew","party_roles":{"sender_role":"staff","recipient_role":"crew","audience":"customer"}}',
  'Gate code is on the job', '{}', '2026-10-05 01:00Z', '2026-10-05 01:00Z', '2026-10-05 01:00Z', '2026-10-05 01:00Z', 'direct', NULL),
 ('5ce00000-0000-4000-8000-00000000000c', NULL, 'client.sms_out', 'ops-api', 'sms', 'outbound',
  '{"capture_mode":"live","recipient_role":"staff","party_roles":{"sender_role":"staff","recipient_role":"staff","audience":"internal"}}',
  'Call the office', '{}', '2026-10-05 00:30Z', '2026-10-05 00:30Z', '2026-10-05 00:30Z', '2026-10-05 00:30Z', 'admin_bucket', NULL),
 -- a misfile: sitting on job one, naming job two.
 ('5ce00000-0000-4000-8000-00000000000d', '5c000000-0000-4000-8000-000000000001', 'ghl.internal_comment', 'ghl', 'note', 'internal',
  '{}', NULL, '{"job_id":"5c000000-0000-4000-8000-000000000002"}',
  '2026-09-01 02:00Z', '2026-09-01 02:00Z', '2026-09-01 02:00Z', '2026-09-01 02:00Z', 'direct', NULL);

-- Live Xero invoices on jobs one and two (only job one carries Xero evidence).
INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, total, job_id)
VALUES ('00000000-0000-4000-8000-0000000000aa', 'sc-x-1', 'INV-SC1', 'ACCREC', 'AUTHORISED', 1100, '5c000000-0000-4000-8000-000000000001'),
       ('00000000-0000-4000-8000-0000000000aa', 'sc-x-2', 'INV-SC2', 'ACCREC', 'AUTHORISED', 2200, '5c000000-0000-4000-8000-000000000002'),
       ('00000000-0000-4000-8000-0000000000aa', 'sc-x-3', 'INV-SC3', 'ACCREC', 'VOIDED', 3300, '5c000000-0000-4000-8000-000000000003');

-- History runs: one load stuck (3 partial runs, nothing added, cursor unchanged),
-- one moving (cursor changes), one finished (succeeded, nothing left), and a
-- dry run that looks stuck but is never a load.
INSERT INTO public.context_capture_runs (source, status, started_at, updated_at, finished_at, cursor, counts)
VALUES ('outlook_history_scfx', 'partial', '2026-10-06 03:20Z', '2026-10-06 03:22Z', '2026-10-06 03:22Z', '{"page":"p7"}', '{"inserted":0,"seen":40}'),
       ('outlook_history_scfx', 'partial', '2026-10-06 03:30Z', '2026-10-06 03:32Z', '2026-10-06 03:32Z', '{"page":"p7"}', '{"inserted":0,"seen":41}'),
       ('outlook_history_scfx', 'partial', '2026-10-06 03:40Z', '2026-10-06 03:42Z', '2026-10-06 03:42Z', '{"page":"p7"}', '{"inserted":0,"seen":39}'),
       ('outlook_history_scmv', 'partial', '2026-10-06 03:20Z', '2026-10-06 03:22Z', '2026-10-06 03:22Z', '{"page":"p1"}', '{"inserted":0}'),
       ('outlook_history_scmv', 'partial', '2026-10-06 03:30Z', '2026-10-06 03:32Z', '2026-10-06 03:32Z', '{"page":"p2"}', '{"inserted":0}'),
       ('outlook_history_scmv', 'partial', '2026-10-06 03:40Z', '2026-10-06 03:42Z', '2026-10-06 03:42Z', '{"page":"p3"}', '{"inserted":0}'),
       ('ghl_history_load', 'succeeded', '2026-10-06 03:20Z', '2026-10-06 03:21Z', '2026-10-06 03:21Z', '{"c":1}', '{"inserted":0}'),
       ('ghl_history_load', 'succeeded', '2026-10-06 03:30Z', '2026-10-06 03:31Z', '2026-10-06 03:31Z', '{"c":1}', '{"inserted":0}'),
       ('ghl_history_load', 'succeeded', '2026-10-06 03:40Z', '2026-10-06 03:41Z', '2026-10-06 03:41Z', '{"c":1}', '{"inserted":0}'),
       ('outlook_history_scfx_dry', 'partial', '2026-10-06 03:20Z', '2026-10-06 03:22Z', '2026-10-06 03:22Z', '{"page":"p7"}', '{"inserted":0}'),
       ('outlook_history_scfx_dry', 'partial', '2026-10-06 03:30Z', '2026-10-06 03:32Z', '2026-10-06 03:32Z', '{"page":"p7"}', '{"inserted":0}'),
       ('outlook_history_scfx_dry', 'partial', '2026-10-06 03:40Z', '2026-10-06 03:42Z', '2026-10-06 03:42Z', '{"page":"p7"}', '{"inserted":0}');

DO $card$
DECLARE s jsonb := public.context_scorecard('2026-10-06 04:00Z'); s0 jsonb := (SELECT b.s FROM sc_before b); l jsonb; a text[];
BEGIN
 -- Row 1: working minutes, statuses and alarms.
 l := pg_temp.lane(s, 1, 'texts');
 IF (l->>'number')::int <> 180 OR l->>'status' <> 'red' OR (l->>'amber')::int <> 120 OR (l->>'green')::int <> 60 THEN
  RAISE EXCEPTION 'scorecard contract: texts lane wrong (a later row must not count): %', l; END IF;
 l := pg_temp.lane(s, 1, 'calls');
 IF (l->>'number')::int <> 90 OR l->>'status' <> 'amber' THEN RAISE EXCEPTION 'scorecard contract: calls lane wrong: %', l; END IF;
 l := pg_temp.lane(s, 1, 'emails_in');
 IF (l->>'number')::int <> 20 OR l->>'status' <> 'green' THEN RAISE EXCEPTION 'scorecard contract: emails_in lane wrong: %', l; END IF;
 l := pg_temp.lane(s, 1, 'quotes');
 IF (l->>'number')::int <> 330 OR l->>'status' <> 'green' THEN RAISE EXCEPTION 'scorecard contract: overnight counted against quotes: %', l; END IF;
 l := pg_temp.lane(s, 1, 'bookings');
 IF (l->>'number')::int <> 1020 OR l->>'status' <> 'amber' THEN RAISE EXCEPTION 'scorecard contract: Sunday counted against bookings: %', l; END IF;
 l := pg_temp.lane(s, 1, 'crew_staff_texts');
 IF (l->>'number')::int <> 780 OR l->>'status' <> 'amber' THEN RAISE EXCEPTION 'scorecard contract: crew lane wrong: %', l; END IF;
 l := pg_temp.lane(s, 1, 'xero');
 IF l->'number' <> 'null'::jsonb OR l->>'status' <> 'red' THEN RAISE EXCEPTION 'scorecard contract: a backfill row kept the Xero lane alive: %', l; END IF;
 SELECT array_agg(x->>'lane' ORDER BY x->>'lane' COLLATE "C") INTO a FROM jsonb_array_elements(s->'alarms') x WHERE x->>'key' = 'lane_quiet';
 IF a IS DISTINCT FROM ARRAY['call_transcripts', 'documents', 'texts', 'xero'] THEN
  RAISE EXCEPTION 'scorecard contract: lane_quiet alarms wrong: %', a; END IF;
 IF (SELECT x->>'what_to_do' FROM jsonb_array_elements(s->'alarms') x WHERE x->>'lane' = 'xero') NOT LIKE 'No new Xero invoices or payments have arrived%'
    OR (SELECT (x->>'quiet_working_minutes')::int FROM jsonb_array_elements(s->'alarms') x WHERE x->>'lane' = 'texts') <> 180 THEN
  RAISE EXCEPTION 'scorecard contract: lane_quiet alarm detail wrong: %', s->'alarms'; END IF;

 -- Row 2: both sides named; crew texts on their job, internal.
 l := pg_temp.lane(s, 2, 'texts');
 IF (l->>'number')::numeric <> 50.0 OR l->>'status' <> 'red' THEN RAISE EXCEPTION 'scorecard contract: who-to-whom texts wrong: %', l; END IF;
 l := pg_temp.lane(s, 2, 'calls');
 IF (l->>'number')::numeric <> 100.0 OR l->>'status' <> 'green' THEN RAISE EXCEPTION 'scorecard contract: who-to-whom calls wrong: %', l; END IF;
 l := pg_temp.lane(s, 2, 'emails_out');
 IF (l->>'number')::numeric <> 0 OR l->>'status' <> 'red' THEN RAISE EXCEPTION 'scorecard contract: who-to-whom emails_out wrong: %', l; END IF;
 l := pg_temp.lane(s, 2, 'crew_staff_texts');
 IF (l->>'number')::int <> 2 OR l->>'status' <> 'red' OR l->>'value' NOT LIKE '1 off their job, 1 on a job but not labelled internal, of 3%' THEN
  RAISE EXCEPTION 'scorecard contract: crew rule lane wrong: %', l; END IF;

 -- Row 3: placement, the review queue and misfiles.
 l := pg_temp.lane(s, 3, 'customer_facing');
 IF (l->>'number')::numeric <> 66.7 OR l->>'status' <> 'red' THEN RAISE EXCEPTION 'scorecard contract: customer placement wrong: %', l; END IF;
 l := pg_temp.lane(s, 3, 'xero_and_quotes');
 IF (l->>'number')::numeric <> 50.0 OR l->>'status' <> 'red' THEN RAISE EXCEPTION 'scorecard contract: Xero and quote placement wrong: %', l; END IF;
 l := pg_temp.lane(s, 3, 'review_queue');
 IF (l->>'number')::numeric <> 25.0 OR l->>'status' <> 'red' OR l->>'value' NOT LIKE '1 of 4 unplaced items%' THEN
  RAISE EXCEPTION 'scorecard contract: review queue wrong: %', l; END IF;
 IF (pg_temp.lane(s, 3, 'known_misfiles')->>'number')::int <> (pg_temp.lane(s0, 3, 'known_misfiles')->>'number')::int + 1
    OR pg_temp.lane(s, 3, 'known_misfiles')->>'status' <> 'red' THEN
  RAISE EXCEPTION 'scorecard contract: the misfile was not counted: %', pg_temp.lane(s, 3, 'known_misfiles'); END IF;
 IF pg_temp.lane(s, 3, 'right_job_accuracy')->>'status' <> 'red' THEN RAISE EXCEPTION 'scorecard contract: an unmeasured lane is not red'; END IF;

 -- Row 4: Xero evidence and the stalled history load.
 l := pg_temp.lane(s, 4, 'xero_history');
 IF (l->>'number')::numeric <> 50.0 OR l->>'status' <> 'amber' THEN RAISE EXCEPTION 'scorecard contract: Xero history wrong: %', l; END IF;
 SELECT array_agg(x->>'source' ORDER BY x->>'source' COLLATE "C") INTO a FROM jsonb_array_elements(s->'alarms') x WHERE x->>'key' = 'history_load_stalled';
 IF a IS DISTINCT FROM ARRAY['outlook_history_scfx'] THEN RAISE EXCEPTION 'scorecard contract: history_load_stalled wrong: %', a; END IF;
 l := pg_temp.lane(s, 4, 'history_loads_stalled');
 IF (l->>'number')::int <> 1 OR l->>'status' <> 'red' THEN RAISE EXCEPTION 'scorecard contract: stalled lane wrong: %', l; END IF;
 IF pg_temp.lane(s, 4, 'history_schedules')->>'status' <> 'red' THEN RAISE EXCEPTION 'scorecard contract: a missing schedule read green'; END IF;

 -- Live jobs: the lost job is not live.
 IF (s->>'live_jobs')::int <> (s0->>'live_jobs')::int + 3 THEN RAISE EXCEPTION 'scorecard contract: live job count wrong'; END IF;
END $card$;

DO $jobs$
DECLARE j jsonb := public.context_scorecard_jobs(NULL, 300, '2026-10-06 04:00Z'); one jsonb; r jsonb; ids uuid[];
BEGIN
 IF j->'next' <> 'null'::jsonb THEN RAISE EXCEPTION 'scorecard contract: a short page must end the paging'; END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(j->'jobs') x WHERE x->>'job_id' = '5c000000-0000-4000-8000-000000000004') THEN
  RAISE EXCEPTION 'scorecard contract: a lost job is on the live page'; END IF;
 ids := ARRAY(SELECT (x->>'job_id')::uuid FROM jsonb_array_elements(j->'jobs') WITH ORDINALITY AS t(x, o) ORDER BY o);
 IF ids <> ARRAY(SELECT unnest(ids) ORDER BY 1) THEN RAISE EXCEPTION 'scorecard contract: the page is not ordered by id'; END IF;
 -- Job one: four of five messages name both sides (amber); no CRM contact but Xero evidence (amber);
 -- its earliest text is 20 days after the start (red); it can be matched to its client (green).
 r := pg_temp.job_row(j, '5c000000-0000-4000-8000-000000000001', 2);
 IF (r->>'number')::numeric <> 80.0 OR r->>'status' <> 'amber' THEN RAISE EXCEPTION 'scorecard contract: job one row 2 wrong: %', r; END IF;
 IF pg_temp.job_row(j, '5c000000-0000-4000-8000-000000000001', 4)->>'status' <> 'amber' THEN RAISE EXCEPTION 'scorecard contract: job one row 4 wrong'; END IF;
 r := pg_temp.job_row(j, '5c000000-0000-4000-8000-000000000001', 14);
 IF r->>'status' <> 'red' OR r->>'value' NOT LIKE '%earliest email 2 Aug 2026; earliest text or call 21 Aug 2026' THEN
  RAISE EXCEPTION 'scorecard contract: job one row 14 wrong: %', r; END IF;
 IF pg_temp.job_row(j, '5c000000-0000-4000-8000-000000000001', 13)->>'status' <> 'green'
    OR pg_temp.job_row(j, '5c000000-0000-4000-8000-000000000001', 11)->>'status' <> 'red' THEN
  RAISE EXCEPTION 'scorecard contract: job one story rows wrong'; END IF;
 SELECT x INTO one FROM jsonb_array_elements(j->'jobs') x WHERE x->>'job_id' = '5c000000-0000-4000-8000-000000000001';
 IF one->>'status' <> 'red' OR NOT (one->'red_rows' @> '[11,12,14]'::jsonb) THEN RAISE EXCEPTION 'scorecard contract: job one summary wrong: %', one; END IF;
 -- Job two: CRM contact with no history loaded and an invoice with no Xero evidence (red); no evidence at all.
 r := pg_temp.job_row(j, '5c000000-0000-4000-8000-000000000002', 4);
 IF r->>'status' <> 'red' OR r->>'value' <> 'CRM history not loaded; 1 Xero invoices, no Xero evidence' THEN
  RAISE EXCEPTION 'scorecard contract: job two row 4 wrong: %', r; END IF;
 IF pg_temp.job_row(j, '5c000000-0000-4000-8000-000000000002', 7)->>'status' <> 'amber'
    OR pg_temp.job_row(j, '5c000000-0000-4000-8000-000000000002', 14)->>'status' <> 'amber' THEN
  RAISE EXCEPTION 'scorecard contract: job two rows 7 and 14 wrong'; END IF;
 -- Job three: no CRM contact and no client email, so no client view.
 IF pg_temp.job_row(j, '5c000000-0000-4000-8000-000000000003', 13)->>'status' <> 'red' THEN
  RAISE EXCEPTION 'scorecard contract: job three row 13 wrong'; END IF;
 -- Paging: a page of one names its cursor, and the next page starts after it.
 j := public.context_scorecard_jobs(NULL, 1, '2026-10-06 04:00Z');
 IF jsonb_array_length(j->'jobs') <> 1 OR (j->>'next')::uuid <> (j->'jobs'->0->>'job_id')::uuid
    OR (public.context_scorecard_jobs((j->>'next')::uuid, 1, '2026-10-06 04:00Z')->'jobs'->0->>'job_id')::uuid <= (j->>'next')::uuid THEN
  RAISE EXCEPTION 'scorecard contract: paging wrong: %', j->'next'; END IF;
END $jobs$;
ROLLBACK;
