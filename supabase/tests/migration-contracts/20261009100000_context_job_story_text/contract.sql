-- Contract for 20261009100000_context_job_story_text: the saved job story.
-- Every fixture write is rolled back; ids, names and numbers are made up.
--  1. Shape: both tables with their exact columns, RLS on with no policy, the
--     service role reads and nobody else may do anything; every function with
--     this migration's comment, service role only, definer with a fixed path
--     (the inlinable helpers carry no SET); the switch row created off; the
--     reservations' phase list admits story; the admission is this migration's.
--  2. The sections check: exactly the five keys, trimmed, not empty, within
--     the lengths, no dash, no control character but a line break.
--  3. The checks check: codes and counts only.
--  4. The digest (story-digest-v1): never moved by the clock, prose, a JSON
--     round trip, array order or the session time zone; moved by what a story
--     must follow; its exact form in C order.
--  5. The policy's numbers.
--  6. A request: off, queued, already_open, not_live, recent against queued.
--  7. The claim: off (switch, lane), budget, idle, asked first, a lease held,
--     an expired lease claimed again and counted, a wait, max_attempts.
--  8. The save: lease_lost, refused, saved (one current, the old superseded,
--     the request closed), the store refusing two current stories.
--  9. The finish: unchanged, failed, released (counted and waited, or a stop).
-- 10. The sweep: what is due, what is skipped, the limit.
-- 11. The read: none, fresh, stale, unchecked, the writer's state.
-- 12. The writer's input.
-- 13. The admission's story branch, and the budget read agreeing with it.
-- 14. Access for the service role and for a signed-in user.
-- 15. A second apply changes nothing.
-- Concurrent claims (SKIP LOCKED) are in concurrent.sh.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.st_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'story text contract: %', p_msg; END IF; END $$;
CREATE FUNCTION pg_temp.st_today() RETURNS date LANGUAGE sql AS $$ SELECT (now() AT TIME ZONE 'Australia/Perth')::date $$;
-- The live cadence policy, so an override changes only what a section names (the morning line).
CREATE TABLE pg_temp.st_base_policy AS SELECT public.context_cadence_policy() AS p;
CREATE FUNCTION pg_temp.st_policy(p_over jsonb) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 EXECUTE format('CREATE OR REPLACE FUNCTION public.context_cadence_policy() RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $b$ SELECT %L::jsonb $b$',
  (SELECT p FROM pg_temp.st_base_policy) || p_over);
END $$;
CREATE FUNCTION pg_temp.st_flag(p_on boolean) RETURNS void LANGUAGE sql AS $$
 UPDATE public.feature_flags SET enabled = p_on WHERE flag_name = 'context_job_story_text_v1' $$;
CREATE FUNCTION pg_temp.st_lanes(p_extraction boolean) RETURNS void LANGUAGE sql AS $$
 UPDATE public.automation_switches SET capture = true, attribution = true, extraction = p_extraction, all_stop = false WHERE id = 1 $$;
-- Exactly p_total calls today (ordinals 1..p_total), the first p_story of them story calls.
CREATE FUNCTION pg_temp.st_calls(p_total integer, p_story integer DEFAULT 0) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM public.context_model_call_reservations WHERE run_date = pg_temp.st_today();
 INSERT INTO public.context_model_call_reservations (run_date, ordinal, phase, reserved_at)
 SELECT pg_temp.st_today(), g, CASE WHEN g <= p_story THEN 'story' ELSE 'bucket' END, now() FROM generate_series(1, p_total) g;
END $$;
CREATE FUNCTION pg_temp.st_used() RETURNS integer LANGUAGE sql AS $$
 SELECT count(*)::integer FROM public.context_model_call_reservations WHERE run_date = pg_temp.st_today() $$;
CREATE FUNCTION pg_temp.st_jid(p_n integer) RETURNS uuid LANGUAGE sql AS $$
 SELECT ('5e000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid $$;
-- A job (made-up client), created well before any fixture row.
CREATE FUNCTION pg_temp.st_job(p_n integer, p_status text DEFAULT 'scheduled') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid := pg_temp.st_jid(p_n);
BEGIN
 INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, metadata, created_at, updated_at)
 VALUES (j, '00000000-0000-4000-8000-0000000000aa', 'SWF-ST' || lpad(p_n::text, 3, '0'), p_status, 'fencing', 'Client ' || p_n, '{}',
         '2026-09-01 01:00Z', '2026-09-01 01:00Z');
 RETURN j;
END $$;
-- Five plain sections, as the writer returns them.
CREATE FUNCTION pg_temp.st_sections(p_headline text DEFAULT 'The fence is booked for Thu 8 Oct and the deposit is paid.') RETURNS jsonb
LANGUAGE sql AS $$
 SELECT jsonb_build_object('headline', p_headline,
  'the_job', 'A 23 metre rear fence for the owner and a neighbour.',
  'how_we_got_here', 'We quoted on Mon 5 Oct and the owner accepted on Thu 8 Oct.' || E'\n' || 'The neighbour agreed to pay half.',
  'where_it_is_at', 'The deposit is paid. It is our move to book the crew.',
  'watch_out', 'Nothing stands out.') $$;
CREATE FUNCTION pg_temp.st_request(p_id uuid, p_job uuid, p_reason text DEFAULT 'asked', p_ago interval DEFAULT '1 minute') RETURNS uuid
LANGUAGE sql AS $$
 INSERT INTO public.context_job_story_requests (id, job_id, requested_by, reason, requested_at)
 VALUES (p_id, p_job, CASE WHEN p_reason = 'asked' THEN 'user:5e0000ff-0000-4000-8000-000000000001' ELSE 'luna-story-writer' END,
         p_reason, now() - p_ago)
 RETURNING id $$;
CREATE FUNCTION pg_temp.st_token(p_request uuid) RETURNS uuid LANGUAGE sql AS $$
 SELECT lease_token FROM public.context_job_story_requests WHERE id = p_request $$;
-- A synthetic job-story-v1 card (no real job behind it) for the digest checks.
CREATE FUNCTION pg_temp.st_card() RETURNS jsonb LANGUAGE sql AS $$
 SELECT '{
  "version": "job-story-v1",
  "job": {"id": "5e000000-0000-4000-8000-000000000999", "job_number": "SWF-ST999", "type": "fencing", "status": "accepted", "client_name": "Client Nine"},
  "as_of": "2026-10-09T02:00:00+00:00",
  "now": {"line": "Accepted since Thu 8 Oct (1 day): our move.", "phase": "accepted", "phase_since": "2026-10-08", "whose_move": "us",
          "monitored": true, "not_followed_up_since": null, "next": {"what": "Book the crew"}, "blockers": [{"what": "Deposit not paid"}]},
  "money": {"line": "Invoiced $1,000.00, paid $0.00, owing $1,000.00 (overdue since Thu 1 Oct)",
            "job_value": {"amount": 7065.85, "basis": "accepted_quote"},
            "not_yet_invoiced": {"amount": 6065.85, "basis": "job value minus issued customer invoices"},
            "parties": [{"party": "customer", "xero_contact_id": "xc1", "invoiced": 1000.00, "paid": 0.00, "credited": 0, "owing": 1000.00,
                         "overdue": 1000.00, "oldest_overdue_due": "2026-10-01", "drafts": 1, "draft_total": 3571.43,
                         "invoices": [{"id": "i1", "number": "INV-9001", "status": "AUTHORISED", "total": 1000.00, "paid": 0.00, "owing": 1000.00,
                                       "due_date": "2026-10-01", "fully_paid_on": null, "overdue": true, "days_overdue": 8},
                                      {"id": "i2", "number": "INV-9002", "status": "DRAFT", "total": 3571.43, "paid": 0.00, "owing": 0,
                                       "due_date": null, "fully_paid_on": null, "overdue": false, "days_overdue": null}]}],
            "placed_on_no_job": [], "supplier_bills": []},
  "loops": [{"key": "R1_overdue:i1", "source": "record", "rule": "R1_overdue", "owner": "customer", "counterparty": "us",
             "what": "INV-9001 is overdue", "why": "Due Thu 1 Oct", "since": "2026-10-01T00:00:00+00:00", "due": "2026-10-01",
             "age_days": 8, "status": "open", "blocks": "payment", "cites": [{"t": "xero_invoices", "id": "i1"}], "rank": 1},
            {"key": "ledger:deposit_link", "source": "ledger", "rule": null, "owner": "us", "counterparty": "customer",
             "what": "Send the deposit link", "why": "the customer asked", "since": "2026-10-08T06:00:00+00:00", "due": null,
             "age_days": 1, "status": "open", "blocks": "deposit", "cites": [], "rank": 2}],
  "checks": [{"rule": "C2_value", "what": "The draft may duplicate issued invoices", "cites": [{"t": "xero_invoices", "id": "i2"}]}],
  "timeline": [{"at": "2026-10-05T01:00:00+00:00", "date": "2026-10-05", "kind": "quote", "what": "Quote Q-1 sent", "amount": 7065.85,
                "phase": "quote", "source_table": "job_documents", "source_id": "d1", "state": "sent", "made_at": null},
               {"at": "2026-10-08T06:01:00+00:00", "date": "2026-10-08", "kind": "quote", "what": "Quote Q-1 accepted", "amount": 7065.85,
                "phase": "quote", "source_table": "job_documents", "source_id": "d1", "state": "accepted", "made_at": null}],
  "phase_notes": [{"phase": "quote", "what": "The quote went out quickly."}],
  "agreements": [{"key": "split", "what": "The neighbour pays half", "modality": "agreed", "status": "info", "since": "2026-10-08T06:00:00+00:00"}],
  "events": [{"key": "tenants_away", "what": "The tenants are away", "at": "2026-09-29T00:00:00+00:00"}],
  "who": [{"name": "amy", "role": "third_party", "contact_ref": null}, {"name": "Bob", "role": "customer", "contact_ref": "ctB"}],
  "last_exchange": {"customer_said": {"at": "2026-10-09T01:25:00+00:00", "table": "business_events", "id": "e1", "text": "Will do"},
                    "we_told_customer": {"at": "2026-10-09T01:22:00+00:00", "table": "business_events", "id": "e0", "text": "Bank details sent"},
                    "internal": null},
  "handling": {"customer_messages": 4, "replies": 3, "median_reply_hours": 1.5, "unanswered": 0, "commitments": null},
  "not_known": [{"what": "Calls that were not recorded are not here.", "why": ""}],
  "changes": null,
  "meta": {"ledger": {"status": "live", "generation_id": "g1", "evidence_until": "2026-10-09T01:30:00+00:00", "reader": "luna-ledger:v1",
                      "items": 3, "hidden_items": 0, "unread_rows": 0, "needs_rebuild": false, "stale": false},
           "sources": {}, "evidence_rows": 12, "built_at": "2026-10-09T02:00:01+00:00"}
 }'::jsonb $$;
CREATE FUNCTION pg_temp.st_hash(p_card jsonb) RETURNS text LANGUAGE sql AS $$ SELECT public.context_job_story_card_hash(p_card) $$;

-- 1. Shape.
DO $c$
DECLARE cols text; t text; r text; p text; x record;
BEGIN
 SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum) INTO cols
 FROM pg_attribute a WHERE a.attrelid = 'public.context_job_story_requests'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
 PERFORM pg_temp.st_assert(cols = 'id:uuid,job_id:uuid,requested_at:timestamp with time zone,requested_by:text,reason:text,'
  'picked_at:timestamp with time zone,lease_token:uuid,lease_expires_at:timestamp with time zone,attempts:smallint,'
  'next_attempt_at:timestamp with time zone,claimed_state:jsonb,done_at:timestamp with time zone,outcome:text,error:text', 'request columns ' || cols);
 SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum) INTO cols
 FROM pg_attribute a WHERE a.attrelid = 'public.context_job_story_texts'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
 PERFORM pg_temp.st_assert(cols = 'id:uuid,job_id:uuid,request_id:uuid,written_at:timestamp with time zone,checked_at:timestamp with time zone,'
  'evidence_until:timestamp with time zone,generation_id:uuid,job_status:text,record_sig:text,card_hash:text,model:text,'
  'prompt_sha256:text,sections:jsonb,checks:jsonb,status:text,superseded_at:timestamp with time zone', 'story columns ' || cols);
 FOREACH t IN ARRAY ARRAY['public.context_job_story_requests', 'public.context_job_story_texts'] LOOP
  PERFORM pg_temp.st_assert((SELECT relrowsecurity FROM pg_class WHERE oid = t::regclass), t || ' RLS is off');
  PERFORM pg_temp.st_assert(NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = t::regclass), t || ' carries a policy');
  PERFORM pg_temp.st_assert(obj_description(t::regclass, 'pg_class') LIKE 'Job story text (20261009100000):%', t || ' comment');
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
   FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
    PERFORM pg_temp.st_assert(NOT has_table_privilege(r, t, p), format('%s may %s %s', r, p, t));
   END LOOP;
  END LOOP;
  PERFORM pg_temp.st_assert(has_table_privilege('service_role', t, 'SELECT'), 'service_role cannot read ' || t);
  FOREACH p IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
   PERFORM pg_temp.st_assert(NOT has_table_privilege('service_role', t, p), format('service_role may %s %s', p, t));
  END LOOP;
 END LOOP;
 PERFORM pg_temp.st_assert((SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'context_job_story_requests_one_open')
  LIKE 'CREATE UNIQUE INDEX % ON public.context_job_story_requests USING btree (job_id) WHERE (done_at IS NULL)', 'one open request a job');
 PERFORM pg_temp.st_assert((SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'context_job_story_texts_one_current')
  LIKE 'CREATE UNIQUE INDEX % ON public.context_job_story_texts USING btree (job_id) WHERE (status = ''current''::text)', 'one current story a job');
 PERFORM pg_temp.st_assert((SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('context_job_story_requests_due',
  'context_job_story_requests_job', 'context_job_story_texts_job')) = 3, 'an index is missing');
 -- Functions: this migration's comment; service role only; definer with a fixed path, or an inlinable helper.
 FOR x IN SELECT * FROM (VALUES
   ('public.context_job_story_text_policy()', 'policy'), ('public.context_job_story_text_on()', 'definer'),
   ('public.context_job_story_sections_problem(jsonb)', 'helper'), ('public.context_job_story_checks_problem(jsonb)', 'helper'),
   ('public.context_job_story_digest_num(jsonb)', 'helper'), ('public.context_job_story_digest_at(jsonb)', 'helper'),
   ('public.context_job_story_card_hash(jsonb)', 'helper'), ('public.context_job_story_reading(uuid)', 'helper'),
   ('public.context_job_story_record_sig(uuid)', 'definer'), ('public.context_job_story_claim_state(uuid)', 'definer'),
   ('public.context_job_story_budget()', 'definer'), ('public.context_job_story_text_get(uuid,jsonb,boolean)', 'definer'),
   ('public.context_job_story_request(uuid,text,text)', 'definer'), ('public.context_job_story_enqueue_changed(integer)', 'definer'),
   ('public.context_job_story_claim(integer)', 'definer'), ('public.context_job_story_writer_input(uuid)', 'definer'),
   ('public.context_job_story_text_save(uuid,uuid,uuid,jsonb,text,timestamptz,uuid,text,text,jsonb)', 'definer'),
   ('public.context_job_story_request_finish(uuid,uuid,text,text,timestamptz)', 'definer')) AS v(sig, kind) LOOP
  PERFORM pg_temp.st_assert(to_regprocedure(x.sig) IS NOT NULL, x.sig || ' missing');
  PERFORM pg_temp.st_assert(obj_description(to_regprocedure(x.sig), 'pg_proc') LIKE 'Job story text (20261009100000):%', x.sig || ' comment');
  PERFORM pg_temp.st_assert(NOT has_function_privilege('anon', x.sig, 'EXECUTE') AND NOT has_function_privilege('authenticated', x.sig, 'EXECUTE'),
   x.sig || ' executable by anon or authenticated');
  PERFORM pg_temp.st_assert(has_function_privilege('service_role', x.sig, 'EXECUTE'), x.sig || ' not executable by service_role');
  PERFORM pg_temp.st_assert(NOT EXISTS (SELECT 1 FROM pg_proc pp, aclexplode(coalesce(pp.proacl, acldefault('f', pp.proowner))) a
   WHERE pp.oid = to_regprocedure(x.sig) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'), x.sig || ' executable by PUBLIC');
  PERFORM pg_temp.st_assert(CASE x.kind
    WHEN 'definer' THEN (SELECT prosecdef AND proconfig = ARRAY['search_path=public, pg_temp'] FROM pg_proc WHERE oid = to_regprocedure(x.sig))
    WHEN 'helper' THEN (SELECT NOT prosecdef AND proconfig IS NULL FROM pg_proc WHERE oid = to_regprocedure(x.sig))
    ELSE (SELECT NOT prosecdef AND proconfig = ARRAY['search_path=pg_catalog'] FROM pg_proc WHERE oid = to_regprocedure(x.sig)) END,
   x.sig || ' security or search path');
 END LOOP;
 -- The switch: one row, off, saying the owner turns it on.
 PERFORM pg_temp.st_assert((SELECT count(*) FROM public.feature_flags WHERE flag_name = 'context_job_story_text_v1') = 1
  AND (SELECT enabled FROM public.feature_flags WHERE flag_name = 'context_job_story_text_v1') IS FALSE, 'the switch is not exactly one row created off');
 PERFORM pg_temp.st_assert((SELECT description FROM public.feature_flags WHERE flag_name = 'context_job_story_text_v1') LIKE '%Owner''s word to turn on.%'
  AND strpos((SELECT description FROM public.feature_flags WHERE flag_name = 'context_job_story_text_v1'), chr(8212)) = 0,
  'the switch does not say the owner turns it on, or holds a dash');
 -- The admission and the phase list.
 PERFORM pg_temp.st_assert((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.reserve_context_model_call(text,uuid,uuid)'::regprocedure)
  = '25a5b5f208af726d47e952f98cecef56', 'the admission is not this migration''s body');
 PERFORM pg_temp.st_assert(obj_description('public.reserve_context_model_call(text,uuid,uuid)'::regprocedure, 'pg_proc') LIKE '%1000%'
  AND obj_description('public.reserve_context_model_call(text,uuid,uuid)'::regprocedure, 'pg_proc') LIKE '%Story (20261009100000)%',
  'the admission comment keeps the call budget and names the story branch');
 PERFORM pg_temp.st_assert(NOT has_function_privilege('anon', 'public.reserve_context_model_call(text,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.reserve_context_model_call(text,uuid,uuid)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.reserve_context_model_call(text,uuid,uuid)', 'EXECUTE'), 'admission grants');
 PERFORM pg_temp.st_assert((SELECT string_agg(pg_get_constraintdef(oid), ' | ') FROM pg_constraint
   WHERE conrelid = 'public.context_model_call_reservations'::regclass AND contype = 'c' AND convalidated
   AND pg_get_constraintdef(oid) LIKE '%phase = ANY%')
  = $d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'vision'::text, 'ledger'::text, 'story'::text])))$d$,
  'the reservations phase list must admit story');
END $c$;

-- 2. The sections check.
DO $c$
DECLARE s jsonb := pg_temp.st_sections(); k text;
BEGIN
 PERFORM pg_temp.st_assert(public.context_job_story_sections_problem(s) IS NULL, 'good sections refused: ' || coalesce(public.context_job_story_sections_problem(s), ''));
 PERFORM pg_temp.st_assert(public.context_job_story_sections_problem(NULL) IS NOT NULL, 'null sections passed');
 PERFORM pg_temp.st_assert(public.context_job_story_sections_problem('[]') IS NOT NULL, 'an array passed');
 PERFORM pg_temp.st_assert(public.context_job_story_sections_problem(s - 'watch_out') LIKE 'sections must hold exactly%', 'a missing section passed');
 PERFORM pg_temp.st_assert(public.context_job_story_sections_problem(s || '{"extra":"x"}') LIKE 'sections must hold exactly%', 'an extra section passed');
 FOREACH k IN ARRAY ARRAY['headline', 'the_job', 'how_we_got_here', 'where_it_is_at', 'watch_out'] LOOP
  PERFORM pg_temp.st_assert(public.context_job_story_sections_problem(jsonb_set(s, ARRAY[k], '7')) = k || ' must be a string', k || ' as a number passed');
  PERFORM pg_temp.st_assert(public.context_job_story_sections_problem(jsonb_set(s, ARRAY[k], '""')) = k || ' must be trimmed and not empty', k || ' empty passed');
  PERFORM pg_temp.st_assert(public.context_job_story_sections_problem(jsonb_set(s, ARRAY[k], to_jsonb(' Text.'::text))) = k || ' must be trimmed and not empty',
   k || ' untrimmed passed');
  PERFORM pg_temp.st_assert(public.context_job_story_sections_problem(jsonb_set(s, ARRAY[k], to_jsonb('Paid' || chr(8212) || 'booked.'))) = k || ' holds a dash',
   k || ' with an em dash passed');
  PERFORM pg_temp.st_assert(public.context_job_story_sections_problem(jsonb_set(s, ARRAY[k], to_jsonb('5' || chr(8211) || '10 days.'))) = k || ' holds a dash',
   k || ' with an en dash passed');
  PERFORM pg_temp.st_assert(public.context_job_story_sections_problem(jsonb_set(s, ARRAY[k], to_jsonb('Tab' || chr(9) || 'here.'))) = k || ' holds a control character',
   k || ' with a tab passed');
 END LOOP;
 PERFORM pg_temp.st_assert(public.context_job_story_sections_problem(jsonb_set(s, '{headline}', to_jsonb(repeat('a', 200)))) IS NULL, 'a 200 character headline refused');
 PERFORM pg_temp.st_assert(public.context_job_story_sections_problem(jsonb_set(s, '{headline}', to_jsonb(repeat('a', 201)))) LIKE 'headline is longer than 200%', 'a 201 character headline passed');
 PERFORM pg_temp.st_assert(public.context_job_story_sections_problem(jsonb_set(s, '{watch_out}', to_jsonb(repeat('a', 700)))) IS NULL, 'a 700 character section refused');
 PERFORM pg_temp.st_assert(public.context_job_story_sections_problem(jsonb_set(s, '{watch_out}', to_jsonb(repeat('a', 701)))) LIKE 'watch_out is longer than 700%', 'a 701 character section passed');
 -- The table enforces it.
 BEGIN
  INSERT INTO public.context_job_story_texts (job_id, checked_at, card_hash, model, sections)
  VALUES (pg_temp.st_jid(1), now(), md5('x'), 'gpt-6-luna', jsonb_set(s, '{headline}', to_jsonb('Paid' || chr(8212) || 'booked.')));
  RAISE EXCEPTION 'story text contract: the store kept a dash';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
END $c$;

-- 3. The checks check: codes and counts only.
DO $c$
BEGIN
 PERFORM pg_temp.st_assert(public.context_job_story_checks_problem('{}') IS NULL, 'empty checks refused');
 PERFORM pg_temp.st_assert(public.context_job_story_checks_problem('{"writer":"luna-story:v1","fact_check":{"amounts":3,"dates":2,"unsupported_amounts":0},'
  '"retried":false,"dashes_replaced":1,"prompt_bytes":40210,"inputs":{"timeline":12,"evidence_rows":30,"notes":5,"notes_open":2},"codes":["ok",null,1.5]}') IS NULL,
  'the writer''s checks refused');
 PERFORM pg_temp.st_assert(public.context_job_story_checks_problem(NULL) IS NOT NULL, 'null checks passed');
 PERFORM pg_temp.st_assert(public.context_job_story_checks_problem('[]') IS NOT NULL, 'array checks passed');
 PERFORM pg_temp.st_assert(public.context_job_story_checks_problem('{"note":"the customer said yes"}') = 'checks hold codes and counts only', 'words passed');
 PERFORM pg_temp.st_assert(public.context_job_story_checks_problem('{"a":{"b":["fine","not fine"]}}') = 'checks hold codes and counts only', 'nested words passed');
 PERFORM pg_temp.st_assert(public.context_job_story_checks_problem('{"a key":1}') = 'checks hold codes and counts only', 'a key with a space passed');
 PERFORM pg_temp.st_assert(public.context_job_story_checks_problem(jsonb_build_object('n', repeat('x', 80))) IS NULL, 'an 80 character code refused');
 PERFORM pg_temp.st_assert(public.context_job_story_checks_problem(jsonb_build_object('n', repeat('x', 81))) IS NOT NULL, 'an 81 character code passed');
 PERFORM pg_temp.st_assert(public.context_job_story_checks_problem((SELECT jsonb_object_agg('k' || g, g) FROM generate_series(1, 900) g))
  = 'checks must be at most 8192 bytes', 'oversized checks passed');
END $c$;

-- 4. The digest (story-digest-v1).
DO $c$
DECLARE c jsonb := pg_temp.st_card(); h text := pg_temp.st_hash(pg_temp.st_card()); x jsonb; n integer := 0;
BEGIN
 -- The clock never moves it.
 PERFORM pg_temp.st_assert(pg_temp.st_hash(c || '{"as_of":"2026-10-10T09:00:00+00:00"}') = h, 'the digest moves with the clock (as_of)');
 PERFORM pg_temp.st_assert(pg_temp.st_hash(jsonb_set(c, '{meta,built_at}', '"2026-10-10T09:00:01+00:00"')) = h, 'the digest moves with the clock (built_at)');
 PERFORM pg_temp.st_assert(pg_temp.st_hash(jsonb_set(c, '{loops,0,age_days}', '9')) = h, 'the digest moves with the clock (age_days)');
 PERFORM pg_temp.st_assert(pg_temp.st_hash(jsonb_set(c, '{money,parties,0,invoices,0,days_overdue}', '9')) = h, 'the digest moves with the clock (days_overdue)');
 PERFORM pg_temp.st_assert(pg_temp.st_hash(jsonb_set(c, '{now,line}', '"Accepted since Thu 8 Oct (2 days): our move."')) = h,
  'the digest moves with the clock (a day count in the first line)');
 PERFORM pg_temp.st_assert(pg_temp.st_hash(jsonb_set(c, '{money,line}', '"Invoiced $1,000.00 (9 days overdue)"')) = h, 'the digest moves with the money line');
 -- Nor does prose, or anything else outside the digest.
 x := jsonb_set(jsonb_set(jsonb_set(c, '{loops,0,what}', '"Other words"'), '{loops,0,why}', '"Other why"'), '{loops,0,cites}', '[]');
 x := jsonb_set(jsonb_set(x, '{timeline,0,what}', '"Other words"'), '{checks,0,what}', '"Other words"');
 x := jsonb_set(jsonb_set(x, '{not_known}', '[]'), '{handling,unanswered}', '3');
 x := jsonb_set(jsonb_set(x, '{now,next}', '{"what":"Other"}'), '{now,blockers}', '[]');
 x := jsonb_set(jsonb_set(x, '{meta,ledger,items}', '9'), '{meta,ledger,unread_rows}', '4');
 x := jsonb_set(jsonb_set(x, '{meta,ledger,generation_id}', '"g2"'), '{meta,ledger,evidence_until}', '"2026-10-10T00:00:00+00:00"');
 x := jsonb_set(jsonb_set(x, '{money,parties,0,overdue}', '0'), '{money,parties,0,oldest_overdue_due}', 'null');
 x := jsonb_set(jsonb_set(x, '{agreements,0,what}', '"Other words"'), '{who,0,contact_ref}', '"ct9"');
 x := jsonb_set(x, '{last_exchange,customer_said,text}', '"Other words"');
 PERFORM pg_temp.st_assert(pg_temp.st_hash(x) = h, 'the digest reads prose or a field outside story-digest-v1');
 -- A JSON round trip (0.00 read back as 0, 1000.00 as 1000), array order, key order, the session time zone.
 x := jsonb_set(jsonb_set(c, '{money,parties,0,paid}', '0'), '{money,parties,0,invoices,0,total}', '1000');
 x := jsonb_set(x, '{money,parties,0,invoices,1,paid}', '0.000');
 PERFORM pg_temp.st_assert(pg_temp.st_hash(x) = h, 'a JSON round trip moves the digest');
 x := jsonb_set(c, '{loops}', (SELECT jsonb_agg(l ORDER BY (l ->> 'rank')::integer DESC) FROM jsonb_array_elements(c -> 'loops') l));
 x := jsonb_set(x, '{who}', (SELECT jsonb_agg(w ORDER BY w ->> 'role') FROM jsonb_array_elements(c -> 'who') w));
 x := jsonb_set(x, '{timeline}', (SELECT jsonb_agg(t ORDER BY t ->> 'at' DESC) FROM jsonb_array_elements(c -> 'timeline') t));
 x := jsonb_set(x, '{money,parties,0,invoices}', (SELECT jsonb_agg(i ORDER BY i ->> 'number' DESC) FROM jsonb_array_elements(c #> '{money,parties,0,invoices}') i));
 PERFORM pg_temp.st_assert(pg_temp.st_hash(x) = h, 'the digest reads array order');
 PERFORM pg_temp.st_assert(pg_temp.st_hash(jsonb_set(c, '{timeline,0,at}', '"2026-10-05T09:00:00+08:00"')) = h, 'the digest reads the session time zone');
 PERFORM pg_temp.st_assert(pg_temp.st_hash((c::text)::jsonb) = h, 'a text round trip moves the digest');
 -- What a story must follow moves it.
 FOR x IN SELECT v FROM (VALUES
   (jsonb_set(c, '{loops,0,status}', '"closed"')),
   (jsonb_set(c, '{loops,1,owner}', '"customer"')),
   (c || jsonb_build_object('loops', (c -> 'loops') || '[{"key":"R5_customer_wrote_last:e1","status":"open","owner":"us"}]'::jsonb)),
   (jsonb_set(c, '{money,parties,0,invoices,0,status}', '"PAID"')),
   (jsonb_set(c, '{money,parties,0,invoices,0,paid}', '500')),
   (jsonb_set(c, '{money,parties,0,invoices,0,overdue}', 'false')),
   (jsonb_set(c, '{money,parties,0,owing}', '0')),
   (jsonb_set(c, '{money,job_value,amount}', '7000')),
   (jsonb_set(c, '{job,status}', '"scheduled"')),
   (jsonb_set(c, '{now,whose_move}', '"customer"')),
   (jsonb_set(c, '{now,phase}', '"deposit"')),
   (jsonb_set(c, '{now,monitored}', 'false')),
   (c || jsonb_build_object('timeline', (c -> 'timeline') || '[{"at":"2026-10-09T01:00:00+00:00","kind":"payment","source_table":"xero_invoices","source_id":"i1","state":"PAID","amount":1000}]'::jsonb)),
   (c || jsonb_build_object('who', (c -> 'who') || '[{"name":"Cara","role":"neighbour"}]'::jsonb)),
   (jsonb_set(c, '{last_exchange,customer_said,id}', '"e2"')),
   (jsonb_set(c, '{agreements,0,status}', '"superseded"')),
   (c || jsonb_build_object('events', (c -> 'events') || '[{"key":"dog_on_site"}]'::jsonb)),
   (c || jsonb_build_object('phase_notes', (c -> 'phase_notes') || '[{"phase":"deposit","what":"x"}]'::jsonb)),
   (c || jsonb_build_object('checks', '[]'::jsonb)),
   (jsonb_set(c, '{meta,ledger,status}', '"none"'))) AS t(v) LOOP
  n := n + 1;
  PERFORM pg_temp.st_assert(pg_temp.st_hash(x) <> h, 'a change a story must follow kept the digest (change ' || n || ' in section 4)');
 END LOOP;
 -- The exact form, arrays in C order (B before a, whatever the database collation says).
 PERFORM pg_temp.st_assert(pg_temp.st_hash('{"job":{"id":"j","status":"quoted"},"who":[{"name":"amy","role":"customer"},{"name":"Bob","role":"customer"}]}')
  = md5(jsonb_build_object('digest', 'story-digest-v1', 'job', jsonb_build_object('id', 'j', 'status', 'quoted'),
     'now', jsonb_build_object('phase', NULL::text, 'phase_since', NULL::text, 'whose_move', NULL::text, 'monitored', NULL::jsonb, 'not_followed_up_since', NULL::text),
     'loops', '[]'::jsonb,
     'money', jsonb_build_object('job_value', NULL::numeric, 'not_yet_invoiced', NULL::numeric, 'parties', '[]'::jsonb, 'placed_on_no_job', '[]'::jsonb,
       'supplier_bills', '[]'::jsonb),
     'timeline', '[]'::jsonb, 'checks', '[]'::jsonb, 'agreements', '[]'::jsonb, 'events', '[]'::jsonb, 'phase_notes', '{}'::jsonb,
     'who', '[{"name":"Bob","role":"customer"},{"name":"amy","role":"customer"}]'::jsonb,
     'last', jsonb_build_object('customer', '', 'us', '', 'us_automated', '', 'internal', ''),
     'ledger', NULL::text)::text), 'the digest is not story-digest-v1 in C order');
 PERFORM pg_temp.st_assert(h ~ '^[0-9a-f]{32}$' AND pg_temp.st_hash(NULL) IS NULL, 'the digest is not an md5, or a null card has one');
END $c$;

-- 5. The policy.
DO $c$
DECLARE p jsonb := public.context_job_story_text_policy();
BEGIN
 PERFORM pg_temp.st_assert(p = '{"flag":"context_job_story_text_v1","calls_per_day":80,"lease_minutes":15,"min_rewrite_minutes":10,"quiet_minutes":15,'
  '"enqueue_per_call":5,"max_attempts":3,"retry_minutes":[30,120],"digest":"story-digest-v1","writer":"luna-story-writer"}'::jsonb, 'policy ' || p::text);
END $c$;

-- 6. A request.
BEGIN;
SET LOCAL session_replication_role = replica;
DO $c$
DECLARE j uuid := pg_temp.st_job(1); jc uuid := pg_temp.st_job(2, 'cancelled'); r jsonb; r2 jsonb; who constant text := 'user:5e0000ff-0000-4000-8000-000000000001';
 bad record;
BEGIN
 PERFORM pg_temp.st_lanes(true);
 DELETE FROM public.context_job_story_requests;
 DELETE FROM public.context_job_story_texts;
 -- Bad arguments are refused, switch on or off.
 PERFORM pg_temp.st_flag(false);
 FOR bad IN SELECT * FROM (VALUES (NULL::uuid, who, 'asked'), (pg_temp.st_jid(9001), who, 'asked'), (j, NULL, 'asked'),
   (j, 'user name', 'asked'), (j, who, 'nope'), (j, who, NULL)) AS t(job, by_, reason) LOOP
  BEGIN
   PERFORM public.context_job_story_request(bad.job, bad.by_, bad.reason);
   RAISE EXCEPTION 'story text contract: a bad request was accepted: % % %', bad.job, bad.by_, bad.reason;
  EXCEPTION WHEN invalid_parameter_value THEN
   PERFORM pg_temp.st_assert(SQLERRM = 'context_job_story_request_invalid', 'refusal ' || SQLERRM);
  END;
 END LOOP;
 -- Off: nothing written.
 r := public.context_job_story_request(j, who, 'asked');
 PERFORM pg_temp.st_assert(r = '{"outcome":"off"}', 'a request while the switch is off: ' || r::text);
 PERFORM pg_temp.st_assert(NOT EXISTS (SELECT 1 FROM public.context_job_story_requests), 'the switch off wrote a request');
 -- On: queued once; asking again returns the same open request.
 PERFORM pg_temp.st_flag(true);
 r := public.context_job_story_request(j, who, 'asked');
 PERFORM pg_temp.st_assert(r ->> 'outcome' = 'queued' AND r ->> 'reason' = 'asked' AND r ->> 'request_id' IS NOT NULL, 'first request: ' || r::text);
 r2 := public.context_job_story_request(j, 'luna-story-writer', 'job_changed');
 PERFORM pg_temp.st_assert(r2 ->> 'outcome' = 'already_open' AND r2 ->> 'request_id' = r ->> 'request_id' AND r2 ->> 'reason' = 'asked',
  'second request: ' || r2::text);
 PERFORM pg_temp.st_assert((SELECT count(*) FROM public.context_job_story_requests WHERE job_id = j) = 1
  AND (SELECT requested_by FROM public.context_job_story_requests WHERE job_id = j) = who, 'one open request, by who asked');
 -- job_changed only for a live, monitored job; asked on any job.
 r := public.context_job_story_request(jc, 'luna-story-writer', 'job_changed');
 PERFORM pg_temp.st_assert(r = '{"outcome":"not_live"}' AND NOT EXISTS (SELECT 1 FROM public.context_job_story_requests WHERE job_id = jc),
  'job_changed on a cancelled job: ' || r::text);
 r := public.context_job_story_request(jc, who, 'asked');
 PERFORM pg_temp.st_assert(r ->> 'outcome' = 'queued', 'asked on a cancelled job: ' || r::text);
 -- recent: a story under 10 minutes old that is still fresh is not rewritten; one that is stale, or older, is.
 UPDATE public.context_job_story_requests SET done_at = now(), outcome = 'written' WHERE job_id = j AND done_at IS NULL;
 INSERT INTO public.context_job_story_texts (job_id, checked_at, card_hash, model, sections)
 VALUES (j, now(), public.context_job_story_card_hash(public.context_job_story(j, now())), 'gpt-6-luna', pg_temp.st_sections());
 r := public.context_job_story_request(j, who, 'asked');
 PERFORM pg_temp.st_assert(r ->> 'outcome' = 'recent' AND (r ->> 'text_id')::uuid = (SELECT id FROM public.context_job_story_texts WHERE job_id = j)
  AND NOT EXISTS (SELECT 1 FROM public.context_job_story_requests WHERE job_id = j AND done_at IS NULL), 'a fresh new story: ' || r::text);
 UPDATE public.context_job_story_texts SET card_hash = md5('another card') WHERE job_id = j;
 r := public.context_job_story_request(j, who, 'asked');
 PERFORM pg_temp.st_assert(r ->> 'outcome' = 'queued', 'a stale new story: ' || r::text);
 UPDATE public.context_job_story_requests SET done_at = now(), outcome = 'written' WHERE job_id = j AND done_at IS NULL;
 UPDATE public.context_job_story_texts SET card_hash = public.context_job_story_card_hash(public.context_job_story(j, now())),
  written_at = now() - interval '11 minutes' WHERE job_id = j;
 r := public.context_job_story_request(j, who, 'asked');
 PERFORM pg_temp.st_assert(r ->> 'outcome' = 'queued', 'a fresh story past the rewrite floor: ' || r::text);
END $c$;
ROLLBACK;

-- 7. The claim.
BEGIN;
SET LOCAL session_replication_role = replica;
DO $c$
DECLARE j1 uuid := pg_temp.st_job(11); j2 uuid := pg_temp.st_job(12); j3 uuid := pg_temp.st_job(13); j4 uuid := pg_temp.st_job(14);
 ra constant uuid := '5e100000-0000-4000-8000-000000000011'; rb constant uuid := '5e100000-0000-4000-8000-000000000012';
 rc constant uuid := '5e100000-0000-4000-8000-000000000013'; rd constant uuid := '5e100000-0000-4000-8000-000000000014';
 r jsonb; cs jsonb;
BEGIN
 PERFORM pg_temp.st_lanes(true);
 PERFORM pg_temp.st_policy('{"morning_until":"00:00"}');   -- never morning
 UPDATE public.context_ledger_settings SET live_reserve_calls = 100, live_reserve_calls_morning = 100 WHERE id;
 PERFORM pg_temp.st_calls(0);
 DELETE FROM public.context_job_story_requests;
 PERFORM pg_temp.st_flag(false);
 r := public.context_job_story_claim(1);
 PERFORM pg_temp.st_assert(r = '{"outcome":"off","reason":"story_off","requests":[]}', 'claim with the switch off: ' || r::text);
 PERFORM pg_temp.st_flag(true);
 PERFORM pg_temp.st_lanes(false);
 r := public.context_job_story_claim(1);
 PERFORM pg_temp.st_assert(r = '{"outcome":"off","reason":"lane_off","requests":[]}', 'claim with the extraction lane off: ' || r::text);
 PERFORM pg_temp.st_lanes(true);
 r := public.context_job_story_claim(1);
 PERFORM pg_temp.st_assert(r ->> 'outcome' = 'idle', 'claim with nothing asked: ' || r::text);
 -- The budget: the story's own ceiling, then the ledger's live reserve line.
 PERFORM pg_temp.st_request(ra, j1, 'job_changed', '1 hour');
 PERFORM pg_temp.st_calls(80, 80);
 r := public.context_job_story_claim(1);
 PERFORM pg_temp.st_assert(r ->> 'outcome' = 'budget' AND r ->> 'reason' = 'story_calls_per_day'
  AND (r ->> 'resets_at')::timestamptz = ((pg_temp.st_today() + 1)::timestamp AT TIME ZONE 'Australia/Perth')
  AND pg_temp.st_token(ra) IS NULL, 'claim past the story ceiling: ' || r::text);
 PERFORM pg_temp.st_calls(900);
 r := public.context_job_story_claim(1);
 PERFORM pg_temp.st_assert(r ->> 'outcome' = 'budget' AND r ->> 'reason' = 'live_reserve', 'claim inside the live reserve: ' || r::text);
 PERFORM pg_temp.st_calls(10);
 -- Asked goes first, then the oldest.
 PERFORM pg_temp.st_request(rb, j2, 'asked', '1 minute');
 r := public.context_job_story_claim(1);
 PERFORM pg_temp.st_assert(r ->> 'outcome' = 'claimed' AND jsonb_array_length(r -> 'requests') = 1
  AND (r #>> '{requests,0,request_id}')::uuid = rb AND (r #>> '{requests,0,job_id}')::uuid = j2 AND r #>> '{requests,0,reason}' = 'asked'
  AND (r #>> '{requests,0,lease_token}')::uuid = pg_temp.st_token(rb) AND (r #>> '{requests,0,attempts}')::integer = 0
  AND (r #>> '{requests,0,lease_expires_at}')::timestamptz = now() + interval '15 minutes', 'asked first: ' || r::text);
 PERFORM pg_temp.st_assert((SELECT picked_at FROM public.context_job_story_requests WHERE id = rb) = now(), 'picked_at is the claim');
 cs := (SELECT claimed_state FROM public.context_job_story_requests WHERE id = rb);
 PERFORM pg_temp.st_assert(cs ->> 'job_status' = 'scheduled' AND cs ->> 'record_sig' = public.context_job_story_record_sig(j2)
  AND cs ->> 'record_sig' ~ '^[0-9a-f]{32}$' AND cs ? 'generation_id' AND cs -> 'generation_id' = 'null'::jsonb, 'claimed state: ' || cs::text);
 r := public.context_job_story_claim(1);
 PERFORM pg_temp.st_assert((r #>> '{requests,0,request_id}')::uuid = ra, 'then the oldest: ' || r::text);
 r := public.context_job_story_claim(1);
 PERFORM pg_temp.st_assert(r ->> 'outcome' = 'idle', 'a held lease was claimed again: ' || r::text);
 -- An expired lease is claimed again, and the lost lease counts as an attempt.
 UPDATE public.context_job_story_requests SET lease_expires_at = now() - interval '1 second' WHERE id = ra;
 r := public.context_job_story_claim(1);
 PERFORM pg_temp.st_assert((r #>> '{requests,0,request_id}')::uuid = ra AND (r #>> '{requests,0,attempts}')::integer = 1, 'expired lease: ' || r::text);
 -- A request waiting out its retry is not due; one past max_attempts closes failed.
 PERFORM pg_temp.st_request(rc, j3, 'asked', '2 hours');
 UPDATE public.context_job_story_requests SET next_attempt_at = now() + interval '1 hour', attempts = 1 WHERE id = rc;
 r := public.context_job_story_claim(1);
 PERFORM pg_temp.st_assert(r ->> 'outcome' = 'idle' AND pg_temp.st_token(rc) IS NULL, 'a waiting request was claimed: ' || r::text);
 UPDATE public.context_job_story_requests SET next_attempt_at = NULL, attempts = 3 WHERE id = rc;
 r := public.context_job_story_claim(1);
 PERFORM pg_temp.st_assert(r ->> 'outcome' = 'idle' AND (r ->> 'closed')::integer = 1
  AND (SELECT outcome = 'failed' AND error = 'max_attempts' AND done_at IS NOT NULL AND lease_token IS NULL
       FROM public.context_job_story_requests WHERE id = rc), 'max attempts: ' || r::text);
 -- p_limit: up to that many, at most 5.
 PERFORM pg_temp.st_request(rd, j4, 'job_changed', '3 hours');
 UPDATE public.context_job_story_requests SET lease_expires_at = now() - interval '1 second' WHERE id IN (ra, rb);
 r := public.context_job_story_claim(10);
 PERFORM pg_temp.st_assert(r ->> 'outcome' = 'claimed' AND jsonb_array_length(r -> 'requests') = 3
  AND (r #>> '{requests,0,request_id}')::uuid = rb, 'claim three at once, asked first: ' || r::text);
END $c$;
ROLLBACK;

-- 8. The save.
BEGIN;
SET LOCAL session_replication_role = replica;
DO $c$
DECLARE j uuid := pg_temp.st_job(21); jo uuid := pg_temp.st_job(22);
 r1 constant uuid := '5e100000-0000-4000-8000-000000000021'; r2 constant uuid := '5e100000-0000-4000-8000-000000000022';
 r3 constant uuid := '5e100000-0000-4000-8000-000000000023';
 tok uuid; r jsonb; s jsonb := pg_temp.st_sections(); t1 uuid; good_checks constant jsonb :=
  '{"writer":"luna-story:v1","fact_check":{"amounts":2,"dates":3,"unsupported_amounts":0,"unsupported_dates":0},"retried":false,"inputs":{"timeline":5,"evidence_rows":9,"notes":2,"notes_open":1}}';
BEGIN
 PERFORM pg_temp.st_lanes(true);
 PERFORM pg_temp.st_flag(true);
 PERFORM pg_temp.st_policy('{"morning_until":"00:00"}');
 PERFORM pg_temp.st_calls(0);
 DELETE FROM public.context_job_story_requests;
 DELETE FROM public.context_job_story_texts;
 PERFORM pg_temp.st_request(r1, j, 'asked');
 PERFORM public.context_job_story_claim(1);
 tok := pg_temp.st_token(r1);
 r := public.context_job_story_text_save(r1, gen_random_uuid(), j, s, md5('card one'), NULL, NULL, 'gpt-6-luna', NULL, good_checks);
 PERFORM pg_temp.st_assert(r = '{"outcome":"lease_lost"}', 'a wrong token saved: ' || r::text);
 r := public.context_job_story_text_save(NULL, tok, j, s, md5('card one'), NULL, NULL, 'gpt-6-luna', NULL, good_checks);
 PERFORM pg_temp.st_assert(r = '{"outcome":"refused","reason":"ids_required"}', 'no request id: ' || r::text);
 r := public.context_job_story_text_save(r1, tok, jo, s, md5('card one'), NULL, NULL, 'gpt-6-luna', NULL, good_checks);
 PERFORM pg_temp.st_assert(r = '{"outcome":"refused","reason":"job_mismatch"}', 'another job: ' || r::text);
 r := public.context_job_story_text_save(r1, tok, j, jsonb_set(s, '{watch_out}', to_jsonb('Paid' || chr(8212) || 'booked.')), md5('card one'), NULL, NULL,
  'gpt-6-luna', NULL, good_checks);
 PERFORM pg_temp.st_assert(r ->> 'outcome' = 'refused' AND r ->> 'reason' = 'sections_invalid' AND r ->> 'problem' = 'watch_out holds a dash', 'a dash: ' || r::text);
 r := public.context_job_story_text_save(r1, tok, j, s, 'not a hash', NULL, NULL, 'gpt-6-luna', NULL, good_checks);
 PERFORM pg_temp.st_assert(r = '{"outcome":"refused","reason":"card_hash_invalid"}', 'a bad card hash: ' || r::text);
 r := public.context_job_story_text_save(r1, tok, j, s, md5('card one'), NULL, NULL, 'a model with spaces', NULL, good_checks);
 PERFORM pg_temp.st_assert(r = '{"outcome":"refused","reason":"model_invalid"}', 'a bad model: ' || r::text);
 r := public.context_job_story_text_save(r1, tok, j, s, md5('card one'), NULL, NULL, 'gpt-6-luna', 'abc', good_checks);
 PERFORM pg_temp.st_assert(r = '{"outcome":"refused","reason":"prompt_sha256_invalid"}', 'a bad prompt hash: ' || r::text);
 r := public.context_job_story_text_save(r1, tok, j, s, md5('card one'), NULL, NULL, 'gpt-6-luna', NULL, '{"note":"the customer said yes"}');
 PERFORM pg_temp.st_assert(r ->> 'outcome' = 'refused' AND r ->> 'reason' = 'checks_invalid', 'words in the checks: ' || r::text);
 PERFORM pg_temp.st_assert(NOT EXISTS (SELECT 1 FROM public.context_job_story_texts) AND pg_temp.st_token(r1) = tok, 'a refusal wrote or released');
 -- Saved: the one current story, the request closed written with its lease cleared.
 r := public.context_job_story_text_save(r1, tok, j, s, md5('card one'), '2026-10-09 01:30Z', NULL, 'gpt-6-luna', repeat('a', 64), good_checks);
 PERFORM pg_temp.st_assert(r ->> 'outcome' = 'saved' AND r -> 'superseded_id' = 'null'::jsonb, 'first save: ' || r::text);
 t1 := (r ->> 'text_id')::uuid;
 PERFORM pg_temp.st_assert((SELECT status = 'current' AND superseded_at IS NULL AND request_id = r1 AND card_hash = md5('card one')
   AND model = 'gpt-6-luna' AND prompt_sha256 = repeat('a', 64) AND sections = s AND checks = good_checks
   AND evidence_until = '2026-10-09 01:30Z' AND generation_id IS NULL AND job_status = 'scheduled'
   AND record_sig = public.context_job_story_record_sig(j)
   AND checked_at = (SELECT picked_at FROM public.context_job_story_requests WHERE id = r1)
   FROM public.context_job_story_texts WHERE id = t1), 'the saved story');
 PERFORM pg_temp.st_assert((SELECT done_at IS NOT NULL AND outcome = 'written' AND error IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL
   FROM public.context_job_story_requests WHERE id = r1), 'the request is closed written');
 r := public.context_job_story_text_save(r1, tok, j, s, md5('card one'), NULL, NULL, 'gpt-6-luna', NULL, good_checks);
 PERFORM pg_temp.st_assert(r = '{"outcome":"lease_lost"}', 'a closed request saved again: ' || r::text);
 -- A newer story supersedes it.
 PERFORM pg_temp.st_request(r2, j, 'job_changed');
 PERFORM public.context_job_story_claim(1);
 r := public.context_job_story_text_save(r2, pg_temp.st_token(r2), j, s, md5('card two'), NULL, NULL, 'gpt-6-luna', NULL, NULL);
 PERFORM pg_temp.st_assert(r ->> 'outcome' = 'saved' AND (r ->> 'superseded_id')::uuid = t1, 'second save: ' || r::text);
 PERFORM pg_temp.st_assert((SELECT status = 'superseded' AND superseded_at IS NOT NULL FROM public.context_job_story_texts WHERE id = t1)
  AND (SELECT count(*) FROM public.context_job_story_texts WHERE job_id = j AND status = 'current') = 1
  AND (SELECT checks FROM public.context_job_story_texts WHERE job_id = j AND status = 'current') = '{}'::jsonb, 'one current story, the old superseded');
 BEGIN
  INSERT INTO public.context_job_story_texts (job_id, checked_at, card_hash, model, sections) VALUES (j, now(), md5('x'), 'gpt-6-luna', s);
  RAISE EXCEPTION 'story text contract: the store kept two current stories';
 EXCEPTION WHEN unique_violation THEN NULL;
 END;
 -- An expired lease cannot save.
 PERFORM pg_temp.st_request(r3, j, 'asked');
 PERFORM public.context_job_story_claim(1);
 UPDATE public.context_job_story_requests SET lease_expires_at = now() - interval '1 second' WHERE id = r3;
 r := public.context_job_story_text_save(r3, pg_temp.st_token(r3), j, s, md5('card three'), NULL, NULL, 'gpt-6-luna', NULL, NULL);
 PERFORM pg_temp.st_assert(r = '{"outcome":"lease_lost"}', 'an expired lease saved: ' || r::text);
END $c$;
ROLLBACK;

-- 9. The finish.
BEGIN;
SET LOCAL session_replication_role = replica;
DO $c$
DECLARE j uuid := pg_temp.st_job(31); j2 uuid := pg_temp.st_job(32);
 r1 constant uuid := '5e100000-0000-4000-8000-000000000031'; r2 constant uuid := '5e100000-0000-4000-8000-000000000032';
 tok uuid; r jsonb; t uuid; bad record;
BEGIN
 PERFORM pg_temp.st_lanes(true);
 PERFORM pg_temp.st_flag(true);
 PERFORM pg_temp.st_policy('{"morning_until":"00:00"}');
 PERFORM pg_temp.st_calls(0);
 DELETE FROM public.context_job_story_requests;
 DELETE FROM public.context_job_story_texts;
 INSERT INTO public.context_job_story_texts (job_id, written_at, checked_at, job_status, record_sig, generation_id, evidence_until, card_hash, model, sections)
 VALUES (j, now() - interval '2 hours', now() - interval '2 hours', 'accepted', md5('old records'), gen_random_uuid(), now() - interval '3 hours',
         md5('card'), 'gpt-6-luna', pg_temp.st_sections())
 RETURNING id INTO t;
 PERFORM pg_temp.st_request(r1, j, 'job_changed');
 PERFORM public.context_job_story_claim(1);
 tok := pg_temp.st_token(r1);
 FOR bad IN SELECT * FROM (VALUES ('nope', NULL::text), ('failed', NULL), ('released', 'Has Space'), (NULL, NULL)) AS v(outcome, err) LOOP
  BEGIN
   PERFORM public.context_job_story_request_finish(r1, tok, bad.outcome, bad.err);
   RAISE EXCEPTION 'story text contract: a bad finish was accepted: % %', bad.outcome, bad.err;
  EXCEPTION WHEN invalid_parameter_value THEN
   PERFORM pg_temp.st_assert(SQLERRM = 'context_job_story_finish_invalid', 'refusal ' || SQLERRM);
  END;
 END LOOP;
 r := public.context_job_story_request_finish(r1, gen_random_uuid(), 'unchanged');
 PERFORM pg_temp.st_assert(r = '{"outcome":"lease_lost"}', 'a wrong token finished: ' || r::text);
 -- unchanged: the story stays and now covers the claim, as the claim found the job.
 r := public.context_job_story_request_finish(r1, tok, 'unchanged');
 PERFORM pg_temp.st_assert(r ->> 'outcome' = 'closed' AND r ->> 'closed_as' = 'unchanged' AND (r ->> 'text_id')::uuid = t, 'unchanged: ' || r::text);
 PERFORM pg_temp.st_assert((SELECT x.checked_at = q.picked_at AND x.job_status = 'scheduled' AND x.record_sig = public.context_job_story_record_sig(j)
   AND x.generation_id IS NULL AND x.evidence_until IS NULL AND x.status = 'current' AND x.card_hash = md5('card')
   FROM public.context_job_story_texts x, public.context_job_story_requests q WHERE x.id = t AND q.id = r1), 'the unchanged story covers the claim');
 PERFORM pg_temp.st_assert((SELECT outcome = 'unchanged' AND done_at IS NOT NULL AND lease_token IS NULL FROM public.context_job_story_requests WHERE id = r1),
  'the request is closed unchanged');
 -- released for a job error: counted, waits 30 then 120 minutes.
 PERFORM pg_temp.st_request(r2, j2, 'asked');
 PERFORM public.context_job_story_claim(1);
 r := public.context_job_story_request_finish(r2, pg_temp.st_token(r2), 'released', 'timeout');
 PERFORM pg_temp.st_assert(r ->> 'outcome' = 'released' AND (r ->> 'attempts')::integer = 1 AND (r ->> 'counted')::boolean
  AND (r ->> 'next_attempt_at')::timestamptz = now() + interval '30 minutes'
  AND (SELECT lease_token IS NULL AND done_at IS NULL AND error = 'timeout' FROM public.context_job_story_requests WHERE id = r2), 'first release: ' || r::text);
 PERFORM pg_temp.st_assert(public.context_job_story_claim(1) ->> 'outcome' = 'idle', 'a released request was claimed before its wait');
 UPDATE public.context_job_story_requests SET next_attempt_at = now() - interval '1 second' WHERE id = r2;
 r := public.context_job_story_claim(1);
 PERFORM pg_temp.st_assert((r #>> '{requests,0,attempts}')::integer = 1, 'a released lease counted again at the claim: ' || r::text);
 r := public.context_job_story_request_finish(r2, pg_temp.st_token(r2), 'released', 'invalid_output');
 PERFORM pg_temp.st_assert((r ->> 'attempts')::integer = 2 AND (r ->> 'next_attempt_at')::timestamptz = now() + interval '120 minutes', 'second release: ' || r::text);
 -- A stop is not counted and waits 5 minutes; a given wait is kept.
 UPDATE public.context_job_story_requests SET next_attempt_at = NULL WHERE id = r2;
 PERFORM public.context_job_story_claim(1);
 r := public.context_job_story_request_finish(r2, pg_temp.st_token(r2), 'released', 'story_budget');
 PERFORM pg_temp.st_assert((r ->> 'attempts')::integer = 2 AND NOT (r ->> 'counted')::boolean
  AND (r ->> 'next_attempt_at')::timestamptz = now() + interval '5 minutes', 'a stop: ' || r::text);
 UPDATE public.context_job_story_requests SET next_attempt_at = NULL WHERE id = r2;
 PERFORM public.context_job_story_claim(1);
 r := public.context_job_story_request_finish(r2, pg_temp.st_token(r2), 'released', 'rate_limited', now() + interval '1 hour');
 PERFORM pg_temp.st_assert((r ->> 'attempts')::integer = 2 AND (r ->> 'next_attempt_at')::timestamptz = now() + interval '1 hour', 'a given wait: ' || r::text);
 -- failed: closed with its code.
 UPDATE public.context_job_story_requests SET next_attempt_at = NULL WHERE id = r2;
 PERFORM public.context_job_story_claim(1);
 r := public.context_job_story_request_finish(r2, pg_temp.st_token(r2), 'failed', 'fact_check_failed');
 PERFORM pg_temp.st_assert(r = '{"outcome":"closed","closed_as":"failed","error":"fact_check_failed"}'
  AND (SELECT outcome = 'failed' AND error = 'fact_check_failed' AND done_at IS NOT NULL FROM public.context_job_story_requests WHERE id = r2),
  'failed: ' || r::text);
END $c$;
ROLLBACK;

-- 10. The sweep.
BEGIN;
SET LOCAL session_replication_role = replica;
DO $c$
DECLARE a uuid := pg_temp.st_job(41); b uuid := pg_temp.st_job(42, 'cancelled'); c uuid := pg_temp.st_job(43, 'quoted');
 d uuid := pg_temp.st_job(44); e uuid := pg_temp.st_job(45); f uuid := pg_temp.st_job(46); g uuid := pg_temp.st_job(47);
 h uuid := pg_temp.st_job(48); h2 uuid := pg_temp.st_job(49); i uuid := pg_temp.st_job(50);
 t0 timestamptz := now() - interval '2 hours'; gen1 uuid := '5e300000-0000-4000-8000-000000000001'; r jsonb;
BEGIN
 PERFORM pg_temp.st_lanes(true);
 DELETE FROM public.context_job_story_requests;
 DELETE FROM public.context_job_story_texts;
 PERFORM pg_temp.st_flag(false);
 r := public.context_job_story_enqueue_changed(NULL);
 PERFORM pg_temp.st_assert(r = '{"outcome":"off","queued":0,"job_ids":[]}', 'the sweep with the switch off: ' || r::text);
 PERFORM pg_temp.st_flag(true);
 -- f's customer invoice exists before its story; i read by gen1 before its story.
 INSERT INTO public.xero_invoices (id, org_id, xero_invoice_id, invoice_number, invoice_type, status, total, amount_due, amount_paid, job_id,
  created_at, updated_at)
 VALUES ('5e400000-0000-4000-8000-000000000046', '00000000-0000-4000-8000-0000000000aa', 'st-x46', 'INV-ST46', 'ACCREC', 'AUTHORISED', 500, 500, 0, f,
         t0 - interval '1 hour', t0 - interval '1 hour');
 INSERT INTO public.context_ledger_generations (id, job_id, kind, status, reader, evidence_until, promoted_at, created_at)
 VALUES (gen1, i, 'backfill', 'live', 'luna-ledger:v1', t0 - interval '1 hour', t0 - interval '1 hour', t0 - interval '1 hour');
 -- Every story written and checked two hours ago, carrying the job as it was then.
 INSERT INTO public.context_job_story_texts (job_id, written_at, checked_at, job_status, record_sig, generation_id, evidence_until, card_hash, model, sections)
 SELECT x, t0, t0, (SELECT jb.status::text FROM public.jobs jb WHERE jb.id = x), public.context_job_story_record_sig(x),
        rd.generation_id, rd.evidence_until, md5('card'), 'gpt-6-luna', pg_temp.st_sections()
 FROM unnest(ARRAY[a, b, c, d, e, f, g, h, h2, i]) x LEFT JOIN LATERAL public.context_job_story_reading(x) rd ON true;
 -- a: a customer invoice paid since (touched and changed): due.
 INSERT INTO public.xero_invoices (id, org_id, xero_invoice_id, invoice_number, invoice_type, status, total, amount_due, amount_paid, job_id,
  created_at, updated_at)
 VALUES ('5e400000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-0000000000aa', 'st-x41', 'INV-ST41', 'ACCREC', 'PAID', 1000, 0, 1000, a, now(), now()),
 -- b: the same on a cancelled job: not live.
        ('5e400000-0000-4000-8000-000000000042', '00000000-0000-4000-8000-0000000000aa', 'st-x42', 'INV-ST42', 'ACCREC', 'PAID', 1000, 0, 1000, b, now(), now());
 -- c: its status moved, but it is a lead with a quote sent 60 days ago and no reply: not followed up.
 UPDATE public.context_job_story_texts SET job_status = 'scheduled' WHERE job_id = c;
 INSERT INTO public.job_documents (id, job_id, type, quote_number, version, created_at, sent_at)
 VALUES ('5e500000-0000-4000-8000-000000000043', c, 'quote', 'Q-ST43', 1, now() - interval '61 days', now() - interval '60 days');
 -- d: an open request already. e: its status moved, but its story is two minutes old.
 PERFORM pg_temp.st_request('5e100000-0000-4000-8000-000000000044', d, 'asked');
 UPDATE public.context_job_story_texts SET job_status = 'accepted' WHERE job_id IN (d, e);
 UPDATE public.context_job_story_texts SET written_at = now() - interval '2 minutes' WHERE job_id = e;
 -- f: a sync rewrote its invoice row with the same money: not due.
 UPDATE public.xero_invoices SET updated_at = now() WHERE job_id = f;
 -- g: its status moved since (accepted to scheduled): due.
 UPDATE public.context_job_story_texts SET job_status = 'accepted' WHERE job_id = g;
 -- h: no AI reading and a customer text recorded an hour ago: due. h2: one recorded five minutes ago: not yet.
 INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, payload, metadata, occurred_at, recorded_at, event_at)
 VALUES ('5e600000-0000-4000-8000-000000000048', h, 'client.reply', 'ghl', 'sms', 'inbound', '{"body":"Thanks"}', '{}', now() - interval '1 hour',
         now() - interval '1 hour', now() - interval '1 hour'),
        ('5e600000-0000-4000-8000-000000000049', h2, 'client.reply', 'ghl', 'sms', 'inbound', '{"body":"Thanks"}', '{}', now() - interval '5 minutes',
         now() - interval '5 minutes', now() - interval '5 minutes');
 -- i: a new AI reading promoted since: due.
 UPDATE public.context_ledger_generations SET status = 'retired', retired_at = now() - interval '1 minute' WHERE id = gen1;
 INSERT INTO public.context_ledger_generations (job_id, kind, status, reader, evidence_until, promoted_at, created_at)
 VALUES (i, 'rebuild', 'live', 'luna-ledger:v1', now() - interval '1 minute', now() - interval '1 minute', now() - interval '2 minutes');
 r := public.context_job_story_enqueue_changed(NULL);
 PERFORM pg_temp.st_assert(r ->> 'outcome' = 'queued' AND (r ->> 'queued')::integer = 4 AND (r ->> 'candidates')::integer = 5
  AND r -> 'job_ids' = to_jsonb(ARRAY[a, g, h, i]), 'the sweep: ' || r::text);
 PERFORM pg_temp.st_assert((SELECT count(*) FROM public.context_job_story_requests WHERE reason = 'job_changed' AND requested_by = 'luna-story-writer'
   AND done_at IS NULL AND job_id IN (a, g, h, i)) = 4, 'the sweep''s requests');
 -- Nothing is queued twice; the limit holds, oldest checked first.
 r := public.context_job_story_enqueue_changed(NULL);
 PERFORM pg_temp.st_assert((r ->> 'queued')::integer = 0, 'the sweep queued twice: ' || r::text);
 DELETE FROM public.context_job_story_requests WHERE reason = 'job_changed';
 UPDATE public.context_job_story_texts SET checked_at = t0 - interval '1 minute' WHERE job_id = g;
 r := public.context_job_story_enqueue_changed(1);
 PERFORM pg_temp.st_assert((r ->> 'queued')::integer = 1 AND r -> 'job_ids' = to_jsonb(ARRAY[g]), 'the limit: ' || r::text);
 r := public.context_job_story_enqueue_changed(50);
 PERFORM pg_temp.st_assert((r ->> 'queued')::integer = 3, 'at most enqueue_per_call: ' || r::text);
END $c$;
ROLLBACK;

-- 11. The read.
BEGIN;
SET LOCAL session_replication_role = replica;
DO $c$
DECLARE j uuid := pg_temp.st_job(51); jn uuid := pg_temp.st_job(52); card jsonb; other jsonb; r jsonb; t uuid;
BEGIN
 PERFORM pg_temp.st_lanes(true);
 PERFORM pg_temp.st_flag(false);
 DELETE FROM public.context_job_story_requests;
 DELETE FROM public.context_job_story_texts;
 PERFORM pg_temp.st_assert(public.context_job_story_text_get(pg_temp.st_jid(9001)) IS NULL AND public.context_job_story_text_get(NULL) IS NULL,
  'an unknown job has a story read');
 r := public.context_job_story_text_get(jn);
 PERFORM pg_temp.st_assert(r = jsonb_build_object('version', 'job-story-text-v1', 'job_id', jn, 'status', 'none', 'card_hash', NULL::text, 'text', NULL::jsonb,
  'writer', jsonb_build_object('on', false, 'open_request', NULL::jsonb, 'last_failure', NULL::jsonb)), 'no story: ' || r::text);
 card := public.context_job_story(j, now());
 INSERT INTO public.context_job_story_texts (job_id, written_at, checked_at, card_hash, model, sections, checks)
 VALUES (j, now() - interval '1 hour', now() - interval '1 hour', public.context_job_story_card_hash(card), 'gpt-6-luna', pg_temp.st_sections(),
         '{"writer":"luna-story:v1","inputs":{"timeline":4,"evidence_rows":7,"notes":3,"notes_open":1}}')
 RETURNING id INTO t;
 r := public.context_job_story_text_get(j);
 PERFORM pg_temp.st_assert(r ->> 'status' = 'fresh' AND r ->> 'card_hash' = public.context_job_story_card_hash(card)
  AND (r #>> '{text,id}')::uuid = t AND r #> '{text,sections}' = pg_temp.st_sections() AND r #>> '{text,model}' = 'gpt-6-luna'
  AND r #> '{text,inputs}' = '{"timeline":4,"evidence_rows":7,"notes":3,"notes_open":1}'::jsonb, 'fresh, building the card: ' || r::text);
 PERFORM pg_temp.st_assert(public.context_job_story_text_get(j, card) ->> 'status' = 'fresh', 'fresh, from the caller''s card');
 PERFORM pg_temp.st_assert(public.context_job_story_text_get(j, (card::text)::jsonb) ->> 'status' = 'fresh', 'fresh after a text round trip');
 PERFORM pg_temp.st_assert(public.context_job_story_text_get(j, jsonb_set(card, '{job,status}', '"complete"')) ->> 'status' = 'stale', 'stale');
 PERFORM pg_temp.st_assert(public.context_job_story_text_get(j, NULL, false) ->> 'status' = 'unchecked'
  AND public.context_job_story_text_get(j, NULL, false) -> 'card_hash' = 'null'::jsonb, 'unchecked when not compared');
 other := public.context_job_story(jn, now());
 PERFORM pg_temp.st_assert(public.context_job_story_text_get(j, other) ->> 'status' = 'unchecked', 'another job''s card was compared');
 -- A changed job reads stale with the card built now.
 UPDATE public.jobs SET status = 'complete' WHERE id = j;
 PERFORM pg_temp.st_assert(public.context_job_story_text_get(j) ->> 'status' = 'stale', 'a changed job reads fresh');
 -- The writer's state: the switch, the open request, a failure newer than the story.
 PERFORM pg_temp.st_flag(true);
 INSERT INTO public.context_job_story_requests (job_id, requested_by, reason, requested_at, done_at, outcome, error)
 VALUES (j, 'luna-story-writer', 'job_changed', now() - interval '30 minutes', now() - interval '20 minutes', 'failed', 'fact_check_failed'),
        (j, 'luna-story-writer', 'job_changed', now() - interval '3 hours', now() - interval '2 hours', 'failed', 'timeout');
 PERFORM pg_temp.st_request('5e100000-0000-4000-8000-000000000051', j, 'asked', '2 minutes');
 r := public.context_job_story_text_get(j) -> 'writer';
 PERFORM pg_temp.st_assert((r ->> 'on')::boolean AND (r #>> '{open_request,id}')::uuid = '5e100000-0000-4000-8000-000000000051'
  AND r #>> '{open_request,reason}' = 'asked' AND (r #>> '{open_request,attempts}')::integer = 0
  AND r #>> '{last_failure,error}' = 'fact_check_failed', 'the writer: ' || r::text);
END $c$;
ROLLBACK;

-- 12. The writer's input.
BEGIN;
SET LOCAL session_replication_role = replica;
DO $c$
DECLARE j uuid := pg_temp.st_job(61); r jsonb; t uuid;
BEGIN
 PERFORM pg_temp.st_assert(public.context_job_story_writer_input(pg_temp.st_jid(9001)) IS NULL, 'an unknown job has a writer input');
 INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, payload, metadata, occurred_at, recorded_at, event_at)
 VALUES ('5e600000-0000-4000-8000-000000000061', j, 'call.transcript_completed', 'ghl-call-transcript', 'call', 'inbound',
         '{"transcript":"made-up call words","ghl_call_id":"c61"}', '{}', '2026-10-05 01:00Z', '2026-10-05 01:00Z', '2026-10-05 01:00Z'),
        ('5e600000-0000-4000-8000-000000000062', j, 'client.reply', 'ghl', 'sms', 'inbound', '{"body":"See you then"}', '{}',
         '2026-10-05 02:00Z', '2026-10-05 02:00Z', '2026-10-05 02:00Z');
 r := public.context_job_story_writer_input(j);
 PERFORM pg_temp.st_assert(r ->> 'version' = 'story-writer-input-v1' AND (r ->> 'job_id')::uuid = j AND r ->> 'job_status' = 'scheduled'
  AND r #>> '{card,version}' = 'job-story-v1' AND r ->> 'card_hash' = public.context_job_story_card_hash(r -> 'card')
  AND r -> 'current' = 'null'::jsonb AND jsonb_typeof(r -> 'notes') = 'object' AND r #>> '{notes,status}' IS NOT NULL
  AND r -> 'transcript_row_ids' = '["5e600000-0000-4000-8000-000000000061"]'::jsonb AND (r ->> 'as_of')::timestamptz = now(),
  'the writer input: ' || left(r::text, 400));
 INSERT INTO public.context_job_story_texts (job_id, checked_at, card_hash, model, sections)
 VALUES (j, now(), r ->> 'card_hash', 'gpt-6-luna', pg_temp.st_sections()) RETURNING id INTO t;
 r := public.context_job_story_writer_input(j);
 PERFORM pg_temp.st_assert((r #>> '{current,text_id}')::uuid = t AND r #>> '{current,card_hash}' = r ->> 'card_hash', 'the current story in the input');
END $c$;
ROLLBACK;

-- 13. The admission's story branch, and the budget read agreeing with it.
BEGIN;
DO $c$
DECLARE r jsonb; b jsonb;
BEGIN
 PERFORM pg_temp.st_lanes(true);
 PERFORM pg_temp.st_policy('{"morning_until":"00:00"}');   -- never morning
 UPDATE public.context_ledger_settings SET live_reserve_calls = 100, live_reserve_calls_morning = 100 WHERE id;
 PERFORM pg_temp.st_calls(0);
 -- A story call never takes a run.
 BEGIN
  PERFORM public.reserve_context_model_call('story', gen_random_uuid(), gen_random_uuid());
  RAISE EXCEPTION 'story text contract: a story call with a run was admitted';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'Invalid model call identity' THEN RAISE; END IF;
 END;
 -- The switch.
 PERFORM pg_temp.st_flag(false);
 r := public.reserve_context_model_call('story', NULL, NULL);
 b := public.context_job_story_budget();
 PERFORM pg_temp.st_assert(r = '{"outcome":"story_off"}' AND pg_temp.st_used() = 0, 'a story call with the switch off: ' || r::text);
 PERFORM pg_temp.st_assert(b ->> 'reason' = 'story_off' AND (b ->> 'calls_left')::integer = 0 AND NOT (b ->> 'on')::boolean, 'budget off: ' || b::text);
 PERFORM pg_temp.st_flag(true);
 -- The extraction lane.
 PERFORM pg_temp.st_lanes(false);
 PERFORM pg_temp.st_assert(public.reserve_context_model_call('story', NULL, NULL) = '{"outcome":"paused"}', 'a story call with the lane off');
 PERFORM pg_temp.st_assert(public.context_job_story_budget() ->> 'reason' = 'lane_off', 'budget with the lane off');
 PERFORM pg_temp.st_lanes(true);
 -- Admitted, with no run, counted in the day.
 b := public.context_job_story_budget();
 PERFORM pg_temp.st_assert((b ->> 'calls_left')::integer = 80 AND b -> 'reason' = 'null'::jsonb AND (b ->> 'calls_per_day')::integer = 80, 'budget: ' || b::text);
 r := public.reserve_context_model_call('story', NULL, NULL);
 PERFORM pg_temp.st_assert(r ->> 'outcome' = 'reserved' AND (r ->> 'ordinal')::integer = 1
  AND (SELECT phase = 'story' AND run_id IS NULL AND lease_token IS NULL FROM public.context_model_call_reservations
       WHERE id = (r ->> 'reservation_id')::uuid), 'a story call: ' || r::text);
 PERFORM pg_temp.st_assert((public.context_job_story_budget() ->> 'calls_left')::integer = 79
  AND (public.context_job_story_budget() ->> 'story_calls_today')::integer = 1, 'the budget counts the call');
 -- The story's own ceiling; every other phase goes on.
 PERFORM pg_temp.st_calls(80, 80);
 r := public.reserve_context_model_call('story', NULL, NULL);
 PERFORM pg_temp.st_assert(r = jsonb_build_object('outcome', 'story_budget', 'reason', 'story_calls_per_day', 'run_date', pg_temp.st_today(), 'limit', 80)
  AND pg_temp.st_used() = 80, 'past the story ceiling: ' || r::text);
 b := public.context_job_story_budget();
 PERFORM pg_temp.st_assert((b ->> 'calls_left')::integer = 0 AND b ->> 'reason' = 'story_calls_per_day'
  AND (b ->> 'resets_at')::timestamptz = ((pg_temp.st_today() + 1)::timestamp AT TIME ZONE 'Australia/Perth'), 'budget past the ceiling: ' || b::text);
 PERFORM pg_temp.st_assert(public.reserve_context_model_call('bucket', NULL, NULL) ->> 'outcome' = 'reserved', 'another phase stopped with the story');
 -- The ledger's live reserve line; fact reads go on past it.
 PERFORM pg_temp.st_calls(900);
 r := public.reserve_context_model_call('story', NULL, NULL);
 PERFORM pg_temp.st_assert(r ->> 'outcome' = 'story_budget' AND r ->> 'reason' = 'live_reserve' AND (r ->> 'ceiling')::integer = 900
  AND pg_temp.st_used() = 900, 'inside the live reserve: ' || r::text);
 PERFORM pg_temp.st_assert(public.context_job_story_budget() ->> 'reason' = 'live_reserve', 'budget inside the live reserve');
 PERFORM pg_temp.st_assert(public.reserve_context_model_call('bucket', NULL, NULL) ->> 'outcome' = 'reserved', 'a fact read stopped at the reserve');
 PERFORM pg_temp.st_calls(899);
 PERFORM pg_temp.st_assert(public.reserve_context_model_call('story', NULL, NULL) ->> 'outcome' = 'reserved', 'call 900 is the story''s last');
 -- The morning line.
 PERFORM pg_temp.st_policy('{"morning_until":"23:59:59.999"}');
 PERFORM pg_temp.st_calls(650);
 r := public.reserve_context_model_call('story', NULL, NULL);
 PERFORM pg_temp.st_assert(r ->> 'outcome' = 'story_budget' AND r ->> 'reason' = 'live_reserve_morning' AND (r ->> 'ceiling')::integer = 650,
  'inside the morning reserve: ' || r::text);
 b := public.context_job_story_budget();
 PERFORM pg_temp.st_assert(b ->> 'reason' = 'live_reserve_morning'
  AND (b ->> 'resets_at')::timestamptz = (pg_temp.st_today() + '23:59:59.999'::time) AT TIME ZONE 'Australia/Perth', 'budget in the morning: ' || b::text);
 PERFORM pg_temp.st_calls(649);
 PERFORM pg_temp.st_assert(public.reserve_context_model_call('story', NULL, NULL) ->> 'outcome' = 'reserved', 'call 650 in the morning');
 -- The day's cap answers first.
 PERFORM pg_temp.st_policy('{"morning_until":"00:00"}');
 PERFORM pg_temp.st_calls(1000);
 PERFORM pg_temp.st_assert(public.reserve_context_model_call('story', NULL, NULL) = '{"outcome":"cap"}'
  AND public.context_job_story_budget() ->> 'reason' = 'cap', 'the cap');
 -- No ledger settings row leaves the story nothing.
 PERFORM pg_temp.st_calls(0);
 DELETE FROM public.context_ledger_settings;
 r := public.reserve_context_model_call('story', NULL, NULL);
 PERFORM pg_temp.st_assert(r ->> 'outcome' = 'story_budget' AND r ->> 'reason' = 'live_reserve' AND pg_temp.st_used() = 0,
  'a story call with no ledger settings: ' || r::text);
 PERFORM pg_temp.st_assert((public.context_job_story_budget() ->> 'calls_left')::integer = 0, 'budget with no ledger settings');
 PERFORM pg_temp.st_assert(public.reserve_context_model_call('attribution', NULL, NULL) ->> 'outcome' = 'reserved', 'attribution with no ledger settings');
END $c$;
ROLLBACK;

-- 14. Access: the service role calls the functions; a signed-in user calls none and reads no table.
BEGIN;
SET LOCAL ROLE service_role;
DO $c$
BEGIN
 IF public.context_job_story_text_get('5e000000-0000-4000-8000-000000009001'::uuid) IS NOT NULL
  OR public.context_job_story_claim(1) ->> 'outcome' IS NULL
  OR public.context_job_story_enqueue_changed(1) ->> 'outcome' IS NULL
  OR NOT (public.context_job_story_budget() ? 'calls_left') THEN
  RAISE EXCEPTION 'story text contract: the service role cannot call the writer''s functions';
 END IF;
END $c$;
ROLLBACK;
BEGIN;
SET LOCAL ROLE authenticated;
DO $c$
DECLARE f text;
BEGIN
 FOREACH f IN ARRAY ARRAY['SELECT public.context_job_story_text_get(NULL::uuid)', 'SELECT public.context_job_story_request(NULL::uuid, NULL, NULL)',
   'SELECT public.context_job_story_claim(1)', 'SELECT public.context_job_story_writer_input(NULL::uuid)',
   'SELECT public.context_job_story_card_hash(''{}''::jsonb)', 'SELECT count(*) FROM public.context_job_story_texts',
   'SELECT count(*) FROM public.context_job_story_requests'] LOOP
  BEGIN
   EXECUTE f;
   RAISE EXCEPTION 'story text contract: a signed-in user ran %', f;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
 END LOOP;
END $c$;
ROLLBACK;

-- 15. A second apply changes nothing.
BEGIN;
CREATE TEMP TABLE st_before ON COMMIT DROP AS
 SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS md5, obj_description(p.oid, 'pg_proc') AS cmt
 FROM pg_proc p WHERE obj_description(p.oid, 'pg_proc') LIKE 'Job story text (20261009100000)%'
    OR p.oid = 'public.reserve_context_model_call(text,uuid,uuid)'::regprocedure;
\ir ../../../migrations/20261009100000_context_job_story_text.sql
DO $c$
BEGIN
 PERFORM pg_temp.st_assert((SELECT count(*) FROM st_before) = 19, 'expected 18 story functions and the admission, got ' || (SELECT count(*) FROM st_before));
 PERFORM pg_temp.st_assert(NOT EXISTS (SELECT 1 FROM st_before b LEFT JOIN pg_proc p ON p.oid = b.sig::regprocedure
   WHERE md5(p.prosrc) IS DISTINCT FROM b.md5 OR obj_description(p.oid, 'pg_proc') IS DISTINCT FROM b.cmt), 'a second apply changed a body or a comment');
 PERFORM pg_temp.st_assert((SELECT count(*) FROM public.feature_flags WHERE flag_name = 'context_job_story_text_v1') = 1, 'a second apply duplicated the switch');
 PERFORM pg_temp.st_assert((SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.context_model_call_reservations'::regclass AND contype = 'c'
   AND pg_get_constraintdef(oid) LIKE '%phase = ANY%') = 1, 'a second apply doubled the phase list');
END $c$;
ROLLBACK;
