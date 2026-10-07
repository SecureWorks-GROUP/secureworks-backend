-- Contract for 20261007120000_context_scorecard_v2: the scorecard v2, wired to
-- every 7 Oct 2026 data source and measured on the new AI reader, on the live
-- jobs the lead rule keeps monitored. Failing first: every check reads only the
-- scorecard's own answer (and, for the shape, its catalogue entries), so on W11's
-- bodies (before this migration) every row's checks fail; the failing-first run
-- in the PR collects them row by row. Each section gathers its failures and
-- raises them together, so a failure names every broken row at once.
--  1. Shape and access: the three bodies are this migration's (comment), the two
--     reads STABLE SECURITY DEFINER with search_path public, pg_temp and a 50 s
--     statement timeout for API callers, service role only, writing nothing; the
--     policy holds the v2 bars.
--  2. It answers inside a read-only transaction: version v2, 14 rows, the v2
--     lanes (no fact coverage, no brief, the right-job lane per population, the
--     hourly run, the email reach), no em or en dash; the jobs page is v2.
--  3. Fixtures (fixed instant Wed 7 Oct 2026 12:00 Perth, 04:00Z): row by row,
--     every new behaviour: the scope (a lead no longer followed up and a lost
--     job are out), row 2's stamps, row 3's prospects, misfiles and graded
--     samples, row 4's CRM read and the Xero cron, row 6 on the AI reader
--     (live, late, backlog, a shadow is never read), rows 7, 8 and 9's grades
--     (each green, then red on a newer failing sample), row 10's hourly run,
--     rows 11 to 13 on the monitored jobs, row 14's email reach; then the jobs
--     page: its scope, paging and every per-job row.
--  4. Re-applying the migration changes nothing.
-- Each fixture check sits in a savepoint that a run with ON_ERROR_STOP off (the
-- failing-first run) rolls back to, so every section reports; with ON_ERROR_STOP
-- on (the runner) the first failing section stops the contract.
-- Every fixture row is synthetic and rolled back; user triggers are off for it,
-- the column defaults that would stamp the wall clock are pinned inside the
-- fixture transaction, and every job already in the stack leaves the live list
-- inside it, so the job rows count only the fixtures. A pg_cron stand-in lives
-- only inside its transaction.

CREATE TEMP TABLE sc2_fail (section text, row_no integer, what text);
CREATE FUNCTION pg_temp.sc2_check(p_ok boolean, p_section text, p_row integer, p_what text) RETURNS void
LANGUAGE sql AS $$
 INSERT INTO sc2_fail SELECT p_section, p_row, p_what WHERE NOT coalesce(p_ok, false)
$$;
CREATE FUNCTION pg_temp.sc2_raise(p_section text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE m text;
BEGIN
 SELECT string_agg('row ' || coalesce(f.row_no::text, '-') || ': ' || f.what, ' | ' ORDER BY f.row_no NULLS FIRST, f.what COLLATE "C")
 INTO m FROM sc2_fail f WHERE f.section = p_section;
 IF m IS NOT NULL THEN RAISE EXCEPTION 'scorecard v2 contract (%): %', p_section, m; END IF;
END $$;
CREATE FUNCTION pg_temp.sc2_lane(s jsonb, p_row integer, p_lane text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT l FROM jsonb_array_elements(s->'rows') r, jsonb_array_elements(r->'lanes') l
 WHERE (r->>'row')::integer = p_row AND l->>'lane' = p_lane
$$;
CREATE FUNCTION pg_temp.sc2_row(s jsonb, p_row integer) RETURNS jsonb LANGUAGE sql AS $$
 SELECT r FROM jsonb_array_elements(s->'rows') r WHERE (r->>'row')::integer = p_row
$$;
CREATE FUNCTION pg_temp.sc2_job_row(j jsonb, p_job uuid, p_row integer) RETURNS jsonb LANGUAGE sql AS $$
 SELECT r FROM jsonb_array_elements(j->'jobs') x, jsonb_array_elements(x->'rows') r
 WHERE (x->>'job_id')::uuid = p_job AND (r->>'row')::integer = p_row
$$;
-- The first two counts of a lane value "<a> of <b> ...", as integers.
CREATE FUNCTION pg_temp.sc2_ab(v text) RETURNS integer[] LANGUAGE sql AS $$
 SELECT ARRAY[(regexp_match(v, '^([0-9]+) of ([0-9]+)'))[1]::integer, (regexp_match(v, '^([0-9]+) of ([0-9]+)'))[2]::integer]
$$;

-- 1. Shape and access.
DO $shape$
DECLARE f text; p record; pol jsonb;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_scorecard(timestamptz)', 'public.context_scorecard_jobs(uuid,integer,timestamptz)'] LOOP
  SELECT pr.prosecdef, pr.provolatile, pr.proconfig INTO p FROM pg_proc pr WHERE pr.oid = to_regprocedure(f);
  PERFORM pg_temp.sc2_check(p.prosecdef AND p.provolatile = 's' AND 'search_path=public, pg_temp' = ANY (p.proconfig)
   AND 'statement_timeout=50s' = ANY (p.proconfig), 'shape', NULL,
   f || ' must be STABLE SECURITY DEFINER with search_path public, pg_temp and statement_timeout 50s');
 END LOOP;
 PERFORM pg_temp.sc2_check((SELECT provolatile FROM pg_proc WHERE oid = 'public.context_scorecard_policy()'::regprocedure) = 'i',
  'shape', NULL, 'the policy must stay IMMUTABLE');
 FOREACH f IN ARRAY ARRAY['public.context_scorecard_policy()', 'public.context_scorecard(timestamptz)',
   'public.context_scorecard_jobs(uuid,integer,timestamptz)'] LOOP
  PERFORM pg_temp.sc2_check(NOT has_function_privilege('anon', f, 'EXECUTE') AND NOT has_function_privilege('authenticated', f, 'EXECUTE')
   AND NOT has_function_privilege('public', f, 'EXECUTE') AND has_function_privilege('service_role', f, 'EXECUTE'), 'shape', NULL, f || ' access wrong');
  PERFORM pg_temp.sc2_check(obj_description(to_regprocedure(f), 'pg_proc') LIKE 'Context scorecard v2 (20261007120000)%', 'shape', NULL,
   f || ' comment does not name the migration');
  -- Writes nothing: no insert, update, delete or truncate in the body.
  PERFORM pg_temp.sc2_check(NOT EXISTS (SELECT 1 FROM pg_proc pr
    CROSS JOIN LATERAL regexp_matches(regexp_replace(pr.prosrc, '--[^\n]*', '', 'g'), '\m(insert\s+into|update\s+[a-z_]+\s+set|delete\s+from|truncate)\M', 'gi') m
    WHERE pr.oid = to_regprocedure(f)), 'shape', NULL, f || ' writes');
 END LOOP;
 -- The lane helper stays inlinable and untouched (20261006034000's body).
 SELECT pr.prosecdef, pr.proconfig, pr.provolatile, l.lanname INTO p FROM pg_proc pr JOIN pg_language l ON l.oid = pr.prolang
 WHERE pr.oid = 'public.context_scorecard_lane_of(text,text,text,text,text,jsonb)'::regprocedure;
 PERFORM pg_temp.sc2_check(NOT p.prosecdef AND p.proconfig IS NULL AND p.provolatile = 'i' AND p.lanname = 'sql', 'shape', NULL,
  'the lane helper must stay an inlinable immutable SQL function');
 pol := public.context_scorecard_policy();
 PERFORM pg_temp.sc2_check(pol->>'version' = 'context-scorecard-v2' AND pol->'scope'->>'rule' = 'context_lead_monitored_jobs'
  AND (pol->'scope'->>'lead_cutoff_days')::integer = 28, 'shape', NULL, 'policy version or scope wrong');
 PERFORM pg_temp.sc2_check(pol->'history_schedules' = '{"ghl": "ghl-history-schedule", "email": "outlook-mail-poll", "xero": "xero-history-daily"}'::jsonb,
  'shape', 4, 'policy history_schedules must name xero-history-daily');
 PERFORM pg_temp.sc2_check(pol->'history'->'crm_done_states' = '["loaded", "tried_no_contact"]'::jsonb, 'shape', 4,
  'policy CRM done states must be loaded and tried_no_contact');
 PERFORM pg_temp.sc2_check((pol->'right_job'->>'min_drawn')::integer = 100 AND (pol->'right_job'->>'green_pct')::numeric = 95
  AND pol->'right_job'->'populations' = '["customer_facing", "xero_and_quotes"]'::jsonb, 'shape', 3, 'policy right_job bars wrong');
 PERFORM pg_temp.sc2_check(pol->'reading'->>'reader' = 'context_ledger' AND pol->'reading'->>'run_phase' = 'ledger'
  AND (pol->'reading'->>'live_max_minutes')::integer = 120 AND (pol->'reading'->>'backlog_max_hours')::integer = 24, 'shape', 6,
  'policy reading must be the AI reader, 2 h and 24 h');
 PERFORM pg_temp.sc2_check((pol->'facts'->>'min_jobs')::integer = 10 AND (pol->'facts'->>'green_pct')::numeric = 95
  AND (pol->'answer'->>'min_jobs')::integer = 10 AND (pol->'answer'->>'recall_message_pct')::numeric = 95
  AND (pol->'answer'->>'precision_pct')::numeric = 90 AND (pol->'answer'->>'unseen_first_line_pct')::numeric = 90
  AND (pol->'agent'->>'baseline_calls')::integer = 30 AND (pol->'agent'->>'story_calls')::integer = 10
  AND (pol->'agent'->>'story_flag_required')::boolean AND NOT (pol->'agent'->>'story_tool_missed_gates')::boolean
  AND NOT (pol->'agent'->>'ledger_mode_live_gates')::boolean, 'shape', 7, 'policy grade bars wrong');
 PERFORM pg_temp.sc2_check(NOT pol ? 'brief' AND NOT pol ? 'facts_coverage', 'shape', 8, 'the policy still carries the brief');
 PERFORM pg_temp.sc2_raise('shape');
END $shape$;

-- 2. It answers inside a read-only transaction, in the v2 shape.
BEGIN READ ONLY;
DO $ro$
DECLARE s jsonb := public.context_scorecard('2026-10-07 04:00Z'); j jsonb := public.context_scorecard_jobs(NULL, 5, '2026-10-07 04:00Z');
 lanes text[];
BEGIN
 PERFORM pg_temp.sc2_check(s->>'version' = 'context-scorecard-v2', 'read', NULL, 'card version is not context-scorecard-v2');
 PERFORM pg_temp.sc2_check(jsonb_array_length(s->'rows') = 14 AND (SELECT array_agg((r->>'row')::integer ORDER BY o)
   FROM jsonb_array_elements(s->'rows') WITH ORDINALITY AS x(r, o)) = ARRAY[1,2,3,4,5,6,7,8,9,10,11,12,13,14], 'read', NULL, 'rows are not 1 to 14');
 PERFORM pg_temp.sc2_check(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'rows') r, jsonb_array_elements(r->'lanes') l
   WHERE l->>'status' NOT IN ('green', 'amber', 'red') OR NOT (l ? 'number' AND l ? 'green' AND l ? 'amber' AND l ? 'unit' AND l ? 'value' AND l ? 'lane')),
  'read', NULL, 'a lane lacks status, number or thresholds');
 PERFORM pg_temp.sc2_check(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'rows') r
   WHERE r->>'status' <> CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(r->'lanes') l WHERE l->>'status' = 'red') THEN 'red'
                              WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(r->'lanes') l WHERE l->>'status' = 'amber') THEN 'amber' ELSE 'green' END)
  AND (s->'summary'->>'red')::integer = jsonb_array_length(s->'summary'->'red_rows'), 'read', NULL, 'a row is not its worst lane');
 PERFORM pg_temp.sc2_check(s ? 'live_jobs' AND s ? 'monitored_jobs' AND s ? 'leads_not_followed_up'
  AND s->'scope'->>'rule' = 'context_lead_monitored_jobs', 'read', NULL, 'the card does not carry its scope');
 SELECT array_agg(l->>'lane' ORDER BY o) INTO lanes FROM jsonb_array_elements(pg_temp.sc2_row(s, 3)->'lanes') WITH ORDINALITY AS x(l, o);
 PERFORM pg_temp.sc2_check(lanes = ARRAY['customer_facing', 'xero_and_quotes', 'review_queue', 'known_misfiles', 'right_job_customer_facing',
   'right_job_xero_and_quotes'], 'read', 3, 'row 3 lanes are ' || coalesce(array_to_string(lanes, ','), 'none'));
 SELECT array_agg(l->>'lane' ORDER BY o) INTO lanes FROM jsonb_array_elements(pg_temp.sc2_row(s, 6)->'lanes') WITH ORDINALITY AS x(l, o);
 PERFORM pg_temp.sc2_check(lanes = ARRAY['live_unread', 'backlog_unread', 'failed_reads_today'], 'read', 6,
  'row 6 lanes are ' || coalesce(array_to_string(lanes, ','), 'none'));
 SELECT array_agg(l->>'lane' ORDER BY o) INTO lanes FROM jsonb_array_elements(pg_temp.sc2_row(s, 7)->'lanes') WITH ORDINALITY AS x(l, o);
 PERFORM pg_temp.sc2_check(lanes = ARRAY['fact_catalogue', 'fact_grade'], 'read', 7, 'row 7 lanes are ' || coalesce(array_to_string(lanes, ','), 'none'));
 SELECT array_agg(l->>'lane' ORDER BY o) INTO lanes FROM jsonb_array_elements(pg_temp.sc2_row(s, 8)->'lanes') WITH ORDINALITY AS x(l, o);
 PERFORM pg_temp.sc2_check(lanes = ARRAY['answer_grade'], 'read', 8, 'row 8 lanes are ' || coalesce(array_to_string(lanes, ','), 'none'));
 SELECT array_agg(l->>'lane' ORDER BY o) INTO lanes FROM jsonb_array_elements(pg_temp.sc2_row(s, 9)->'lanes') WITH ORDINALITY AS x(l, o);
 PERFORM pg_temp.sc2_check(lanes = ARRAY['agent_test', 'story_test'], 'read', 9, 'row 9 lanes are ' || coalesce(array_to_string(lanes, ','), 'none'));
 SELECT array_agg(l->>'lane' ORDER BY o) INTO lanes FROM jsonb_array_elements(pg_temp.sc2_row(s, 10)->'lanes') WITH ORDINALITY AS x(l, o);
 PERFORM pg_temp.sc2_check(lanes = ARRAY['scorecard', 'hourly_run'], 'read', 10, 'row 10 lanes are ' || coalesce(array_to_string(lanes, ','), 'none'));
 SELECT array_agg(l->>'lane' ORDER BY o) INTO lanes FROM jsonb_array_elements(pg_temp.sc2_row(s, 14)->'lanes') WITH ORDINALITY AS x(l, o);
 PERFORM pg_temp.sc2_check(lanes = ARRAY['email_depth', 'texts_calls_depth', 'email_history_window', 'email_reach'], 'read', 14,
  'row 14 lanes are ' || coalesce(array_to_string(lanes, ','), 'none'));
 -- Row 10 carries the done definition's words.
 PERFORM pg_temp.sc2_check(pg_temp.sc2_row(s, 10)->>'green_when' LIKE '%Rayleigh runs it hourly and reports only red rows%', 'read', 10,
  'row 10 green_when does not carry the done definition''s words');
 PERFORM pg_temp.sc2_check(pg_temp.sc2_row(s, 6)->>'green_when' LIKE '%live AI reading (the job ledger)%', 'read', 6,
  'row 6 green_when does not name the AI reader');
 -- Staff-facing words carry no em or en dash.
 PERFORM pg_temp.sc2_check(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'rows') r, jsonb_array_elements(r->'lanes') l
   WHERE concat(l->>'value', l->>'note', l->>'unit', r->>'green_when', r->>'stage') ~ '[\u2014\u2013]'), 'read', NULL,
  'staff-facing words carry an em or en dash');
 PERFORM pg_temp.sc2_check(j->>'version' = 'context-scorecard-jobs-v2' AND jsonb_typeof(j->'jobs') = 'array'
  AND j->'rows_measured' = '[2, 4, 6, 11, 12, 13, 14]'::jsonb AND j->'sampled_rows' = '[7, 8, 9]'::jsonb, 'read', NULL, 'jobs page shape wrong');
 PERFORM pg_temp.sc2_raise('read');
END $ro$;
ROLLBACK;

-- 3. Fixtures: twelve monitored live jobs, a lead no longer followed up, a lost
-- job and a holding job; messages in every graded state; ledger readings
-- (live, retired, shadow); grades of every kind; a placement sample; the
-- hourly run and its receipt; a mailbox whose live floor reaches the jobs' starts.
BEGIN;
SET LOCAL session_replication_role = replica;
ALTER TABLE public.business_events ALTER COLUMN context_captured_at SET DEFAULT '2026-07-01 00:00Z',
 ALTER COLUMN recorded_at SET DEFAULT '2026-07-01 00:00Z', ALTER COLUMN occurred_at SET DEFAULT '2026-07-01 00:00Z';
ALTER TABLE public.jobs ALTER COLUMN created_at SET DEFAULT '2026-07-01 00:00Z', ALTER COLUMN updated_at SET DEFAULT '2026-07-01 00:00Z';
ALTER TABLE public.job_documents ALTER COLUMN created_at SET DEFAULT '2026-07-01 00:00Z';
ALTER TABLE public.xero_invoices ALTER COLUMN created_at SET DEFAULT '2026-07-01 00:00Z', ALTER COLUMN updated_at SET DEFAULT '2026-07-01 00:00Z';
ALTER TABLE public.context_ledger_generations ALTER COLUMN created_at SET DEFAULT '2026-07-01 00:00Z',
 ALTER COLUMN updated_at SET DEFAULT '2026-07-01 00:00Z';
ALTER TABLE public.context_ledger_items ALTER COLUMN created_at SET DEFAULT '2026-07-01 00:00Z',
 ALTER COLUMN updated_at SET DEFAULT '2026-07-01 00:00Z';
ALTER TABLE public.context_extraction_runs ALTER COLUMN started_at SET DEFAULT '2026-07-01 00:00Z';
ALTER TABLE public.context_capture_runs ALTER COLUMN started_at SET DEFAULT '2026-07-01 00:00Z',
 ALTER COLUMN updated_at SET DEFAULT '2026-07-01 00:00Z';
ALTER TABLE public.context_ghl_history_contacts ALTER COLUMN first_attempt_at SET DEFAULT '2026-07-01 00:00Z',
 ALTER COLUMN last_attempt_at SET DEFAULT '2026-07-01 00:00Z';
ALTER TABLE public.context_ghl_history_link_attempts ALTER COLUMN first_attempt_at SET DEFAULT '2026-07-01 00:00Z',
 ALTER COLUMN last_attempt_at SET DEFAULT '2026-07-01 00:00Z';
ALTER TABLE public.monitored_mailboxes ALTER COLUMN created_at SET DEFAULT '2026-07-01 00:00Z',
 ALTER COLUMN updated_at SET DEFAULT '2026-07-01 00:00Z';
ALTER TABLE public.context_grades ALTER COLUMN created_at SET DEFAULT '2026-07-01 00:00Z';
ALTER TABLE public.context_placement_grades ALTER COLUMN created_at SET DEFAULT '2026-07-01 00:00Z';

-- Every job and mailbox already in the stack leaves the live list and the
-- selected mailboxes for this transaction, so the job rows count the fixtures only.
UPDATE public.jobs SET status = 'lost' WHERE status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost');
UPDATE public.monitored_mailboxes SET enabled = false WHERE enabled;
CREATE TEMP TABLE sc2_before ON COMMIT DROP AS SELECT public.context_scorecard('2026-10-07 04:00Z') AS s;

-- The jobs. J01 to J12 accepted (monitored); A1 a quoted lead whose quote went
-- 67 days ago with no progress and no customer message (not followed up); L1
-- lost; H1 a holding job (the placeholder, archived, do_not_schedule).
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_email, ghl_contact_id, metadata, created_at, updated_at)
SELECT ('5d000000-0000-4000-8000-0000000000' || lpad(g::text, 2, '0'))::uuid, '00000000-0000-4000-8000-0000000000aa',
       'SWF-SC2' || lpad(g::text, 2, '0'), 'accepted', 'fencing',
       CASE WHEN g = 12 THEN NULL ELSE 'sc2.' || g || '@example.test' END,
       CASE WHEN g = 1 THEN 'ctSC2a01' END, '{}'::jsonb, '2026-09-01 02:00Z', '2026-09-01 02:00Z'
FROM generate_series(1, 12) g;
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_email, ghl_contact_id, metadata, quoted_at, created_at, updated_at)
VALUES ('5d000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000aa', 'SWF-SC2A1', 'quoted', 'fencing',
        'sc2.a1@example.test', 'ctSC2aA1', '{}', NULL, '2026-07-20 02:00Z', '2026-07-20 02:00Z'),
       ('5d000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000aa', 'SWF-SC2L1', 'lost', 'fencing',
        'sc2.l1@example.test', NULL, '{}', NULL, '2026-07-20 02:00Z', '2026-07-20 02:00Z'),
       ('5d000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000aa', 'SWF-SC2HOLD', 'archived', 'fencing',
        NULL, NULL, '{"do_not_schedule": true}', NULL, '2026-04-01 02:00Z', '2026-04-01 02:00Z');
INSERT INTO public.job_documents (id, job_id, type, quote_number, version, created_at, sent_at)
VALUES ('5d0d0000-0000-4000-8000-0000000000a1', '5d000000-0000-4000-8000-0000000000a1', 'quote', 'Q-SC2A1', 1,
        '2026-08-01 01:00Z', '2026-08-01 02:00Z');

-- Messages (texts unless named). r = 5de0..., placed with full confidence.
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, metadata, body_preview, payload, contact_id,
  occurred_at, recorded_at, context_captured_at, event_at, attribution_status, attribution_confidence, candidate_job_ids)
VALUES
 -- Row 2 and 3: on J01, a stamp naming both sides (v4) and one naming one side, stamped by v3.
 ('5de00000-0000-4000-8000-000000000201', '5d000000-0000-4000-8000-000000000001', 'client.reply', 'ghl-message-reconcile', 'sms', 'inbound',
  '{"capture_mode":"live","party_roles":{"version":"party_roles_v4","sender_role":"customer","recipient_role":"staff","counterpart_role":"customer","basis":"job_customer","audience":"customer"}}',
  'Can you come Monday?', '{}', 'ctSC2a01', '2026-10-06 01:00Z', '2026-10-06 01:00Z', '2026-10-06 01:00Z', '2026-10-06 01:00Z', 'direct', 1, NULL),
 ('5de00000-0000-4000-8000-000000000202', '5d000000-0000-4000-8000-000000000001', 'client.reply', 'ghl-message-reconcile', 'sms', 'inbound',
  '{"capture_mode":"live","party_roles":{"version":"party_roles_v3","sender_role":"unknown","recipient_role":"staff","counterpart_role":"unknown","basis":"none","audience":"unknown"}}',
  'Who is this please', '{}', 'ctSC2a01', '2026-10-06 01:10Z', '2026-10-06 01:10Z', '2026-10-06 01:10Z', '2026-10-06 01:10Z', 'direct', 1, NULL),
 -- Row 3: a customer's text on J02; a prospect's text on no job (a CRM opportunity, no job yet); a customer's text in the bucket.
 ('5de00000-0000-4000-8000-000000000301', '5d000000-0000-4000-8000-000000000002', 'client.reply', 'ghl-message-reconcile', 'sms', 'inbound',
  '{"capture_mode":"live","party_roles":{"version":"party_roles_v4","sender_role":"customer","recipient_role":"staff","counterpart_role":"customer","basis":"job_customer","audience":"customer"}}',
  'Gate is open', '{}', NULL, '2026-10-06 02:00Z', '2026-10-06 02:00Z', '2026-10-06 02:00Z', '2026-10-06 02:00Z', 'direct', 1, NULL),
 ('5de00000-0000-4000-8000-000000000302', NULL, 'client.reply', 'ghl-message-reconcile', 'sms', 'inbound',
  '{"capture_mode":"live","party_roles":{"version":"party_roles_v4","sender_role":"customer","recipient_role":"staff","counterpart_role":"customer","basis":"open_opportunity","audience":"customer"}}',
  'How much for a fence', '{}', 'ctSC2p01', '2026-10-06 02:10Z', '2026-10-06 02:10Z', '2026-10-06 02:10Z', '2026-10-06 02:10Z', 'unplaced', NULL, NULL),
 ('5de00000-0000-4000-8000-000000000303', NULL, 'client.reply', 'ghl-message-reconcile', 'sms', 'inbound',
  '{"capture_mode":"live","party_roles":{"version":"party_roles_v4","sender_role":"customer","recipient_role":"staff","counterpart_role":"customer","basis":"contact_jobs","audience":"customer"}}',
  'Thanks', '{}', 'ctSC2c01', '2026-10-06 02:20Z', '2026-10-06 02:20Z', '2026-10-06 02:20Z', '2026-10-06 02:20Z', 'admin_bucket', NULL, NULL),
 -- Row 3 misfiles: two rows on the holding job (one a customer text in the window), and a row on J03 whose payload names J04.
 ('5de00000-0000-4000-8000-000000000311', '5d000000-0000-4000-8000-0000000000b1', 'client.reply', 'ghl-message-reconcile', 'sms', 'inbound',
  '{"capture_mode":"live","party_roles":{"version":"party_roles_v4","sender_role":"customer","recipient_role":"staff","counterpart_role":"customer","basis":"job_customer","audience":"customer"}}',
  'Is this the fence company', '{}', NULL, '2026-10-05 02:00Z', '2026-10-05 02:00Z', '2026-10-05 02:00Z', '2026-10-05 02:00Z', 'direct', 1, NULL),
 ('5de00000-0000-4000-8000-000000000312', '5d000000-0000-4000-8000-0000000000b1', 'client.email_in', 'outlook-mail-capture', 'email', 'inbound',
  '{"capture_mode":"backfill"}', 'Old mail', '{}', NULL, '2026-08-01 02:00Z', '2026-08-01 02:00Z', '2026-08-01 02:00Z', '2026-08-01 02:00Z', 'direct', 1, NULL),
 ('5de00000-0000-4000-8000-000000000313', '5d000000-0000-4000-8000-000000000003', 'client.reply', 'ghl-sms-backfill', 'sms', 'inbound',
  '{"capture_mode":"backfill"}', 'Payload guess', '{"job_id":"5d000000-0000-4000-8000-000000000004"}', NULL,
  '2026-09-20 02:00Z', '2026-09-20 02:00Z', '2026-09-20 02:00Z', '2026-09-20 02:00Z', 'single_open', 1, NULL),
 -- Row 4: Xero evidence on J05 (its live invoice below).
 ('5de00000-0000-4000-8000-000000000401', '5d000000-0000-4000-8000-000000000005', 'invoice.raised', 'xero-history', 'invoice', 'internal',
  '{"capture_mode":"backfill"}', NULL, '{}', NULL, '2026-09-10 02:00Z', '2026-09-10 02:00Z', '2026-09-10 02:00Z', '2026-09-10 02:00Z', 'direct', 1, NULL),
 -- Row 6: on J03, one row its live reading has read, one unread for 3 hours (late), one unread for 30 minutes.
 ('5de00000-0000-4000-8000-000000000601', '5d000000-0000-4000-8000-000000000003', 'client.reply', 'ghl-message-reconcile', 'sms', 'inbound',
  '{"capture_mode":"live","party_roles":{"version":"party_roles_v4","sender_role":"customer","recipient_role":"staff","counterpart_role":"customer","basis":"job_customer","audience":"customer"}}',
  'Read already', '{}', NULL, '2026-10-06 10:00Z', '2026-10-06 10:00Z', '2026-10-06 10:00Z', '2026-10-06 10:00Z', 'direct', 1, NULL),
 ('5de00000-0000-4000-8000-000000000602', '5d000000-0000-4000-8000-000000000003', 'client.reply', 'ghl-message-reconcile', 'sms', 'inbound',
  '{"capture_mode":"live","party_roles":{"version":"party_roles_v4","sender_role":"customer","recipient_role":"staff","counterpart_role":"customer","basis":"job_customer","audience":"customer"}}',
  'Three hours unread', '{}', NULL, '2026-10-07 01:00Z', '2026-10-07 01:00Z', '2026-10-07 01:00Z', '2026-10-07 01:00Z', 'direct', 1, NULL),
 ('5de00000-0000-4000-8000-000000000603', '5d000000-0000-4000-8000-000000000003', 'client.reply', 'ghl-message-reconcile', 'sms', 'inbound',
  '{"capture_mode":"live","party_roles":{"version":"party_roles_v4","sender_role":"customer","recipient_role":"staff","counterpart_role":"customer","basis":"job_customer","audience":"customer"}}',
  'Half an hour unread', '{}', NULL, '2026-10-07 03:30Z', '2026-10-07 03:30Z', '2026-10-07 03:30Z', '2026-10-07 03:30Z', 'direct', 1, NULL),
 -- Row 6: on J04 (no live reading; a passing shadow has read it), a history row unread for 52 hours.
 ('5de00000-0000-4000-8000-000000000604', '5d000000-0000-4000-8000-000000000004', 'client.reply', 'ghl-sms-backfill', 'sms', 'inbound',
  '{"capture_mode":"backfill","party_roles":{"version":"party_roles_v4","sender_role":"customer","recipient_role":"staff","counterpart_role":"customer","basis":"job_customer","audience":"customer"}}',
  'History text', '{}', NULL, '2026-09-02 02:00Z', '2026-10-05 00:00Z', '2026-10-05 00:00Z', '2026-09-02 02:00Z', 'direct', 1, NULL),
 -- Scope: on the lead no longer followed up, our own text (never the customer's message), unread; never counted.
 ('5de00000-0000-4000-8000-000000000605', '5d000000-0000-4000-8000-0000000000a1', 'client.sms_out', 'ops-api', 'sms', 'outbound',
  '{"capture_mode":"live","party_roles":{"version":"party_roles_v4","sender_role":"staff","recipient_role":"customer","counterpart_role":"customer","basis":"job_customer","audience":"customer"}}',
  'Just checking in on the quote', '{}', 'ctSC2aA1', '2026-10-07 00:00Z', '2026-10-07 00:00Z', '2026-10-07 00:00Z', '2026-10-07 00:00Z', 'direct', 1, NULL);

-- Row 4: J01's CRM contact is loaded; J02 has no contact and the link step tried it.
INSERT INTO public.context_capture_runs (id, source, status, started_at, updated_at, finished_at, cursor, counts)
VALUES ('5dc00000-0000-4000-8000-000000000001', 'ghl_history_load', 'succeeded', '2026-10-01 02:00Z', '2026-10-01 02:10Z', '2026-10-01 02:10Z', '{}', '{}'),
       -- the mailbox's live floor: its first poll window (row 14)
       ('5dc00000-0000-4000-8000-000000000002', 'outlook_sc2box', 'succeeded', '2026-07-01 00:05Z', '2026-07-01 00:06Z', '2026-07-01 00:06Z', '{}', '{}');
UPDATE public.context_capture_runs SET window_from = '2026-07-01 00:00Z', window_to = '2026-07-01 00:05Z'
WHERE id = '5dc00000-0000-4000-8000-000000000002';
INSERT INTO public.context_ghl_history_contacts (contact_id, status, last_run_id, completed_at, job_ids, jobs, actor)
VALUES ('ctSC2a01', 'done', '5dc00000-0000-4000-8000-000000000001', '2026-10-01 02:10Z', ARRAY['5d000000-0000-4000-8000-000000000001'::uuid], 1, 'contract:sc2');
INSERT INTO public.context_ghl_history_link_attempts (job_id, verdict, reason, last_run_id, actor)
VALUES ('5d000000-0000-4000-8000-000000000002', 'none', 'not_in_ghl', '5dc00000-0000-4000-8000-000000000001', 'contract:sc2');
INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, total, job_id, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-0000000000aa', 'sc2-x-5', 'INV-SC205', 'ACCREC', 'AUTHORISED', 1500, '5d000000-0000-4000-8000-000000000005',
        '2026-09-10 02:00Z', '2026-09-10 02:00Z');

-- The ledger: a live reading on J01 to J11 except J04 (J03's has read up to 6 Oct 12:00Z, the others
-- to the instant); J04 has a passing shadow that has read its history row; J12 has none.
INSERT INTO public.context_ledger_generations (id, job_id, kind, status, reader, model, evidence_until, checks, created_at, finished_at,
  promoted_at, updated_at)
SELECT ('5d9e0000-0000-4000-8000-0000000000' || lpad(g::text, 2, '0'))::uuid, ('5d000000-0000-4000-8000-0000000000' || lpad(g::text, 2, '0'))::uuid,
       'backfill', 'live', 'luna-ledger:v1', 'claude-sc2',
       CASE WHEN g = 3 THEN '2026-10-06 12:00Z'::timestamptz ELSE '2026-10-07 04:00Z'::timestamptz END, '{"passed": true}',
       '2026-10-05 23:00Z', '2026-10-05 23:30Z', '2026-10-06 00:00Z', '2026-10-06 00:00Z'
FROM generate_series(1, 11) g WHERE g <> 4;
INSERT INTO public.context_ledger_generations (id, job_id, kind, status, reader, model, evidence_until, checks, created_at, finished_at, updated_at)
VALUES ('5d9e0000-0000-4000-8000-0000000000f4', '5d000000-0000-4000-8000-000000000004', 'backfill', 'shadow', 'luna-ledger:v1', 'claude-sc2',
        '2026-10-07 00:00Z', '{"passed": true}', '2026-10-07 00:10Z', '2026-10-07 00:20Z', '2026-10-07 00:20Z');
-- Phase notes on J01 and J02's live readings (row 11).
INSERT INTO public.context_ledger_items (generation_id, job_id, item_key, item_type, status, from_role, what, phase, opened_at, opened_by, written_by)
SELECT ('5d9e0000-0000-4000-8000-0000000000' || lpad(g::text, 2, '0'))::uuid, ('5d000000-0000-4000-8000-0000000000' || lpad(g::text, 2, '0'))::uuid,
       'phase:quote', 'phase_note', 'info', 'us', 'The quote went out and was accepted.', 'quote', '2026-09-02 02:00Z',
       '[{"table": "jobs", "id": "x"}]', 'model:claude-sc2'
FROM generate_series(1, 2) g;

-- Row 6: today's ledger reads (Perth 7 Oct): one done, one failed, one that failed its checks; a released
-- run and an old fact reader's failure never count.
INSERT INTO public.context_extraction_runs (job_id, run_date, phase, started_at, finished_at, status, error)
VALUES ('5d000000-0000-4000-8000-000000000001', '2026-10-07', 'ledger', '2026-10-07 01:00Z', '2026-10-07 01:05Z', 'done', NULL),
       ('5d000000-0000-4000-8000-000000000002', '2026-10-07', 'ledger', '2026-10-07 01:10Z', '2026-10-07 01:15Z', 'failed', 'model_error'),
       ('5d000000-0000-4000-8000-000000000003', '2026-10-07', 'ledger', '2026-10-07 01:20Z', '2026-10-07 01:25Z', 'done', 'checks_failed'),
       ('5d000000-0000-4000-8000-000000000005', '2026-10-07', 'ledger', '2026-10-07 01:30Z', '2026-10-07 01:35Z', 'failed', 'released:busy'),
       ('5d000000-0000-4000-8000-000000000006', '2026-10-07', 'extraction', '2026-10-07 01:40Z', '2026-10-07 01:45Z', 'failed', 'old_reader');

-- Rows 7, 8 and 9: one sample of each kind on the ten jobs with a live reading, every bar met.
INSERT INTO public.context_grades (kind, sample_id, job_id, unit, generation_id, reading_model, item_type, story_flag, ledger_mode, gated,
  verdicts, grader, as_of, graded_at, created_at)
SELECT 'ledger', 'ledger-sc2-1', j.job, ('5d1e0000-0000-4000-8000-0000000000' || lpad(j.g::text, 2, '0')), j.gen, 'claude-sc2', 'commitment',
       NULL, NULL, true, '{"verbatim": "pass", "parties": "pass", "supported": "pass", "unsafe": 0}', 'grader-1',
       '2026-10-06 04:00Z', '2026-10-06 06:00Z', '2026-10-06 06:00Z'
FROM (SELECT g, ('5d000000-0000-4000-8000-0000000000' || lpad(g::text, 2, '0'))::uuid AS job,
             ('5d9e0000-0000-4000-8000-0000000000' || lpad(g::text, 2, '0'))::uuid AS gen
      FROM generate_series(1, 11) g WHERE g <> 4) j;
INSERT INTO public.context_grades (kind, sample_id, job_id, unit, generation_id, reading_model, item_type, story_flag, ledger_mode, gated,
  verdicts, grader, as_of, graded_at, created_at)
SELECT 'story', 'story-sc2-1', j.job, 'story', j.gen, 'claude-sc2', NULL, NULL, NULL, true,
       jsonb_build_object('timeline', 'pass', 'record_loops', 'pass',
        'recall', '{"money": {"found": 1, "total": 1}, "record": {"found": 2, "total": 2}, "message": {"found": 3, "total": 3}}'::jsonb,
        'precision', '{"real": 4, "shown": 4}'::jsonb, 'first_line', 'pass', 'first_line_set', CASE WHEN j.g <= 8 THEN 'known' ELSE 'unseen' END,
        'unsafe', 0, 'money', 'pass', 'dates', 'pass', 'honesty', 'pass'),
       'grader-2', '2026-10-06 04:00Z', '2026-10-06 06:00Z', '2026-10-06 06:00Z'
FROM (SELECT g, ('5d000000-0000-4000-8000-0000000000' || lpad(g::text, 2, '0'))::uuid AS job,
             ('5d9e0000-0000-4000-8000-0000000000' || lpad(g::text, 2, '0'))::uuid AS gen
      FROM generate_series(1, 11) g WHERE g <> 4) j;
INSERT INTO public.context_grades (kind, sample_id, job_id, unit, generation_id, reading_model, item_type, story_flag, ledger_mode, gated,
  verdicts, grader, as_of, graded_at, created_at)
SELECT 'agent', 'agent-sc2-1', j.job, q.unit, j.gen, 'claude-sc2', NULL, true, 'shadow', q.gated,
       CASE WHEN q.unit = 'story' THEN '{"loops": {"covered": 2, "applicable": 2}, "unsafe": 0, "action_cards": 0, "story_tool": true}'::jsonb
            WHEN q.unit = 'period' THEN '{"answer": "correct", "unsafe": 0, "action_cards": 0, "story_tool": false}'::jsonb
            ELSE '{"answer": "correct", "unsafe": 0, "action_cards": 0, "story_tool": true}'::jsonb END,
       'grader-3', '2026-10-06 04:00Z', '2026-10-06 06:00Z', '2026-10-06 06:00Z'
FROM (SELECT g, ('5d000000-0000-4000-8000-0000000000' || lpad(g::text, 2, '0'))::uuid AS job,
             ('5d9e0000-0000-4000-8000-0000000000' || lpad(g::text, 2, '0'))::uuid AS gen
      FROM generate_series(1, 11) g WHERE g <> 4) j
CROSS JOIN (VALUES ('where_at', true), ('last_told', true), ('owed', true), ('story', true), ('period', false)) q(unit, gated)
WHERE q.unit <> 'period' OR j.g = 1;

-- Row 3: a whole graded customer-facing sample of 100 (98 right) drawn as of 6 Oct; none for Xero and quotes.
INSERT INTO public.context_placement_grades (sample_id, population, as_of, pos, drawn, draw_digest, population_rows, population_all, event_id,
  placed_job_id, stratum, stratum_rows, stratum_drawn, verdict, reason, right_job_id, grader, graded_at, created_at)
SELECT 'placement-cf-sc2-1', 'customer_facing', '2026-10-06 04:00Z', g, 100, md5('sc2-draw'), 100, 100,
       ('5d7e0000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '5d000000-0000-4000-8000-000000000001', 'single_open', 100, 100,
       CASE WHEN g <= 98 THEN 'right' WHEN g = 99 THEN 'wrong' ELSE 'unsure' END,
       CASE WHEN g = 99 THEN 'no_job' WHEN g = 100 THEN 'several_jobs' END, NULL, 'grader-4', '2026-10-06 05:00Z', '2026-10-06 05:00Z'
FROM generate_series(1, 100) g;

-- Row 4 and 10: a pg_cron stand-in holding the three history jobs and the hourly job, all active.
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, schedule text NOT NULL, command text NOT NULL, active boolean NOT NULL DEFAULT true, jobname text);
INSERT INTO cron.job (jobname, schedule, command) VALUES
 ('ghl-history-schedule', '*/15 * * * *', 'SELECT 1'), ('outlook-mail-poll', '*/5 * * * *', 'SELECT 1'),
 ('xero-history-daily', '30 19 * * *', 'SELECT public.trigger_xero_history_daily() WHERE public.automation_lane_enabled(''capture'')');
INSERT INTO cron.job (jobname, schedule, command)
SELECT p->>'cron_job', p->>'schedule', p->>'command' FROM (SELECT public.context_scorecard_run_policy() AS p) x;
-- Row 10: the hourly run 20 minutes before the instant, and Rayleigh's receipt 15 minutes before it.
INSERT INTO public.context_scorecard_runs (run_trigger, as_of, started_at, finished_at, duration_ms, status, scorecard_version, live_jobs, summary,
  row_status, red_rows, red_lanes)
VALUES ('cron', '2026-10-07 03:40Z', '2026-10-07 03:40Z', '2026-10-07 03:40:01Z', 1100, 'ok', 'context-scorecard-v2', 13, '{}', '[]', '{}', '{}');
INSERT INTO public.context_scorecard_receipts (run_id, reader, received_at, kind, red_rows)
SELECT max(r.id), 'rayleigh', '2026-10-07 03:45Z', 'all_clear', '{}' FROM public.context_scorecard_runs r WHERE r.as_of = '2026-10-07 03:40Z';
-- Row 14: one selected mailbox whose live reading reaches back before every fixture job's lead-in.
INSERT INTO public.monitored_mailboxes (email, display_name, scope_label, enabled, status, source_key, kind, updated_by)
VALUES ('sc2box@example.test', 'SC2 box', 'admin', true, 'active', 'sc2box', 'user', 'contract:sc2');

SAVEPOINT sc2_card;
DO $card$
DECLARE s jsonb := public.context_scorecard('2026-10-07 04:00Z'); s0 jsonb := (SELECT b.s FROM sc2_before b); l jsonb; l0 jsonb;
 a integer[]; a0 integer[];
BEGIN
 -- Scope: twelve monitored live jobs; the lead no longer followed up is live but out.
 PERFORM pg_temp.sc2_check((s->>'live_jobs')::integer = 13 AND (s->>'monitored_jobs')::integer = 12 AND (s->>'leads_not_followed_up')::integer = 1,
  'card', NULL, format('scope wrong: live %s, monitored %s, not followed up %s', s->>'live_jobs', s->>'monitored_jobs', s->>'leads_not_followed_up'));

 -- Row 2: the stored stamps through the v4 read: +12 texts, +10 naming both sides (J01's v3 stamp names
 -- one side; the misfiled row carries none), the v3 stamp named as older.
 l := pg_temp.sc2_lane(s, 2, 'texts'); l0 := pg_temp.sc2_lane(s0, 2, 'texts');
 a := pg_temp.sc2_ab(l->>'value'); a0 := pg_temp.sc2_ab(l0->>'value');
 PERFORM pg_temp.sc2_check(a[1] - a0[1] = 10 AND a[2] - a0[2] = 12, 'card', 2, 'texts lane counts wrong: ' || coalesce(l->>'value', 'no lane'));
 PERFORM pg_temp.sc2_check(l->>'note' LIKE '% stamped before party_roles_v4 (context_party_roles_lanes)'
  AND (substring(l->>'note' FROM '; ([0-9]+) stamped before'))::integer - (substring(l0->>'note' FROM '; ([0-9]+) stamped before'))::integer = 1,
  'card', 2, 'texts lane does not name the older stamps: ' || coalesce(l->>'note', 'no lane'));

 -- Row 3: a prospect with no job yet is left out of the customers; misfiles count the holding job; the graded samples.
 l := pg_temp.sc2_lane(s, 3, 'customer_facing'); l0 := pg_temp.sc2_lane(s0, 3, 'customer_facing');
 a := pg_temp.sc2_ab(l->>'value'); a0 := pg_temp.sc2_ab(l0->>'value');
 -- customers +9 (J01, J02, J03 x3, J04, the lead, the holding job and the bucket text; the prospect
 -- left out), on a job +8.
 PERFORM pg_temp.sc2_check(a[1] - a0[1] = 8 AND a[2] - a0[2] = 9 AND l->>'value' ~ '^[0-9]+ of [0-9]+ customer messages in 30 days are on a job$',
  'card', 3, 'customer_facing wrong (a prospect with no job is not a customer to place): ' || coalesce(l->>'value', 'no lane'));
 PERFORM pg_temp.sc2_check((substring(l->>'note' FROM '; ([0-9]+) messages from prospects'))::integer
  - (substring(l0->>'note' FROM '; ([0-9]+) messages from prospects'))::integer = 1, 'card', 3, 'customer_facing note wrong: ' || coalesce(l->>'note', ''));
 l := pg_temp.sc2_lane(s, 3, 'known_misfiles'); l0 := pg_temp.sc2_lane(s0, 3, 'known_misfiles');
 PERFORM pg_temp.sc2_check((l->>'number')::integer - (l0->>'number')::integer = 3 AND l->>'status' = 'red'
  AND l->>'value' LIKE '%on a holding job%', 'card', 3, 'known_misfiles must count the payload misfile and both rows on the holding job: '
  || coalesce(l->>'value', 'no lane'));
 l := pg_temp.sc2_lane(s, 3, 'right_job_customer_facing');
 PERFORM pg_temp.sc2_check((l->>'number')::numeric = 98.00 AND l->>'status' = 'green' AND l->>'value' LIKE '98 right, 1 wrong, 1 unsure of 100 drawn%',
  'card', 3, 'right_job_customer_facing wrong on a whole sample: ' || coalesce(l::text, 'no lane'));
 l := pg_temp.sc2_lane(s, 3, 'right_job_xero_and_quotes');
 PERFORM pg_temp.sc2_check(l->>'status' = 'red' AND l->'number' = 'null'::jsonb AND l->>'note' LIKE 'no graded sample%', 'card', 3,
  'right_job_xero_and_quotes must be red with no sample: ' || coalesce(l::text, 'no lane'));

 -- Row 4: done = loaded or tried with no CRM contact, of the monitored jobs; the Xero top-up's cron job counts.
 l := pg_temp.sc2_lane(s, 4, 'ghl_history');
 PERFORM pg_temp.sc2_check(l->>'value' = '2 of 12 monitored live jobs have their CRM texts, calls and emails: 1 loaded, 1 tried with no CRM contact; 10 missing'
  AND (l->>'number')::numeric = 16.6 AND l->>'status' = 'red' AND l->>'note' LIKE '%desk decision B-2%'
  AND l->>'note' LIKE '%Every live job has its past GHL texts/calls/emails%' AND l->>'note' NOT LIKE '%not deciding%',
  'card', 4, 'ghl_history wrong: ' || coalesce(l::text, 'no lane'));
 l := pg_temp.sc2_lane(s, 4, 'history_schedules');
 PERFORM pg_temp.sc2_check((l->>'number')::integer = 0 AND l->>'status' = 'green', 'card', 4,
  'history_schedules must read the xero-history-daily job: ' || coalesce(l::text, 'no lane'));
 l := pg_temp.sc2_lane(s, 4, 'xero_history');
 PERFORM pg_temp.sc2_check(l->>'value' = '1 of 1 monitored live jobs with a live Xero invoice carry Xero evidence'
  AND l->>'note' LIKE '%daily top-up xero-history-daily%', 'card', 4, 'xero_history wrong: ' || coalesce(l::text, 'no lane'));

 -- Row 6: the AI reader. J03: 2 live rows unread, 1 of them late; J04: a history row unread 52 hours (its
 -- shadow read it, but a shadow is not live); the lead's row is out of scope.
 l := pg_temp.sc2_lane(s, 6, 'live_unread');
 PERFORM pg_temp.sc2_check((l->>'number')::integer = 1 AND l->>'status' = 'red' AND l->>'value' = '1 late of 2 live items unread; oldest 3.0 h',
  'card', 6, 'live_unread wrong: ' || coalesce(l->>'value', 'no lane'));
 PERFORM pg_temp.sc2_check(l->>'note' LIKE '%live ledger reading%' AND l->>'note' LIKE '% items on 4 of 12 monitored live jobs, 1 of those jobs with no live reading; 1 unread items are read by a passing shadow reading that is not live',
  'card', 6, 'live_unread note wrong: ' || coalesce(l->>'note', ''));
 l := pg_temp.sc2_lane(s, 6, 'backlog_unread');
 PERFORM pg_temp.sc2_check((l->>'number')::integer = 1 AND l->>'status' = 'red' AND l->>'value' = '1 rows on 1 jobs; oldest 52.0 h', 'card', 6,
  'backlog_unread wrong: ' || coalesce(l->>'value', 'no lane'));
 l := pg_temp.sc2_lane(s, 6, 'failed_reads_today'); l0 := pg_temp.sc2_lane(s0, 6, 'failed_reads_today');
 PERFORM pg_temp.sc2_check(l->>'value' = '2 failed of 3 ledger reads today' AND (l->>'number')::numeric = 66.7 AND l->>'status' = 'red',
  'card', 6, 'failed_reads_today must count today''s ledger reads only: ' || coalesce(l->>'value', 'no lane'));

 -- Row 7: the catalogue (9 kinds) and the ledger grade (10 of 10 on 10 jobs, live readings).
 l := pg_temp.sc2_lane(s, 7, 'fact_catalogue');
 PERFORM pg_temp.sc2_check(l->>'status' = 'green' AND l->>'value' = '9 of 9 kinds published and accepted', 'card', 7,
  'fact_catalogue wrong: ' || coalesce(l->>'value', 'no lane'));
 l := pg_temp.sc2_lane(s, 7, 'fact_grade');
 PERFORM pg_temp.sc2_check(l->>'status' = 'green' AND (l->>'number')::numeric = 100 AND l->>'value' LIKE '10 of 10 items pass on 10 jobs (sample ledger-sc2-1%'
  AND l->>'note' LIKE 'every bar met%', 'card', 7, 'fact_grade wrong: ' || coalesce(l::text, 'no lane'));
 -- Row 8: every bar of the story grade.
 l := pg_temp.sc2_lane(s, 8, 'answer_grade');
 PERFORM pg_temp.sc2_check(l->>'status' = 'green' AND (l->>'number')::integer = 0 AND l->>'note' LIKE 'every bar met%', 'card', 8,
  'answer_grade wrong: ' || coalesce(l::text, 'no lane'));
 -- Row 9 and 9+: 30 of 30 baseline answers and 10 of 10 story calls, story switch on, live readings.
 l := pg_temp.sc2_lane(s, 9, 'agent_test');
 PERFORM pg_temp.sc2_check(l->>'status' = 'green' AND (l->>'number')::numeric = 100 AND l->>'value' LIKE '30 of 30 baseline answers correct on 10 jobs%'
  AND l->>'note' LIKE '%0 calls answered without a story tool (listed, not gated)%', 'card', 9, 'agent_test wrong: ' || coalesce(l::text, 'no lane'));
 l := pg_temp.sc2_lane(s, 9, 'story_test');
 PERFORM pg_temp.sc2_check(l->>'status' = 'green' AND l->>'value' = '10 of 10 story calls pass; loops covered 20 of 20', 'card', 9,
  'story_test wrong: ' || coalesce(l::text, 'no lane'));

 -- Row 10: the hourly run, read by Rayleigh.
 l := pg_temp.sc2_lane(s, 10, 'hourly_run');
 PERFORM pg_temp.sc2_check(l->>'status' = 'green' AND (l->>'number')::integer = 0 AND pg_temp.sc2_row(s, 10)->>'status' = 'green', 'card', 10,
  'hourly_run must be the run status lane, green on a received run: ' || coalesce(l::text, 'no lane'));
 PERFORM pg_temp.sc2_check(l = (public.context_scorecard_run_status('2026-10-07 04:00Z')->'lane') - 'row' - 'higher_is_better', 'card', 10,
  'hourly_run is not context_scorecard_run_status''s lane as it is');

 -- Rows 11 to 13, on the monitored jobs.
 l := pg_temp.sc2_lane(s, 12, 'open_loops');
 PERFORM pg_temp.sc2_check(l->>'value' = '10 of 12 monitored live jobs have a live ledger', 'card', 12, 'open_loops wrong: ' || coalesce(l->>'value', 'no lane'));
 l := pg_temp.sc2_lane(s, 11, 'job_story');
 PERFORM pg_temp.sc2_check(l->>'value' LIKE '% of 12 monitored live jobs; 2 have a live ledger with phase notes', 'card', 11,
  'job_story wrong: ' || coalesce(l->>'value', 'no lane'));
 l := pg_temp.sc2_lane(s, 13, 'client_identity');
 PERFORM pg_temp.sc2_check(l->>'value' = '11 of 12 monitored live jobs have a CRM contact or a client email', 'card', 13,
  'client_identity wrong: ' || coalesce(l->>'value', 'no lane'));

 -- Row 14: every monitored job's email history reaches its start (the mailbox read live since 1 Jul).
 l := pg_temp.sc2_lane(s, 14, 'email_reach');
 PERFORM pg_temp.sc2_check(l->>'status' = 'green' AND (l->>'number')::numeric = 100
  AND l->>'value' = '12 of 12 monitored live jobs reach their start; loading 0, short 0, not started 0, unknown start 0'
  AND l->>'note' LIKE 'deep email load off; mailboxes finished 1 of 1%', 'card', 14, 'email_reach wrong: ' || coalesce(l::text, 'no lane'));
 l := pg_temp.sc2_lane(s, 14, 'texts_calls_depth');
 PERFORM pg_temp.sc2_check(l->>'value' LIKE '% of 4 monitored live jobs with texts or calls', 'card', 14,
  'texts_calls_depth must count the monitored jobs only: ' || coalesce(l->>'value', 'no lane'));
 PERFORM pg_temp.sc2_raise('card');
END $card$;
\if :ERROR
ROLLBACK TO SAVEPOINT sc2_card;
\endif

-- Rows 3, 7, 8 and 9 go red on a newer failing sample (each in a savepoint).
SAVEPOINT failing_samples;
INSERT INTO public.context_placement_grades (sample_id, population, as_of, pos, drawn, draw_digest, population_rows, population_all, event_id,
  placed_job_id, stratum, stratum_rows, stratum_drawn, verdict, reason, right_job_id, grader, graded_at, created_at)
SELECT 'placement-cf-sc2-2', 'customer_facing', '2026-10-06 05:00Z', g, 120, md5('sc2-draw-2'), 120, 120,
       ('5d7e0001-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '5d000000-0000-4000-8000-000000000001', 'single_open', 120, 120,
       'right', NULL, NULL, 'grader-4', '2026-10-06 06:00Z', '2026-10-06 06:00Z'
FROM generate_series(1, 110) g;   -- 10 of the 120 drawn never graded
INSERT INTO public.context_grades (kind, sample_id, job_id, unit, generation_id, reading_model, item_type, gated, verdicts, grader, as_of,
  graded_at, created_at)
SELECT 'ledger', 'ledger-sc2-2', g.job_id, g.unit, g.generation_id, g.reading_model, g.item_type, true,
       CASE WHEN g.job_id = '5d000000-0000-4000-8000-000000000001' THEN '{"verbatim": "fail", "parties": "pass", "supported": "pass", "unsafe": 0}'::jsonb
            ELSE g.verdicts END, g.grader, '2026-10-06 04:00Z', '2026-10-06 07:00Z', '2026-10-06 07:00Z'
FROM public.context_grades g WHERE g.sample_id = 'ledger-sc2-1';
INSERT INTO public.context_grades (kind, sample_id, job_id, unit, generation_id, reading_model, gated, verdicts, grader, as_of, graded_at, created_at)
SELECT 'story', 'story-sc2-2', g.job_id, g.unit, g.generation_id, g.reading_model, true,
       jsonb_set(g.verdicts, '{recall,message}', '{"found": 2, "total": 3}'), g.grader, '2026-10-06 04:00Z', '2026-10-06 07:00Z', '2026-10-06 07:00Z'
FROM public.context_grades g WHERE g.sample_id = 'story-sc2-1';
INSERT INTO public.context_grades (kind, sample_id, job_id, unit, generation_id, reading_model, story_flag, ledger_mode, gated, verdicts, grader,
  as_of, graded_at, created_at)
SELECT 'agent', 'agent-sc2-2', g.job_id, g.unit, g.generation_id, g.reading_model, false, g.ledger_mode, g.gated, g.verdicts, g.grader,
       '2026-10-06 04:00Z', '2026-10-06 07:00Z', '2026-10-06 07:00Z'
FROM public.context_grades g WHERE g.sample_id = 'agent-sc2-1';
SAVEPOINT sc2_failing;
DO $failing$
DECLARE s jsonb := public.context_scorecard('2026-10-07 04:00Z'); l jsonb;
BEGIN
 l := pg_temp.sc2_lane(s, 3, 'right_job_customer_facing');
 PERFORM pg_temp.sc2_check(l->>'status' = 'red' AND l->>'note' LIKE '10 of 120 drawn items not graded%', 'failing', 3,
  'a sample not graded whole must read red: ' || coalesce(l::text, 'no lane'));
 l := pg_temp.sc2_lane(s, 7, 'fact_grade');
 PERFORM pg_temp.sc2_check(l->>'status' = 'red' AND (l->>'number')::numeric = 90 AND l->>'note' LIKE '9 of 10 items pass, at least 95% needed%',
  'failing', 7, 'a 90% ledger grade must read red: ' || coalesce(l::text, 'no lane'));
 l := pg_temp.sc2_lane(s, 8, 'answer_grade');
 PERFORM pg_temp.sc2_check(l->>'status' = 'red' AND (l->>'number')::integer = 1 AND l->>'note' LIKE 'message recall 20 of 30, at least 95% needed%',
  'failing', 8, 'message recall below 95% must read red: ' || coalesce(l::text, 'no lane'));
 l := pg_temp.sc2_lane(s, 9, 'agent_test');
 PERFORM pg_temp.sc2_check(l->>'status' = 'red' AND l->>'note' LIKE '0 of 40 calls ran with the story switch on%', 'failing', 9,
  'an agent test with the story switch off must read red: ' || coalesce(l::text, 'no lane'));
 l := pg_temp.sc2_lane(s, 9, 'story_test');
 PERFORM pg_temp.sc2_check(l->>'status' = 'red', 'failing', 9, 'the story test must read red with the story switch off');
 PERFORM pg_temp.sc2_raise('failing');
END $failing$;
\if :ERROR
ROLLBACK TO SAVEPOINT sc2_failing;
\endif
ROLLBACK TO SAVEPOINT failing_samples;

-- Row 6: a reading live at the instant and retired since still counts as live then; a newer
-- reading promoted after the instant does not.
SAVEPOINT replay;
UPDATE public.context_ledger_generations SET status = 'retired', retired_at = '2026-10-07 05:00Z'
WHERE id = '5d9e0000-0000-4000-8000-000000000003';
INSERT INTO public.context_ledger_generations (id, job_id, kind, status, reader, model, evidence_until, checks, created_at, finished_at,
  promoted_at, updated_at)
VALUES ('5d9e0000-0000-4000-8000-0000000000e3', '5d000000-0000-4000-8000-000000000003', 'rebuild', 'live', 'luna-ledger:v1', 'claude-sc2',
        '2026-10-07 04:30Z', '{"passed": true}', '2026-10-07 04:40Z', '2026-10-07 04:50Z', '2026-10-07 05:00Z', '2026-10-07 05:00Z');
SAVEPOINT sc2_replay;
DO $replay$
DECLARE l jsonb := pg_temp.sc2_lane(public.context_scorecard('2026-10-07 04:00Z'), 6, 'live_unread');
 l2 jsonb := pg_temp.sc2_lane(public.context_scorecard('2026-10-07 06:00Z'), 6, 'live_unread');
BEGIN
 PERFORM pg_temp.sc2_check(l->>'value' = '1 late of 2 live items unread; oldest 3.0 h', 'replay', 6,
  'the reading live at the instant must decide: ' || coalesce(l->>'value', 'no lane'));
 PERFORM pg_temp.sc2_check((l2->>'value') LIKE '0 late of 0 live items unread%', 'replay', 6,
  'the newer live reading must read J03''s rows two hours later: ' || coalesce(l2->>'value', 'no lane'));
 PERFORM pg_temp.sc2_raise('replay');
END $replay$;
\if :ERROR
ROLLBACK TO SAVEPOINT sc2_replay;
\endif
ROLLBACK TO SAVEPOINT replay;

-- The jobs page: monitored jobs only, in id order, paged; every per-job row.
SAVEPOINT sc2_jobs;
DO $jobs$
DECLARE j jsonb := public.context_scorecard_jobs(NULL, 300, '2026-10-07 04:00Z'); r jsonb; ids uuid[]; p1 jsonb; p2 jsonb;
BEGIN
 ids := ARRAY(SELECT (x->>'job_id')::uuid FROM jsonb_array_elements(j->'jobs') WITH ORDINALITY AS t(x, o) ORDER BY o);
 PERFORM pg_temp.sc2_check(ids = ARRAY(SELECT ('5d000000-0000-4000-8000-0000000000' || lpad(g::text, 2, '0'))::uuid FROM generate_series(1, 12) g),
  'jobs', NULL, 'the page is not the twelve monitored jobs in id order: ' || coalesce(array_to_string(ids, ','), 'none'));
 PERFORM pg_temp.sc2_check(j->'next' = 'null'::jsonb, 'jobs', NULL, 'a short page must end the paging');
 p1 := public.context_scorecard_jobs(NULL, 5, '2026-10-07 04:00Z');
 p2 := public.context_scorecard_jobs((p1->>'next')::uuid, 5, '2026-10-07 04:00Z');
 PERFORM pg_temp.sc2_check(jsonb_array_length(p1->'jobs') = 5 AND (p1->>'next')::uuid = '5d000000-0000-4000-8000-000000000005'
  AND (p2->'jobs'->0->>'job_id')::uuid = '5d000000-0000-4000-8000-000000000006', 'jobs', NULL, 'paging wrong');
 -- Row 4: loaded and tried-with-no-contact are done; a job never tried is missing.
 r := pg_temp.sc2_job_row(j, '5d000000-0000-4000-8000-000000000001', 4);
 PERFORM pg_temp.sc2_check(r->>'status' = 'green' AND r->>'value' = 'CRM history loaded; no live Xero invoice', 'jobs', 4, 'J01 row 4: ' || coalesce(r::text, 'none'));
 r := pg_temp.sc2_job_row(j, '5d000000-0000-4000-8000-000000000002', 4);
 PERFORM pg_temp.sc2_check(r->>'status' = 'green' AND r->>'value' = 'CRM tried, no CRM contact (not_in_ghl); no live Xero invoice', 'jobs', 4,
  'J02 row 4 (tried with no contact is done): ' || coalesce(r::text, 'none'));
 r := pg_temp.sc2_job_row(j, '5d000000-0000-4000-8000-000000000006', 4);
 PERFORM pg_temp.sc2_check(r->>'status' = 'red' AND r->>'value' = 'CRM history missing (link_not_tried); no live Xero invoice', 'jobs', 4,
  'J06 row 4: ' || coalesce(r::text, 'none'));
 r := pg_temp.sc2_job_row(j, '5d000000-0000-4000-8000-000000000005', 4);
 PERFORM pg_temp.sc2_check(r->>'status' = 'red' AND r->>'value' = 'CRM history missing (link_not_tried); 1 Xero invoices with evidence', 'jobs', 4,
  'J05 row 4: ' || coalesce(r::text, 'none'));
 -- Row 6: J03 late, J04 an old backlog row and no live reading, J01 all read.
 r := pg_temp.sc2_job_row(j, '5d000000-0000-4000-8000-000000000003', 6);
 PERFORM pg_temp.sc2_check(r->>'status' = 'red' AND (r->>'number')::integer = 1 AND r->>'value' = '2 live and 0 backlog items unread by the live reading',
  'jobs', 6, 'J03 row 6: ' || coalesce(r::text, 'none'));
 r := pg_temp.sc2_job_row(j, '5d000000-0000-4000-8000-000000000004', 6);
 PERFORM pg_temp.sc2_check(r->>'status' = 'red'
  AND r->>'value' = '0 live and 1 backlog items unread by the live reading; no live reading (ledger shadow)', 'jobs', 6, 'J04 row 6: ' || coalesce(r::text, 'none'));
 r := pg_temp.sc2_job_row(j, '5d000000-0000-4000-8000-000000000001', 6);
 PERFORM pg_temp.sc2_check(r->>'status' = 'green', 'jobs', 6, 'J01 row 6 (read by its live reading): ' || coalesce(r::text, 'none'));
 -- Rows 7, 8 and 9 appear on a graded job only.
 PERFORM pg_temp.sc2_check(pg_temp.sc2_job_row(j, '5d000000-0000-4000-8000-000000000001', 7)->>'status' = 'green'
  AND pg_temp.sc2_job_row(j, '5d000000-0000-4000-8000-000000000001', 8)->>'status' = 'green'
  AND pg_temp.sc2_job_row(j, '5d000000-0000-4000-8000-000000000001', 9)->>'value' = '4 of 4 pass (sample agent-sc2-1)', 'jobs', 7,
  'J01''s graded rows wrong');
 PERFORM pg_temp.sc2_check(pg_temp.sc2_job_row(j, '5d000000-0000-4000-8000-000000000012', 7) IS NULL
  AND pg_temp.sc2_job_row(j, '5d000000-0000-4000-8000-000000000012', 9) IS NULL, 'jobs', 7, 'J12 was not graded and must carry no graded row');
 -- Rows 11 to 13.
 PERFORM pg_temp.sc2_check(pg_temp.sc2_job_row(j, '5d000000-0000-4000-8000-000000000012', 12)->>'value' LIKE '% record loops; ledger none'
  AND pg_temp.sc2_job_row(j, '5d000000-0000-4000-8000-000000000012', 13)->>'status' = 'red'
  AND pg_temp.sc2_job_row(j, '5d000000-0000-4000-8000-000000000001', 12)->>'status' = 'green', 'jobs', 12, 'rows 12 and 13 wrong');
 -- Row 14: J05 reaches its start (no texts to fall short); J01's earliest text is 35 days after its start.
 r := pg_temp.sc2_job_row(j, '5d000000-0000-4000-8000-000000000005', 14);
 PERFORM pg_temp.sc2_check(r->>'status' = 'green' AND r->>'value' LIKE '%email history reaches 1 Jul 2026 (reaches_start)%', 'jobs', 14,
  'J05 row 14: ' || coalesce(r::text, 'none'));
 r := pg_temp.sc2_job_row(j, '5d000000-0000-4000-8000-000000000001', 14);
 PERFORM pg_temp.sc2_check(r->>'status' = 'red' AND r->>'value' LIKE '%earliest text or call 6 Oct 2026', 'jobs', 14, 'J01 row 14: ' || coalesce(r::text, 'none'));
 PERFORM pg_temp.sc2_raise('jobs');
END $jobs$;
\if :ERROR
ROLLBACK TO SAVEPOINT sc2_jobs;
\endif
ROLLBACK;

-- 4. Re-applying the migration changes nothing (its guard accepts its own bodies).
BEGIN;
CREATE TEMP TABLE sc2_md5_before ON COMMIT DROP AS
SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS m, p.proconfig::text AS cfg, obj_description(p.oid, 'pg_proc') AS c
FROM pg_proc p WHERE p.oid IN ('public.context_scorecard_policy()'::regprocedure, 'public.context_scorecard(timestamptz)'::regprocedure,
                               'public.context_scorecard_jobs(uuid,integer,timestamptz)'::regprocedure);
\ir ../../../migrations/20261007120000_context_scorecard_v2.sql
DO $reapply$
BEGIN
 PERFORM pg_temp.sc2_check(NOT EXISTS (SELECT 1 FROM sc2_md5_before b JOIN pg_proc p ON p.oid = b.sig::regprocedure
   WHERE md5(p.prosrc) <> b.m OR p.proconfig::text IS DISTINCT FROM b.cfg OR obj_description(p.oid, 'pg_proc') IS DISTINCT FROM b.c),
  'reapply', NULL, 're-applying changed a body, a setting or a comment');
 PERFORM pg_temp.sc2_raise('reapply');
END $reapply$;
ROLLBACK;
