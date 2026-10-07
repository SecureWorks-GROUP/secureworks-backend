-- Contract for 20261007030000_context_jev_points: Jev's five watch points in
-- the shadow log, their later-truth read and the agreement read. Every fixture
-- write is rolled back. Ids are made up; no row holds words.

-- 1. Shape: the five switches created off, saying what turning one on sends;
-- the truth read a definer with this migration's comment; the agreement read
-- this migration's; the log's columns exactly as 20261006080000 made them.
DO $$
DECLARE point text; descr text; cols text;
BEGIN
 FOREACH point IN ARRAY ARRAY['sender_role', 'visit_happened', 'lead_alive', 'payment_wait', 'email_triage'] LOOP
  IF (SELECT count(*) FROM public.feature_flags WHERE flag_name = 'context_jev_point_' || point) <> 1
   OR (SELECT enabled FROM public.feature_flags WHERE flag_name = 'context_jev_point_' || point) IS DISTINCT FROM false THEN
   RAISE EXCEPTION 'jev points contract: the % switch is not exactly one row created off', point;
  END IF;
  descr := coalesce((SELECT description FROM public.feature_flags WHERE flag_name = 'context_jev_point_' || point), '');
  IF descr NOT LIKE 'Jev watch point ' || point || ' (20261007030000):%' OR descr NOT LIKE '%Watch only%'
   OR descr NOT LIKE '%context_jev_shadow_v1 is on and TYPESAFE_API_KEY is set%' OR descr NOT LIKE '%TypeSafe in the United States%'
   OR descr NOT LIKE '%Owner''s word to turn on.' THEN
   RAISE EXCEPTION 'jev points contract: the % switch does not say what turning it on sends and who may', point;
  END IF;
 END LOOP;
 IF to_regprocedure('public.context_jev_truth(public.context_jev_decisions)') IS NULL
  OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.context_jev_truth(public.context_jev_decisions)'))
  OR (SELECT provolatile FROM pg_proc WHERE oid = to_regprocedure('public.context_jev_truth(public.context_jev_decisions)')) <> 's'
  OR coalesce(obj_description(to_regprocedure('public.context_jev_truth(public.context_jev_decisions)'), 'pg_proc'), '')
     NOT LIKE 'Context Jev points (20261007030000): read only.%' THEN
  RAISE EXCEPTION 'jev points contract: the truth read is missing, not a stable definer, or not this migration''s';
 END IF;
 IF coalesce(obj_description(to_regprocedure('public.context_jev_agreement(timestamptz,timestamptz)'), 'pg_proc'), '')
    NOT LIKE 'Context Jev points (20261007030000): read only.%' THEN
  RAISE EXCEPTION 'jev points contract: the agreement read is not this migration''s';
 END IF;
 SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum) INTO cols
 FROM pg_attribute a WHERE a.attrelid = 'public.context_jev_decisions'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
 IF cols IS DISTINCT FROM 'id:uuid,decision_point:text,job_id:uuid,row_table:text,row_id:uuid,requested_model:text,model:text,'
   'jev_outcome:text,jev_job_id:uuid,jev_confidence:numeric(5,4),jev_answer:jsonb,current_outcome:text,current_job_id:uuid,'
   'current_answer:jsonb,latency_ms:integer,input_tokens:integer,output_tokens:integer,attempts:smallint,error_code:text,'
   'created_at:timestamp with time zone' THEN
  RAISE EXCEPTION 'jev points contract: the log''s columns changed: %', cols;
 END IF;
END $$;

-- 2. Access: the truth and agreement reads are the service role's only.
DO $$
DECLARE r text;
BEGIN
 FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
  IF has_function_privilege(r, 'public.context_jev_truth(public.context_jev_decisions)', 'EXECUTE')
   OR has_function_privilege(r, 'public.context_jev_agreement(timestamptz,timestamptz)', 'EXECUTE') THEN
   RAISE EXCEPTION 'jev points contract: % may run a Jev read', r;
  END IF;
 END LOOP;
 IF NOT has_function_privilege('service_role', 'public.context_jev_truth(public.context_jev_decisions)', 'EXECUTE')
  OR NOT has_function_privilege('service_role', 'public.context_jev_agreement(timestamptz,timestamptz)', 'EXECUTE') THEN
  RAISE EXCEPTION 'jev points contract: service_role cannot run the Jev reads';
 END IF;
END $$;

-- One row as the worker builds it: an email_triage answer by default, any field overridden by p.
CREATE FUNCTION pg_temp.jp_row(p jsonb) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('decision_point', 'email_triage', 'job_id', NULL, 'row_table', 'business_events',
  'row_id', '0f000000-0000-4000-8000-0000000000e1', 'requested_model', 'jev-1.13.0', 'model', 'jev-1.13.0',
  'jev_outcome', 'marketing_junk', 'jev_confidence', 0.95, 'jev_answer', '{"order_consistent":true}'::jsonb,
  'current_outcome', NULL, 'current_answer', '{"subject_key":"0f000000-0000-4000-8000-0000000000e1"}'::jsonb,
  'latency_ms', 410, 'input_tokens', 700, 'output_tokens', 20, 'attempts', 1) || p
$$;
CREATE FUNCTION pg_temp.jp_insert(p jsonb) RETURNS uuid LANGUAGE sql AS $$
 INSERT INTO public.context_jev_decisions (decision_point, job_id, row_table, row_id, requested_model, model, jev_outcome, jev_job_id,
  jev_confidence, jev_answer, current_outcome, current_job_id, current_answer, latency_ms, input_tokens, output_tokens, attempts, error_code, created_at)
 SELECT r.decision_point, r.job_id, r.row_table, r.row_id, r.requested_model, r.model, r.jev_outcome, r.jev_job_id, r.jev_confidence,
  coalesce(r.jev_answer, '{}'::jsonb), r.current_outcome, r.current_job_id, coalesce(r.current_answer, '{}'::jsonb), r.latency_ms, r.input_tokens,
  r.output_tokens, coalesce(r.attempts, 1), r.error_code, coalesce(r.created_at, now())
 FROM jsonb_populate_record(NULL::public.context_jev_decisions, pg_temp.jp_row(p)) r
 RETURNING id
$$;
-- The SQLSTATE an insert fails with, or null when it is taken (and then undone).
CREATE FUNCTION pg_temp.jp_refused(p jsonb) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
 BEGIN
  PERFORM pg_temp.jp_insert(p);
  RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'taken';
 EXCEPTION WHEN SQLSTATE 'P0099' THEN RETURN NULL;
 WHEN OTHERS THEN RETURN SQLSTATE;
 END;
END $$;

-- 3. The checks take each point's own rows and refuse a row about the wrong thing, an answer of another point, or
-- today's answer where the point compares with the later truth. The first three points keep their rules.
DO $$
DECLARE c record; got text;
  job text := '0f000000-0000-4000-8000-0000000000a1'; booking text := '0f000000-0000-4000-8000-0000000000b1';
  invoice text := '0f000000-0000-4000-8000-0000000000c1'; msg text := '0f000000-0000-4000-8000-0000000000e2';
BEGIN
 FOR c IN SELECT * FROM (VALUES
  ('an email triage', '{}'),
  ('a sender role', '{"decision_point":"sender_role","jev_outcome":"supplier"}'),
  ('a sender role on a placed message', format('{"decision_point":"sender_role","job_id":"%s","jev_outcome":"crew_staff"}', job)),
  ('a visit', format('{"decision_point":"visit_happened","job_id":"%s","row_table":"job_assignments","row_id":"%s","jev_outcome":"unsure"}', job, booking)),
  ('a lead', format('{"decision_point":"lead_alive","job_id":"%s","row_id":"%s","jev_outcome":"gone_elsewhere"}', job, msg)),
  ('a payment wait held', format('{"decision_point":"payment_wait","job_id":"%s","row_table":"xero_invoices","row_id":"%s","jev_outcome":"asked_for_time","current_outcome":"hold"}', job, invoice)),
  ('a payment wait with no verdict', format('{"decision_point":"payment_wait","job_id":"%s","row_table":"xero_invoices","row_id":"%s","jev_outcome":"none"}', job, invoice)),
  ('a failed visit', format('{"decision_point":"visit_happened","job_id":"%s","row_table":"job_assignments","row_id":"%s","jev_outcome":null,"jev_confidence":null,"model":null,"error_code":"jev_http_529","attempts":3}', job, booking))
 ) v(label, body) LOOP
  got := pg_temp.jp_refused(c.body::jsonb);
  IF got IS NOT NULL THEN RAISE EXCEPTION 'jev points contract: a well formed row (%) is refused (%)', c.label, got; END IF;
 END LOOP;
 FOR c IN SELECT * FROM (VALUES
  ('a sender role with today''s answer', '{"decision_point":"sender_role","jev_outcome":"customer","current_outcome":"unknown"}'),
  ('a sender role on a booking', format('{"decision_point":"sender_role","row_table":"job_assignments","row_id":"%s","jev_outcome":"customer"}', booking)),
  ('a sender role answered with a triage', '{"decision_point":"sender_role","jev_outcome":"council"}'),
  ('a visit with no job', format('{"decision_point":"visit_happened","row_table":"job_assignments","row_id":"%s","jev_outcome":"yes"}', booking)),
  ('a visit on a message', format('{"decision_point":"visit_happened","job_id":"%s","jev_outcome":"yes"}', job)),
  ('a visit with today''s answer', format('{"decision_point":"visit_happened","job_id":"%s","row_table":"job_assignments","row_id":"%s","jev_outcome":"yes","current_outcome":"yes"}', job, booking)),
  ('a lead with no job', '{"decision_point":"lead_alive","jev_outcome":"alive"}'),
  ('a lead answered yes', format('{"decision_point":"lead_alive","job_id":"%s","jev_outcome":"yes"}', job)),
  ('a payment wait on a message', format('{"decision_point":"payment_wait","job_id":"%s","jev_outcome":"paid","current_outcome":"hold"}', job)),
  ('a payment wait with no job', format('{"decision_point":"payment_wait","row_table":"xero_invoices","row_id":"%s","jev_outcome":"paid"}', invoice)),
  ('a payment wait answered with the verdict', format('{"decision_point":"payment_wait","job_id":"%s","row_table":"xero_invoices","row_id":"%s","jev_outcome":"remind"}', job, invoice)),
  ('a payment wait with a made up verdict', format('{"decision_point":"payment_wait","job_id":"%s","row_table":"xero_invoices","row_id":"%s","jev_outcome":"none","current_outcome":"propose"}', job, invoice)),
  ('an email triage answered with another point''s answer', '{"jev_outcome":"yes"}'),
  ('an email triage with today''s answer', '{"current_outcome":"customer_job"}'),
  ('an email triage with no row', '{"row_table":null,"row_id":null,"job_id":"0f000000-0000-4000-8000-0000000000a1"}'),
  ('an email triage on an invoice', format('{"row_table":"xero_invoices","row_id":"%s"}', invoice)),
  ('a row table the log does not know', '{"row_table":"jobs"}'),
  ('a placement on a booking', format('{"decision_point":"placement","row_table":"job_assignments","row_id":"%s","jev_outcome":"none","current_outcome":"none"}', booking)),
  ('a reply owed on an invoice', format('{"decision_point":"ledger_reply_owed","job_id":"%s","row_table":"xero_invoices","row_id":"%s","jev_outcome":"owed","current_outcome":"owed"}', job, invoice)),
  ('a gate on a booking', format('{"decision_point":"ledger_update_gate","job_id":"%s","row_table":"job_assignments","row_id":"%s","jev_outcome":"change","current_outcome":"change"}', job, booking)),
  ('a gate answered with a payment verdict', format('{"decision_point":"ledger_update_gate","job_id":"%s","row_table":null,"row_id":null,"jev_outcome":"change","current_outcome":"hold"}', job))
 ) v(label, body) LOOP
  got := pg_temp.jp_refused(c.body::jsonb);
  IF got IS DISTINCT FROM '23514' THEN RAISE EXCEPTION 'jev points contract: % was not refused by a check (got %)', c.label, coalesce(got, 'taken'); END IF;
 END LOOP;
END $$;

-- The records the truth reads, written straight in (triggers off for the fixture transaction only).
CREATE FUNCTION pg_temp.jp_records() RETURNS void LANGUAGE plpgsql AS $$
DECLARE org uuid := '0f000000-0000-4000-8000-00000000f001';
BEGIN
 PERFORM set_config('session_replication_role', 'replica', true);
 INSERT INTO public.jobs (id, org_id, status, type, job_number, archived) VALUES
  ('0f000000-0000-4000-8000-0000000001a1', org, 'scheduled', 'fencing', 'JP-1', NULL),
  ('0f000000-0000-4000-8000-0000000001a2', org, 'complete', 'fencing', 'JP-2', NULL),
  ('0f000000-0000-4000-8000-0000000001a3', org, 'quoted', 'patio', 'JP-3', NULL),
  ('0f000000-0000-4000-8000-0000000001a4', org, 'accepted', 'patio', 'JP-4', NULL),
  ('0f000000-0000-4000-8000-0000000001a5', org, 'lost', 'patio', 'JP-5', NULL),
  ('0f000000-0000-4000-8000-0000000001a6', org, 'quoted', 'patio', 'JP-6', true),
  ('0f000000-0000-4000-8000-0000000001a7', org, 'draft', 'patio', 'JP-7', NULL),
  ('0f000000-0000-4000-8000-0000000001a8', org, 'scheduled', 'fencing', 'JP-8', NULL),
  ('0f000000-0000-4000-8000-0000000001a9', org, 'complete', 'fencing', 'JP-9', NULL),
  ('0f000000-0000-4000-8000-0000000001aa', org, 'scheduled', 'fencing', 'JP-10', NULL),
  ('0f000000-0000-4000-8000-0000000001ab', org, 'scheduled', 'fencing', 'JP-11', NULL),
  ('0f000000-0000-4000-8000-0000000001ac', org, 'complete', 'fencing', 'JP-12', NULL),
  ('0f000000-0000-4000-8000-0000000001ad', org, 'scheduled', 'fencing', 'JP-13', NULL),
  ('0f000000-0000-4000-8000-0000000001ae', org, 'complete', 'fencing', 'JP-14', NULL),
  ('0f000000-0000-4000-8000-0000000001af', org, 'complete', 'fencing', 'JP-15', NULL),
  ('0f000000-0000-4000-8000-0000000001b0', org, 'scheduled', 'fencing', 'JP-16', NULL),
  ('0f000000-0000-4000-8000-0000000001b1', org, 'scheduled', 'fencing', 'JP-17', NULL),
  ('0f000000-0000-4000-8000-0000000001b2', org, 'scheduled', 'fencing', 'JP-18', NULL),
  ('0f000000-0000-4000-8000-0000000001b3', org, 'complete', 'fencing', 'JP-19', NULL),
  ('0f000000-0000-4000-8000-0000000001b4', org, 'scheduled', 'fencing', 'JP-20', NULL),
  ('0f000000-0000-4000-8000-0000000001b5', org, 'scheduled', 'fencing', 'JP-21', NULL);
 INSERT INTO public.business_events (id, job_id, attribution_status, metadata) VALUES
  ('0f000000-0000-4000-8000-0000000002e1', NULL, 'admin_bucket', '{"party_roles":{"sender_role":"crew","basis":"users"}}'),
  ('0f000000-0000-4000-8000-0000000002e2', NULL, 'admin_bucket', '{"party_roles":{"sender_role":"staff","basis":"our_domain"}}'),
  ('0f000000-0000-4000-8000-0000000002e3', '0f000000-0000-4000-8000-0000000001a1', 'thread', '{"party_roles":{"sender_role":"customer","basis":"job_customer"}}'),
  ('0f000000-0000-4000-8000-0000000002e4', NULL, 'admin_bucket', '{"party_roles":{"sender_role":"unknown","basis":"council"}}'),
  ('0f000000-0000-4000-8000-0000000002e5', NULL, 'admin_bucket', '{"party_roles":{"sender_role":"unknown","basis":"no_match"}}'),
  ('0f000000-0000-4000-8000-0000000002e6', '0f000000-0000-4000-8000-0000000001a1', 'direct', '{"party_roles":{"sender_role":"unknown","basis":"no_match"}}'),
  ('0f000000-0000-4000-8000-0000000002e7', NULL, 'admin_bucket', '{"party_roles":{"sender_role":"supplier","basis":"supplier"}}'),
  ('0f000000-0000-4000-8000-0000000002e8', NULL, 'admin_bucket', '{"party_roles":{"sender_role":"insurer_builder","basis":"builder_company"}}'),
  ('0f000000-0000-4000-8000-0000000002e9', NULL, 'pending_luna', '{"party_roles":{"sender_role":"unknown","basis":"no_match"}}'),
  ('0f000000-0000-4000-8000-0000000002ea', NULL, NULL, '{}');
 -- Emails from senders nobody knows, on no job, with the sender address the email readers keep (payload from).
 INSERT INTO public.business_events (id, job_id, attribution_status, event_type, channel, direction, payload, metadata) VALUES
  ('0f000000-0000-4000-8000-0000000002eb', NULL, 'admin_bucket', 'client.email_in', 'email', 'inbound', '{"from":"Robin Sample <robin.sample@gmail.com>"}',
   '{"party_roles":{"sender_role":"unknown","basis":"no_match"}}'),
  ('0f000000-0000-4000-8000-0000000002ec', NULL, 'admin_bucket', 'client.email_in', 'email', 'inbound', '{"from":"news@shop.example"}',
   '{"party_roles":{"sender_role":"unknown","basis":"no_match"}}'),
  ('0f000000-0000-4000-8000-0000000002ed', NULL, 'unplaced', 'client.email_in', 'email', 'inbound', '{"from":"orders@shop.example","sender_kind":"automated"}',
   '{"party_roles":{"sender_role":"unknown","basis":"automated"}}'),
  ('0f000000-0000-4000-8000-0000000002ee', NULL, 'admin_bucket', 'client.email_in', 'email', 'inbound', '{"from":"accounts@builder.example"}',
   '{"party_roles":{"sender_role":"unknown","basis":"no_match"}}');
 -- Booking deletions as ops-api records them: the business_events copy names the booking, the job event only its job and day.
 INSERT INTO public.business_events (id, job_id, event_type, entity_type, entity_id, payload) VALUES
  ('0f000000-0000-4000-8000-0000000002f1', '0f000000-0000-4000-8000-0000000001aa', 'schedule.assignment_deleted', 'crew_assignment',
   '0f000000-0000-4000-8000-0000000003ba', '{"scheduled_date":"2026-10-05"}');
 INSERT INTO public.job_events (id, job_id, event_type, detail_json) VALUES
  ('0f000000-0000-4000-8000-0000000004e1', '0f000000-0000-4000-8000-0000000001ab', 'assignment_deleted', '{"date":"2026-10-05","user_id":"0f000000-0000-4000-8000-00000000f002"}'),
  ('0f000000-0000-4000-8000-0000000004e2', '0f000000-0000-4000-8000-0000000001ab', 'assignment_deleted', '{"date":"2026-10-04","user_id":"0f000000-0000-4000-8000-00000000f002"}'),
  ('0f000000-0000-4000-8000-0000000004e3', '0f000000-0000-4000-8000-0000000001b3', 'assignment_removed',
   '{"removed_assignments":[{"id":"0f000000-0000-4000-8000-0000000003c7","scheduled_date":"2026-10-05"}]}'),
  ('0f000000-0000-4000-8000-0000000004e4', '0f000000-0000-4000-8000-0000000001b4', 'assignment_removed', '{"removed_dates":["2026-10-05"]}');
 INSERT INTO public.job_assignments (id, job_id, status, scheduled_date, scheduled_end, started_at, completed_at, verified_at, is_ghost, role) VALUES
  ('0f000000-0000-4000-8000-0000000003b1', '0f000000-0000-4000-8000-0000000001a1', 'complete', '2026-10-01', NULL, NULL, NULL, NULL, false, NULL),
  ('0f000000-0000-4000-8000-0000000003b2', '0f000000-0000-4000-8000-0000000001a1', 'scheduled', '2026-10-02', NULL, '2026-10-02T00:30:00Z', NULL, NULL, false, NULL),
  ('0f000000-0000-4000-8000-0000000003b3', '0f000000-0000-4000-8000-0000000001a1', 'cancelled', '2026-10-03', NULL, NULL, NULL, NULL, false, NULL),
  ('0f000000-0000-4000-8000-0000000003b4', '0f000000-0000-4000-8000-0000000001a1', 'scheduled', '2026-10-04', NULL, NULL, NULL, NULL, false, NULL),
  ('0f000000-0000-4000-8000-0000000003b5', '0f000000-0000-4000-8000-0000000001a8', 'scheduled', '2026-10-05', NULL, NULL, NULL, NULL, false, NULL),
  ('0f000000-0000-4000-8000-0000000003b6', '0f000000-0000-4000-8000-0000000001a2', 'scheduled', '2026-10-05', NULL, NULL, NULL, NULL, false, NULL),
  ('0f000000-0000-4000-8000-0000000003b7', '0f000000-0000-4000-8000-0000000001a1', 'scheduled', '2026-10-06', NULL, NULL, NULL, NULL, false, NULL),
  -- Asked for 5 Oct, since moved to 8 Oct and completed there.
  ('0f000000-0000-4000-8000-0000000003b9', '0f000000-0000-4000-8000-0000000001a9', 'complete', '2026-10-08', NULL, NULL, '2026-10-08T06:00:00Z', NULL, false, NULL),
  -- Two crew booked for 5 Oct: the asked one moved to 9 Oct, the other completed on the day.
  ('0f000000-0000-4000-8000-0000000003bd', '0f000000-0000-4000-8000-0000000001ad', 'scheduled', '2026-10-09', NULL, NULL, NULL, NULL, false, NULL),
  ('0f000000-0000-4000-8000-0000000003be', '0f000000-0000-4000-8000-0000000001ad', 'scheduled', '2026-10-05', NULL, NULL, '2026-10-05T07:00:00Z', NULL, false, NULL),
  -- Two crew booked for 5 Oct: the asked one cancelled, the other still booked; the job is complete.
  ('0f000000-0000-4000-8000-0000000003bf', '0f000000-0000-4000-8000-0000000001ae', 'cancelled', '2026-10-05', NULL, NULL, NULL, NULL, false, NULL),
  ('0f000000-0000-4000-8000-0000000003c0', '0f000000-0000-4000-8000-0000000001ae', 'scheduled', '2026-10-05', NULL, NULL, NULL, NULL, false, NULL),
  -- Booked for 5 Oct with a later visit booked for 12 Oct; the job is complete.
  ('0f000000-0000-4000-8000-0000000003c1', '0f000000-0000-4000-8000-0000000001af', 'scheduled', '2026-10-05', NULL, NULL, NULL, NULL, false, NULL),
  ('0f000000-0000-4000-8000-0000000003c2', '0f000000-0000-4000-8000-0000000001af', 'scheduled', '2026-10-12', NULL, NULL, NULL, NULL, false, NULL),
  -- Asked for 5 Oct, moved to 7 Oct; only an observer copy (a ghost mirror) is left on the day, marked complete.
  ('0f000000-0000-4000-8000-0000000003c3', '0f000000-0000-4000-8000-0000000001b0', 'scheduled', '2026-10-07', NULL, NULL, NULL, NULL, false, NULL),
  ('0f000000-0000-4000-8000-0000000003c4', '0f000000-0000-4000-8000-0000000001b0', 'complete', '2026-10-05', NULL, NULL, NULL, NULL, true, 'observer'),
  -- Asked for 5 Oct, moved to a 4 to 6 Oct span that covers the day, and started.
  ('0f000000-0000-4000-8000-0000000003c5', '0f000000-0000-4000-8000-0000000001b1', 'scheduled', '2026-10-04', '2026-10-06', '2026-10-05T00:10:00Z', NULL, NULL, false, NULL),
  ('0f000000-0000-4000-8000-0000000003c6', '0f000000-0000-4000-8000-0000000001b2', 'scheduled', '2026-10-06', NULL, NULL, NULL, '2026-10-06T09:00:00Z', false, NULL),
  ('0f000000-0000-4000-8000-0000000003c9', '0f000000-0000-4000-8000-0000000001b5', 'scheduled', '2026-10-05', NULL, NULL, NULL, NULL, false, NULL);
 -- A scope outcome for b4's day says it happened; one for b5's job says it did not; none for b7's day (same job as b4).
 -- c9's day was recorded as happened, then corrected (the correction supersedes it): it did not.
 INSERT INTO public.visit_outcomes (id, booking_key, contact_id, job_id, scoper_user_id, scoper_name, visit_start, outcome, reason, quote_owed, recorded_by_user_id, supersedes) VALUES
  ('0f000000-0000-4000-8000-0000000005a1', 'jp-1', 'jp-contact', '0f000000-0000-4000-8000-0000000001a1', org, 'Scoper', '2026-10-04T01:00:00Z', 'happened', NULL, false, org, NULL),
  ('0f000000-0000-4000-8000-0000000005a2', 'jp-2', 'jp-contact', '0f000000-0000-4000-8000-0000000001a8', org, 'Scoper', '2026-10-05T01:00:00Z', 'did_not_happen', 'customer_not_home', false, org, NULL),
  ('0f000000-0000-4000-8000-0000000005a3', 'jp-3', 'jp-contact', '0f000000-0000-4000-8000-0000000001b5', org, 'Scoper', '2026-10-05T01:00:00Z', 'happened', NULL, false, org, NULL),
  ('0f000000-0000-4000-8000-0000000005a4', 'jp-3', 'jp-contact', '0f000000-0000-4000-8000-0000000001b5', org, 'Scoper', '2026-10-05T01:00:00Z', 'did_not_happen', 'we_did_not_attend', false, org,
   '0f000000-0000-4000-8000-0000000005a3');
 PERFORM set_config('session_replication_role', 'origin', true);
END $$;

-- 4. The later truth, point by point, from the records as they are now.
BEGIN;
DO $$
DECLARE c record; got text; d public.context_jev_decisions;
BEGIN
 PERFORM pg_temp.jp_records();
 FOR c IN SELECT * FROM (VALUES
  -- sender_role: the stamp once it names the sender.
  ('{"decision_point":"sender_role","row_id":"0f000000-0000-4000-8000-0000000002e1","jev_outcome":"customer"}', 'crew_staff', 'crew stamps crew_staff'),
  ('{"decision_point":"sender_role","row_id":"0f000000-0000-4000-8000-0000000002e2","jev_outcome":"customer"}', 'crew_staff', 'staff stamps crew_staff'),
  ('{"decision_point":"sender_role","row_id":"0f000000-0000-4000-8000-0000000002e3","jev_outcome":"customer"}', 'customer', 'customer'),
  ('{"decision_point":"sender_role","row_id":"0f000000-0000-4000-8000-0000000002e7","jev_outcome":"customer"}', 'supplier', 'supplier'),
  ('{"decision_point":"sender_role","row_id":"0f000000-0000-4000-8000-0000000002e8","jev_outcome":"customer"}', 'insurer_builder', 'insurer or builder'),
  ('{"decision_point":"sender_role","row_id":"0f000000-0000-4000-8000-0000000002e4","jev_outcome":"customer"}', 'other_party', 'a council is another party'),
  ('{"decision_point":"sender_role","row_id":"0f000000-0000-4000-8000-0000000002e5","jev_outcome":"customer"}', NULL, 'still unknown'),
  ('{"decision_point":"sender_role","row_id":"0f000000-0000-4000-8000-0000000002ea","jev_outcome":"customer"}', NULL, 'no stamp'),
  ('{"decision_point":"sender_role","row_id":"0f000000-0000-4000-8000-0000000002ff","jev_outcome":"customer"}', NULL, 'a message gone'),
  -- email_triage: the stamp first; where it names nobody, only what is known for sure.
  ('{"row_id":"0f000000-0000-4000-8000-0000000002e2"}', 'internal', 'our own staff'),
  ('{"row_id":"0f000000-0000-4000-8000-0000000002e7"}', 'supplier', 'a supplier'),
  ('{"row_id":"0f000000-0000-4000-8000-0000000002e8"}', 'insurer_builder', 'a builder'),
  ('{"row_id":"0f000000-0000-4000-8000-0000000002e4"}', 'council', 'a council'),
  ('{"row_id":"0f000000-0000-4000-8000-0000000002e3"}', 'customer_job', 'the customer'),
  ('{"row_id":"0f000000-0000-4000-8000-0000000002e6"}', 'not_junk', 'a sender nobody knows on a job: not junk, who wrote it not known'),
  ('{"row_id":"0f000000-0000-4000-8000-0000000002eb"}', 'not_junk', 'a sender nobody knows, from a free personal mail address'),
  ('{"row_id":"0f000000-0000-4000-8000-0000000002ec"}', 'marketing_junk', 'a newsletter mailbox nobody knows'),
  ('{"row_id":"0f000000-0000-4000-8000-0000000002ed"}', 'marketing_junk', 'a sender the email reader called automated'),
  ('{"row_id":"0f000000-0000-4000-8000-0000000002ee"}', NULL, 'a business sender nobody knows, on no job: not known'),
  ('{"row_id":"0f000000-0000-4000-8000-0000000002e5"}', NULL, 'nobody known, on no job, no address: not known'),
  ('{"row_id":"0f000000-0000-4000-8000-0000000002e9"}', NULL, 'still waiting for its placement'),
  -- visit_happened: the job's crew bookings for the day asked, as recorded now.
  ('{"decision_point":"visit_happened","job_id":"0f000000-0000-4000-8000-0000000001a1","row_table":"job_assignments","row_id":"0f000000-0000-4000-8000-0000000003b1","jev_outcome":"yes","current_answer":{"booking_date":"2026-10-01"}}', 'yes', 'marked complete'),
  ('{"decision_point":"visit_happened","job_id":"0f000000-0000-4000-8000-0000000001a1","row_table":"job_assignments","row_id":"0f000000-0000-4000-8000-0000000003b2","jev_outcome":"yes","current_answer":{"booking_date":"2026-10-02"}}', 'yes', 'started'),
  ('{"decision_point":"visit_happened","job_id":"0f000000-0000-4000-8000-0000000001a1","row_table":"job_assignments","row_id":"0f000000-0000-4000-8000-0000000003b3","jev_outcome":"yes","current_answer":{"booking_date":"2026-10-03"}}', 'no', 'cancelled'),
  ('{"decision_point":"visit_happened","job_id":"0f000000-0000-4000-8000-0000000001a1","row_table":"job_assignments","row_id":"0f000000-0000-4000-8000-0000000003b4","jev_outcome":"yes","current_answer":{"booking_date":"2026-10-04"}}', 'yes', 'a visit outcome that day says it happened'),
  ('{"decision_point":"visit_happened","job_id":"0f000000-0000-4000-8000-0000000001a8","row_table":"job_assignments","row_id":"0f000000-0000-4000-8000-0000000003b5","jev_outcome":"yes","current_answer":{"booking_date":"2026-10-05"}}', 'no', 'a visit outcome that day says it did not'),
  ('{"decision_point":"visit_happened","job_id":"0f000000-0000-4000-8000-0000000001a2","row_table":"job_assignments","row_id":"0f000000-0000-4000-8000-0000000003b6","jev_outcome":"yes","current_answer":{"booking_date":"2026-10-05"}}', 'yes', 'the job moved on to complete'),
  ('{"decision_point":"visit_happened","job_id":"0f000000-0000-4000-8000-0000000001a1","row_table":"job_assignments","row_id":"0f000000-0000-4000-8000-0000000003b7","jev_outcome":"yes","current_answer":{"booking_date":"2026-10-06"}}', NULL, 'nothing recorded (another day''s outcome never counts)'),
  ('{"decision_point":"visit_happened","job_id":"0f000000-0000-4000-8000-0000000001a9","row_table":"job_assignments","row_id":"0f000000-0000-4000-8000-0000000003b9","jev_outcome":"yes","current_answer":{"booking_date":"2026-10-05"}}', 'no', 'moved to another day and completed there'),
  ('{"decision_point":"visit_happened","job_id":"0f000000-0000-4000-8000-0000000001aa","row_table":"job_assignments","row_id":"0f000000-0000-4000-8000-0000000003ba","jev_outcome":"yes","current_answer":{"booking_date":"2026-10-05"}}', 'no', 'deleted, its deletion recorded'),
  ('{"decision_point":"visit_happened","job_id":"0f000000-0000-4000-8000-0000000001ab","row_table":"job_assignments","row_id":"0f000000-0000-4000-8000-0000000003bb","jev_outcome":"yes","current_answer":{"booking_date":"2026-10-05"}}', 'no', 'deleted, the job''s deletion event for that day'),
  ('{"decision_point":"visit_happened","job_id":"0f000000-0000-4000-8000-0000000001ac","row_table":"job_assignments","row_id":"0f000000-0000-4000-8000-0000000003bc","jev_outcome":"yes","current_answer":{"booking_date":"2026-10-05"}}', NULL, 'gone with no deletion recorded'),
  ('{"decision_point":"visit_happened","job_id":"0f000000-0000-4000-8000-0000000001ad","row_table":"job_assignments","row_id":"0f000000-0000-4000-8000-0000000003bd","jev_outcome":"yes","current_answer":{"booking_date":"2026-10-05"}}', 'yes', 'moved, another crew booking that day completed'),
  ('{"decision_point":"visit_happened","job_id":"0f000000-0000-4000-8000-0000000001ae","row_table":"job_assignments","row_id":"0f000000-0000-4000-8000-0000000003bf","jev_outcome":"yes","current_answer":{"booking_date":"2026-10-05"}}', 'yes', 'cancelled, another crew booking still on that day and the job moved on'),
  ('{"decision_point":"visit_happened","job_id":"0f000000-0000-4000-8000-0000000001af","row_table":"job_assignments","row_id":"0f000000-0000-4000-8000-0000000003c1","jev_outcome":"yes","current_answer":{"booking_date":"2026-10-05"}}', NULL, 'a later visit booked, so the job''s status says nothing of that day'),
  ('{"decision_point":"visit_happened","job_id":"0f000000-0000-4000-8000-0000000001b0","row_table":"job_assignments","row_id":"0f000000-0000-4000-8000-0000000003c3","jev_outcome":"yes","current_answer":{"booking_date":"2026-10-05"}}', 'no', 'moved, only an observer copy left on that day'),
  ('{"decision_point":"visit_happened","job_id":"0f000000-0000-4000-8000-0000000001b1","row_table":"job_assignments","row_id":"0f000000-0000-4000-8000-0000000003c5","jev_outcome":"yes","current_answer":{"booking_date":"2026-10-05"}}', 'yes', 'moved into a span covering that day, and started'),
  ('{"decision_point":"visit_happened","job_id":"0f000000-0000-4000-8000-0000000001b2","row_table":"job_assignments","row_id":"0f000000-0000-4000-8000-0000000003c6","jev_outcome":"yes","current_answer":{"booking_date":"not a date"}}', NULL, 'a bad stored date: the day asked is not known'),
  ('{"decision_point":"visit_happened","job_id":"0f000000-0000-4000-8000-0000000001b3","row_table":"job_assignments","row_id":"0f000000-0000-4000-8000-0000000003c7","jev_outcome":"yes","current_answer":{"booking_date":"2026-10-05"}}', 'no', 'removed, named on the job''s removal event'),
  ('{"decision_point":"visit_happened","job_id":"0f000000-0000-4000-8000-0000000001b4","row_table":"job_assignments","row_id":"0f000000-0000-4000-8000-0000000003c8","jev_outcome":"yes","current_answer":{"booking_date":"2026-10-05"}}', 'no', 'removed, that day on the job''s removal event'),
  ('{"decision_point":"visit_happened","job_id":"0f000000-0000-4000-8000-0000000001b5","row_table":"job_assignments","row_id":"0f000000-0000-4000-8000-0000000003c9","jev_outcome":"yes","current_answer":{"booking_date":"2026-10-05"}}', 'no', 'a visit outcome corrected to did not happen'),
  -- lead_alive: the job's status now.
  ('{"decision_point":"lead_alive","job_id":"0f000000-0000-4000-8000-0000000001a4","jev_outcome":"alive"}', 'won', 'accepted'),
  ('{"decision_point":"lead_alive","job_id":"0f000000-0000-4000-8000-0000000001a2","jev_outcome":"alive"}', 'won', 'complete'),
  ('{"decision_point":"lead_alive","job_id":"0f000000-0000-4000-8000-0000000001a5","jev_outcome":"alive"}', 'lost', 'lost'),
  ('{"decision_point":"lead_alive","job_id":"0f000000-0000-4000-8000-0000000001a6","jev_outcome":"alive"}', 'lost', 'archived while quoted'),
  ('{"decision_point":"lead_alive","job_id":"0f000000-0000-4000-8000-0000000001a3","jev_outcome":"alive"}', NULL, 'still quoted'),
  ('{"decision_point":"lead_alive","job_id":"0f000000-0000-4000-8000-0000000001a7","jev_outcome":"alive"}', NULL, 'back to draft'),
  -- Points compared with today's answer have no later truth.
  ('{"decision_point":"payment_wait","job_id":"0f000000-0000-4000-8000-0000000001a4","row_table":"xero_invoices","row_id":"0f000000-0000-4000-8000-0000000000c1","jev_outcome":"paid","current_outcome":"hold"}', NULL, 'payment wait'),
  ('{"decision_point":"placement","row_id":"0f000000-0000-4000-8000-0000000002e3","jev_outcome":"none","current_outcome":"none"}', NULL, 'placement')
 ) v(body, want, label) LOOP
  d := jsonb_populate_record(NULL::public.context_jev_decisions, pg_temp.jp_row(c.body::jsonb));
  got := public.context_jev_truth(d);
  IF got IS DISTINCT FROM c.want THEN RAISE EXCEPTION 'jev points contract: truth for % is %, expected %', c.label, coalesce(got, 'null'), coalesce(c.want, 'null'); END IF;
 END LOOP;
END $$;
ROLLBACK;

-- 5. Agreement: the three earlier points read as before; each new point compared with its later truth or today's
-- answer, its agreement and unsafe rules exact, every band at its boundary, a row with no truth yet answered but not
-- compared, and failures counted in band all.
BEGIN;
DO $$
DECLARE t0 timestamptz := now() - interval '1 hour'; t1 timestamptz := now(); actual jsonb; expected jsonb; got record;
  j1 text := '0f000000-0000-4000-8000-0000000001a1';
BEGIN
 PERFORM pg_temp.jp_records();
 -- The first three points: one placement agreed, one gate unsafe, one failed reply.
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'placement', 'row_id', '0f000000-0000-4000-8000-0000000002e3', 'jev_outcome', 'job',
  'jev_job_id', j1, 'current_outcome', 'job', 'current_job_id', j1, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'ledger_update_gate', 'job_id', j1, 'row_table', NULL, 'row_id', NULL,
  'jev_outcome', 'no_change', 'jev_confidence', 0.91, 'current_outcome', 'change', 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'ledger_reply_owed', 'job_id', j1, 'row_id', '0f000000-0000-4000-8000-0000000002e3',
  'jev_outcome', NULL, 'jev_confidence', NULL, 'model', NULL, 'error_code', 'jev_timeout', 'attempts', 3, 'created_at', t0));
 -- sender_role: S1 agreed; S2 another party named for the customer (unsafe); S3 the customer named for a supplier
 -- (unsafe); S4 unknown is never unsafe; S5 no truth yet; S6 failed.
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'sender_role', 'row_id', '0f000000-0000-4000-8000-0000000002e3', 'jev_outcome', 'customer', 'jev_confidence', 0.95, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'sender_role', 'row_id', '0f000000-0000-4000-8000-0000000002e3', 'jev_outcome', 'supplier', 'jev_confidence', 0.90, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'sender_role', 'row_id', '0f000000-0000-4000-8000-0000000002e7', 'jev_outcome', 'customer', 'jev_confidence', 0.85, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'sender_role', 'row_id', '0f000000-0000-4000-8000-0000000002e4', 'jev_outcome', 'unknown', 'jev_confidence', 0.60, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'sender_role', 'row_id', '0f000000-0000-4000-8000-0000000002e5', 'jev_outcome', 'other_party', 'jev_confidence', 0.40, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'sender_role', 'row_id', '0f000000-0000-4000-8000-0000000002e5', 'jev_outcome', NULL, 'jev_confidence', NULL, 'model', NULL, 'error_code', 'jev_http_529', 'attempts', 3, 'created_at', t0));
 -- visit_happened: V1 agreed; V2 said it happened when it was cancelled (unsafe); V3 agreed no; V4 unsure; V5 no truth yet;
 -- V6 said it happened on a day its booking left (moved and completed on another day: unsafe); V7 said it did not (agreed);
 -- V8 said it happened on a day its booking was deleted (unsafe).
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'visit_happened', 'job_id', '0f000000-0000-4000-8000-0000000001a1', 'row_table', 'job_assignments', 'row_id', '0f000000-0000-4000-8000-0000000003b1', 'jev_outcome', 'yes', 'jev_confidence', 0.95, 'current_answer', '{"booking_date":"2026-10-01"}'::jsonb, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'visit_happened', 'job_id', '0f000000-0000-4000-8000-0000000001a1', 'row_table', 'job_assignments', 'row_id', '0f000000-0000-4000-8000-0000000003b3', 'jev_outcome', 'yes', 'jev_confidence', 0.9999, 'current_answer', '{"booking_date":"2026-10-03"}'::jsonb, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'visit_happened', 'job_id', '0f000000-0000-4000-8000-0000000001a8', 'row_table', 'job_assignments', 'row_id', '0f000000-0000-4000-8000-0000000003b5', 'jev_outcome', 'no', 'jev_confidence', 0.80, 'current_answer', '{"booking_date":"2026-10-05"}'::jsonb, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'visit_happened', 'job_id', '0f000000-0000-4000-8000-0000000001a2', 'row_table', 'job_assignments', 'row_id', '0f000000-0000-4000-8000-0000000003b6', 'jev_outcome', 'unsure', 'jev_confidence', 0.55, 'current_answer', '{"booking_date":"2026-10-05"}'::jsonb, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'visit_happened', 'job_id', '0f000000-0000-4000-8000-0000000001a1', 'row_table', 'job_assignments', 'row_id', '0f000000-0000-4000-8000-0000000003b7', 'jev_outcome', 'yes', 'jev_confidence', 0.30, 'current_answer', '{"booking_date":"2026-10-06"}'::jsonb, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'visit_happened', 'job_id', '0f000000-0000-4000-8000-0000000001a9', 'row_table', 'job_assignments', 'row_id', '0f000000-0000-4000-8000-0000000003b9', 'jev_outcome', 'yes', 'jev_confidence', 0.97, 'current_answer', '{"booking_date":"2026-10-05"}'::jsonb, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'visit_happened', 'job_id', '0f000000-0000-4000-8000-0000000001a9', 'row_table', 'job_assignments', 'row_id', '0f000000-0000-4000-8000-0000000003b9', 'jev_outcome', 'no', 'jev_confidence', 0.92, 'current_answer', '{"booking_date":"2026-10-05"}'::jsonb, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'visit_happened', 'job_id', '0f000000-0000-4000-8000-0000000001aa', 'row_table', 'job_assignments', 'row_id', '0f000000-0000-4000-8000-0000000003ba', 'jev_outcome', 'yes', 'jev_confidence', 0.85, 'current_answer', '{"booking_date":"2026-10-05"}'::jsonb, 'created_at', t0));
 -- lead_alive: L1 alive and won; L2 declined but won (unsafe); L3 gone elsewhere and lost; L4 paused and won (agreed);
 -- L5 unsure and lost; L6 still quoted.
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'lead_alive', 'job_id', '0f000000-0000-4000-8000-0000000001a4', 'row_id', '0f000000-0000-4000-8000-0000000002e3', 'jev_outcome', 'alive', 'jev_confidence', 0.93, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'lead_alive', 'job_id', '0f000000-0000-4000-8000-0000000001a4', 'row_id', '0f000000-0000-4000-8000-0000000002e3', 'jev_outcome', 'declined', 'jev_confidence', 0.96, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'lead_alive', 'job_id', '0f000000-0000-4000-8000-0000000001a5', 'row_id', '0f000000-0000-4000-8000-0000000002e3', 'jev_outcome', 'gone_elsewhere', 'jev_confidence', 0.85, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'lead_alive', 'job_id', '0f000000-0000-4000-8000-0000000001a4', 'row_id', '0f000000-0000-4000-8000-0000000002e3', 'jev_outcome', 'paused', 'jev_confidence', 0.70, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'lead_alive', 'job_id', '0f000000-0000-4000-8000-0000000001a6', 'row_id', '0f000000-0000-4000-8000-0000000002e3', 'jev_outcome', 'unsure', 'jev_confidence', 0.60, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'lead_alive', 'job_id', '0f000000-0000-4000-8000-0000000001a3', 'row_id', '0f000000-0000-4000-8000-0000000002e3', 'jev_outcome', 'alive', 'jev_confidence', 0.20, 'created_at', t0));
 -- payment_wait: P1 nothing waits and the collector reminds; P2 nothing waits while the collector held on the
 -- customer's words (unsafe); P3 the same held for another reason (a recent message, not what it says: not compared);
 -- P4 paid and held on the customer's words; P5 asked for time while the collector reminds; P6 no verdict; P7 asked for
 -- time beside a hold for another reason (not compared: never an agreement).
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'payment_wait', 'job_id', j1, 'row_table', 'xero_invoices', 'row_id', '0f000000-0000-4000-8000-0000000000c1', 'jev_outcome', 'none', 'jev_confidence', 0.94, 'current_outcome', 'remind', 'current_answer', '{"customer_held":false}'::jsonb, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'payment_wait', 'job_id', j1, 'row_table', 'xero_invoices', 'row_id', '0f000000-0000-4000-8000-0000000000c1', 'jev_outcome', 'none', 'jev_confidence', 0.92, 'current_outcome', 'hold', 'current_answer', '{"customer_held":true}'::jsonb, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'payment_wait', 'job_id', j1, 'row_table', 'xero_invoices', 'row_id', '0f000000-0000-4000-8000-0000000000c1', 'jev_outcome', 'none', 'jev_confidence', 0.91, 'current_outcome', 'hold', 'current_answer', '{"customer_held":false}'::jsonb, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'payment_wait', 'job_id', j1, 'row_table', 'xero_invoices', 'row_id', '0f000000-0000-4000-8000-0000000000c1', 'jev_outcome', 'paid', 'jev_confidence', 0.85, 'current_outcome', 'hold', 'current_answer', '{"customer_held":true}'::jsonb, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'payment_wait', 'job_id', j1, 'row_table', 'xero_invoices', 'row_id', '0f000000-0000-4000-8000-0000000000c1', 'jev_outcome', 'asked_for_time', 'jev_confidence', 0.75, 'current_outcome', 'remind', 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'payment_wait', 'job_id', j1, 'row_table', 'xero_invoices', 'row_id', '0f000000-0000-4000-8000-0000000000c1', 'jev_outcome', 'disputes', 'jev_confidence', 0.45, 'current_outcome', NULL, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'payment_wait', 'job_id', j1, 'row_table', 'xero_invoices', 'row_id', '0f000000-0000-4000-8000-0000000000c1', 'jev_outcome', 'asked_for_time', 'jev_confidence', 0.88, 'current_outcome', 'hold', 'current_answer', '{"customer_held":false}'::jsonb, 'created_at', t0));
 -- email_triage: T1 internal; T2 marketing or junk where nothing is known (not compared); T3 marketing or junk for the
 -- customer (unsafe); T4 a customer about a job on a job's email from a sender nobody knows (not compared: who wrote it
 -- is not known); T5 a supplier for a builder; T6 a council; T7 waiting for its placement; T8 failed; T9 marketing or
 -- junk from a free personal mail address (unsafe); T10 a customer about a job from it (not compared); T11 marketing or
 -- junk from a newsletter mailbox (agreed); T12 marketing or junk on a job's email from a sender nobody knows (unsafe).
 PERFORM pg_temp.jp_insert(jsonb_build_object('row_id', '0f000000-0000-4000-8000-0000000002e2', 'jev_outcome', 'internal', 'jev_confidence', 0.97, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('row_id', '0f000000-0000-4000-8000-0000000002e5', 'jev_outcome', 'marketing_junk', 'jev_confidence', 0.95, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('row_id', '0f000000-0000-4000-8000-0000000002e3', 'jev_outcome', 'marketing_junk', 'jev_confidence', 0.93, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('row_id', '0f000000-0000-4000-8000-0000000002e6', 'jev_outcome', 'customer_job', 'jev_confidence', 0.88, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('row_id', '0f000000-0000-4000-8000-0000000002e8', 'jev_outcome', 'supplier', 'jev_confidence', 0.80, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('row_id', '0f000000-0000-4000-8000-0000000002e4', 'jev_outcome', 'council', 'jev_confidence', 0.65, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('row_id', '0f000000-0000-4000-8000-0000000002e9', 'jev_outcome', 'customer_job', 'jev_confidence', 0.50, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('row_id', '0f000000-0000-4000-8000-0000000002e9', 'jev_outcome', NULL, 'jev_confidence', NULL, 'model', NULL, 'error_code', 'jev_timeout', 'attempts', 3, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('row_id', '0f000000-0000-4000-8000-0000000002eb', 'jev_outcome', 'marketing_junk', 'jev_confidence', 0.96, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('row_id', '0f000000-0000-4000-8000-0000000002eb', 'jev_outcome', 'customer_job', 'jev_confidence', 0.91, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('row_id', '0f000000-0000-4000-8000-0000000002ec', 'jev_outcome', 'marketing_junk', 'jev_confidence', 0.99, 'created_at', t0));
 PERFORM pg_temp.jp_insert(jsonb_build_object('row_id', '0f000000-0000-4000-8000-0000000002e6', 'jev_outcome', 'marketing_junk', 'jev_confidence', 0.82, 'created_at', t0));

 SELECT jsonb_agg(jsonb_build_array(a.decision_point, a.confidence_band, a.answered, a.compared, a.agreed, a.agreement, a.unsafe, a.failed, a.pairs)
  ORDER BY n) INTO actual
 FROM (SELECT x.*, row_number() OVER () AS n FROM public.context_jev_agreement(t0, t1) x) a;
 expected := '[
  ["placement","all",1,1,1,1.0000,0,0,{"job>job":1}],
  ["placement","0.90-1.00",1,1,1,1.0000,0,0,{"job>job":1}],
  ["placement","0.80-0.90",0,0,0,null,0,0,{}],
  ["placement","0.50-0.80",0,0,0,null,0,0,{}],
  ["placement","0.00-0.50",0,0,0,null,0,0,{}],
  ["ledger_update_gate","all",1,1,0,0.0000,1,0,{"no_change>change":1}],
  ["ledger_update_gate","0.90-1.00",1,1,0,0.0000,1,0,{"no_change>change":1}],
  ["ledger_update_gate","0.80-0.90",0,0,0,null,0,0,{}],
  ["ledger_update_gate","0.50-0.80",0,0,0,null,0,0,{}],
  ["ledger_update_gate","0.00-0.50",0,0,0,null,0,0,{}],
  ["ledger_reply_owed","all",0,0,0,null,0,1,{}],
  ["ledger_reply_owed","0.90-1.00",0,0,0,null,0,0,{}],
  ["ledger_reply_owed","0.80-0.90",0,0,0,null,0,0,{}],
  ["ledger_reply_owed","0.50-0.80",0,0,0,null,0,0,{}],
  ["ledger_reply_owed","0.00-0.50",0,0,0,null,0,0,{}],
  ["sender_role","all",5,4,1,0.2500,2,1,{"customer>customer":1,"supplier>customer":1,"customer>supplier":1,"unknown>other_party":1}],
  ["sender_role","0.90-1.00",2,2,1,0.5000,1,0,{"customer>customer":1,"supplier>customer":1}],
  ["sender_role","0.80-0.90",1,1,0,0.0000,1,0,{"customer>supplier":1}],
  ["sender_role","0.50-0.80",1,1,0,0.0000,0,0,{"unknown>other_party":1}],
  ["sender_role","0.00-0.50",1,0,0,null,0,0,{}],
  ["visit_happened","all",8,7,3,0.4286,3,0,{"yes>yes":1,"yes>no":3,"no>no":2,"unsure>yes":1}],
  ["visit_happened","0.90-1.00",4,4,2,0.5000,2,0,{"yes>yes":1,"yes>no":2,"no>no":1}],
  ["visit_happened","0.80-0.90",2,2,1,0.5000,1,0,{"no>no":1,"yes>no":1}],
  ["visit_happened","0.50-0.80",1,1,0,0.0000,0,0,{"unsure>yes":1}],
  ["visit_happened","0.00-0.50",1,0,0,null,0,0,{}],
  ["lead_alive","all",6,5,3,0.6000,1,0,{"alive>won":1,"declined>won":1,"gone_elsewhere>lost":1,"paused>won":1,"unsure>lost":1}],
  ["lead_alive","0.90-1.00",2,2,1,0.5000,1,0,{"alive>won":1,"declined>won":1}],
  ["lead_alive","0.80-0.90",1,1,1,1.0000,0,0,{"gone_elsewhere>lost":1}],
  ["lead_alive","0.50-0.80",2,2,1,0.5000,0,0,{"paused>won":1,"unsure>lost":1}],
  ["lead_alive","0.00-0.50",1,0,0,null,0,0,{}],
  ["payment_wait","all",7,4,2,0.5000,1,0,{"none>remind":1,"none>hold":1,"paid>hold":1,"asked_for_time>remind":1}],
  ["payment_wait","0.90-1.00",3,2,1,0.5000,1,0,{"none>remind":1,"none>hold":1}],
  ["payment_wait","0.80-0.90",2,1,1,1.0000,0,0,{"paid>hold":1}],
  ["payment_wait","0.50-0.80",1,1,0,0.0000,0,0,{"asked_for_time>remind":1}],
  ["payment_wait","0.00-0.50",1,0,0,null,0,0,{}],
  ["email_triage","all",11,7,3,0.4286,3,1,{"internal>internal":1,"marketing_junk>customer_job":1,"marketing_junk>not_junk":2,"marketing_junk>marketing_junk":1,"supplier>insurer_builder":1,"council>council":1}],
  ["email_triage","0.90-1.00",6,4,2,0.5000,2,0,{"internal>internal":1,"marketing_junk>customer_job":1,"marketing_junk>not_junk":1,"marketing_junk>marketing_junk":1}],
  ["email_triage","0.80-0.90",3,2,0,0.0000,1,0,{"supplier>insurer_builder":1,"marketing_junk>not_junk":1}],
  ["email_triage","0.50-0.80",2,1,1,1.0000,0,0,{"council>council":1}],
  ["email_triage","0.00-0.50",0,0,0,null,0,0,{}]
 ]'::jsonb;
 IF actual IS DISTINCT FROM expected THEN
  FOR got IN SELECT e.value AS want, a.value AS have FROM jsonb_array_elements(expected) WITH ORDINALITY e(value, n)
   FULL JOIN jsonb_array_elements(actual) WITH ORDINALITY a(value, n) ON a.n = e.n WHERE e.value IS DISTINCT FROM a.value LOOP
   RAISE NOTICE 'want % have %', got.want, got.have;
  END LOOP;
  -- Named failures for the rules most worth protecting.
  IF actual->25->6 IS DISTINCT FROM expected->25->6 THEN RAISE EXCEPTION 'jev points contract: a lead Jev called dead that was won is not counted unsafe'; END IF;
  IF actual->30->6 IS DISTINCT FROM expected->30->6 THEN RAISE EXCEPTION 'jev points contract: a reminder Jev would send over the customer''s words is not counted unsafe'; END IF;
  IF actual->30->3 IS DISTINCT FROM expected->30->3 THEN RAISE EXCEPTION 'jev points contract: a hold that rests on no customer words is compared with Jev'; END IF;
  IF actual->35->6 IS DISTINCT FROM expected->35->6 THEN RAISE EXCEPTION 'jev points contract: an email Jev would skip as junk is not counted unsafe'; END IF;
  IF actual->35->8 IS DISTINCT FROM expected->35->8 THEN RAISE EXCEPTION 'jev points contract: an email is compared beyond what is known of it'; END IF;
  IF actual->20->6 IS DISTINCT FROM expected->20->6 THEN RAISE EXCEPTION 'jev points contract: a visit Jev says happened on a day its booking left is not counted unsafe'; END IF;
  IF actual->0 IS DISTINCT FROM expected->0 OR actual->5 IS DISTINCT FROM expected->5 THEN RAISE EXCEPTION 'jev points contract: the first three points no longer read as before'; END IF;
  RAISE EXCEPTION 'jev points contract: the agreement read is wrong';
 END IF;
END $$;
ROLLBACK;

-- 6. Roles at work: the service role runs both reads over a row of each new point; anon is refused the truth read.
BEGIN;
DO $$
BEGIN
 PERFORM pg_temp.jp_records();
 -- A minute ago: the default window ends at now, exclusive.
 PERFORM pg_temp.jp_insert(jsonb_build_object('row_id', '0f000000-0000-4000-8000-0000000002ec', 'created_at', now() - interval '1 minute'));
 PERFORM pg_temp.jp_insert(jsonb_build_object('decision_point', 'lead_alive', 'job_id', '0f000000-0000-4000-8000-0000000001a4', 'row_id', '0f000000-0000-4000-8000-0000000002e3',
  'jev_outcome', 'alive', 'created_at', now() - interval '1 minute'));
END $$;
SET LOCAL ROLE service_role;
DO $$
DECLARE n bigint;
BEGIN
 SELECT a.compared INTO n FROM public.context_jev_agreement() a WHERE a.decision_point = 'lead_alive' AND a.confidence_band = 'all';
 IF n IS DISTINCT FROM 1::bigint THEN RAISE EXCEPTION 'jev points contract: the service role does not read the later truth (compared %)', n; END IF;
 IF (SELECT public.context_jev_truth(d) FROM public.context_jev_decisions d WHERE d.decision_point = 'email_triage') IS DISTINCT FROM 'marketing_junk' THEN
  RAISE EXCEPTION 'jev points contract: the service role does not read an email''s truth';
 END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE anon;
DO $$
BEGIN
 BEGIN
  PERFORM public.context_jev_truth(NULL::public.context_jev_decisions);
  RAISE EXCEPTION 'jev points contract: anon ran the truth read';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;
ROLLBACK;
