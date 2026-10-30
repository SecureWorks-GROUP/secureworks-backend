-- Contract for 20261029170200_context_story_bill_outcomes: the job story card's
-- bill_outcomes block. Synthetic jobs and bills (the CFO case's h7_fixtures.sql),
-- no customer data; every fixture write is rolled back.
--  1. Shape: the block function with this migration's comment, service role
--     only; the four replaced bodies are this migration's, each comment led by
--     the money book's slice name.
--  2. The block per bill: where_counted, reason, bill_state and mirror_bill
--     exactly as context_job_bill_outcomes says (read, never re-derived);
--     unknown reads "unknown: <reason>", held "held: <reason>"; C order.
--  3. No amount anywhere: no number, no money-named key.
--  4. The card: the writer's input carries the block for a job with placed
--     bills; a job with none has no key and hashes exactly as before;
--     context_job_story_card_hash never moves; the freshness hash folds the
--     block's digest in; a payment never moves the digest, a placement does.
--  5. Freshness: the staff read and "recent" agree with the writer's input.
--  6. Refused reads: an amount, another contract version, another shape and a
--     failing read each give status refused and "unknown: <code>", never bills.
--  7. Values the card does not know read unknown.
--  8. A second apply changes nothing; the rollback restores the money book's
--     bodies; the migration applies again.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.sb_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'story bill outcomes contract: %', p_msg; END IF; END $$;

-- 1. Shape.
DO $$
DECLARE x record; live text; f regprocedure := to_regprocedure('public.context_job_story_bill_outcomes(uuid)');
BEGIN
 PERFORM pg_temp.sb_assert(f IS NOT NULL, 'context_job_story_bill_outcomes missing');
 PERFORM pg_temp.sb_assert(obj_description(f, 'pg_proc') LIKE 'Story bill outcomes (20261029170200)%', 'block comment');
 PERFORM pg_temp.sb_assert((SELECT p.provolatile = 's' AND NOT p.prosecdef FROM pg_proc p WHERE p.oid = f), 'block is STABLE and not SECURITY DEFINER');
 FOR x IN SELECT * FROM (VALUES
  ('public.context_job_story_full_hash(jsonb)', 'a444e315f8aedc2af5de37f80c3e95ce', 'Story money book (20261028190000)%'),
  ('public.context_job_story_text_get(uuid,jsonb,boolean)', 'ac51513f6164fa256011d67c1bd82b10', 'Story money book (20261028190000), job story text (20261009100000)%'),
  ('public.context_job_story_request(uuid,text,text)', 'd3e09e9e36875955de47438509f40a3c', 'Story money book (20261028190000), job story text (20261009100000)%'),
  ('public.context_job_story_writer_input(uuid)', '88d5ccf04d40e8cd8e6c7cee87e84f0b', 'Story money book (20261028190000), job story text (20261009100000)%'),
  ('public.context_job_story_bill_outcomes(uuid)', NULL, 'Story bill outcomes (20261029170200)%')
 ) v(sig, want, cmt) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  PERFORM pg_temp.sb_assert(x.want IS NULL OR live = x.want, x.sig || ' md5 ' || coalesce(live, '<missing>'));
  PERFORM pg_temp.sb_assert(obj_description(to_regprocedure(x.sig), 'pg_proc') LIKE x.cmt
   AND obj_description(to_regprocedure(x.sig), 'pg_proc') LIKE '%Story bill outcomes (20261029170200)%', x.sig || ' comment');
  PERFORM pg_temp.sb_assert(has_function_privilege('service_role', to_regprocedure(x.sig), 'EXECUTE'), x.sig || ' not the service role''s');
  PERFORM pg_temp.sb_assert(NOT has_function_privilege('anon', to_regprocedure(x.sig), 'EXECUTE')
   AND NOT has_function_privilege('authenticated', to_regprocedure(x.sig), 'EXECUTE'), x.sig || ' open to anon or authenticated');
 END LOOP;
 PERFORM pg_temp.sb_assert(public.context_job_story_bill_outcomes(NULL) IS NULL
  AND public.context_job_story_bill_outcomes('c7000000-0000-4000-8000-0000000000ff') IS NULL, 'an unknown job has no block');
END $$;

-- Fixtures: the CFO case's jobs and bills, a bill on J2 whose number differs by case (C order), and
-- H7-J5, a job with no bill at all.
BEGIN;
\ir ../20261029170000_cfo_bill_cost_outcomes/h7_fixtures.sql
INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, line_items, raw_json, job_id)
VALUES ('00000000-0000-0000-0000-000000000001', 'H7-LOWER', 'b-h7-a', 'ACCPAY', 'AUTHORISED', 'H7 Supplier', 80, 88, '2026-08-27',
        '[{"Description": "Supply", "AccountCode": "310", "LineAmount": 80, "TaxAmount": 8}]', '{"LineAmountTypes": "Exclusive"}',
        'c7000000-0000-4000-8000-000000000002');
INSERT INTO public.jobs (id, org_id, status, type, job_number, legacy, metadata, pricing_json, expected_costs, created_at) VALUES
  ('c7000000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000001', 'in_progress', 'fencing', 'H7-J5', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z');
-- every read below runs as the service role, as the writer and ops-api do (on a stack built only from migrations)
SET LOCAL ROLE service_role;

-- 2 and 3. The block per bill, against the H7 read; no amount.
DO $$
DECLARE
 j1 constant uuid := 'c7000000-0000-4000-8000-000000000001';
 j2 constant uuid := 'c7000000-0000-4000-8000-000000000002';
 j3 constant uuid := 'c7000000-0000-4000-8000-000000000005';
 j uuid; blk jsonb; src jsonb; b jsonb; s jsonb; c record; got text[]; want text[];
BEGIN
 FOREACH j IN ARRAY ARRAY[j1, j2, j3] LOOP
  blk := public.context_job_story_bill_outcomes(j);
  src := public.context_job_bill_outcomes(j);
  PERFORM pg_temp.sb_assert(blk ->> 'version' = 'story-bill-outcomes-v1' AND blk ->> 'status' = 'ok' AND blk -> 'refused' = 'null'::jsonb
   AND blk ->> 'source' = 'context_job_bill_outcomes' AND blk ->> 'contract_version' = 'cfo-bill-cost-outcome-v1'
   AND (blk ->> 'job_id')::uuid = j AND blk ->> 'digest' ~ '^[0-9a-f]{32}$', 'J block header: ' || coalesce((blk - 'bills')::text, 'null'));
  PERFORM pg_temp.sb_assert(jsonb_array_length(blk -> 'bills') = jsonb_array_length(src -> 'bills'), 'every bill the H7 read lists, and only those');
  -- read, never re-derived: each field is the H7 read's
  FOR b IN SELECT value FROM jsonb_array_elements(blk -> 'bills') LOOP
   SELECT e.value INTO s FROM jsonb_array_elements(src -> 'bills') e WHERE e.value ->> 'xero_invoice_id' = b ->> 'xero_invoice_id';
   PERFORM pg_temp.sb_assert(s IS NOT NULL, b ->> 'xero_invoice_id' || ' is not the H7 read''s');
   PERFORM pg_temp.sb_assert(b ->> 'where_counted' = s ->> 'where_counted' AND b ->> 'bill_state' = s ->> 'bill_state'
    AND b -> 'mirror_bill' = s -> 'mirror_bill' AND b ->> 'held_reason' IS NOT DISTINCT FROM s ->> 'held_reason'
    AND b ->> 'invoice_number' IS NOT DISTINCT FROM s ->> 'invoice_number' AND b ->> 'supplier' IS NOT DISTINCT FROM s ->> 'supplier'
    AND b ->> 'bill_status' IS NOT DISTINCT FROM s ->> 'bill_status', b ->> 'xero_invoice_id' || ' differs from the H7 read: ' || b::text);
   PERFORM pg_temp.sb_assert(b ->> 'where_counted' IN ('held', 'unknown') OR b ->> 'reason' IS NOT DISTINCT FROM s #>> '{here,reason}',
    b ->> 'xero_invoice_id' || ' reason is not the H7 read''s here.reason');
   PERFORM pg_temp.sb_assert(b -> 'other_jobs' = (SELECT coalesce(jsonb_agg(jsonb_build_object('job_number', o.value ->> 'job_number', 'counts', o.value ->> 'counts')
     ORDER BY o.value ->> 'job_number' COLLATE "C"), '[]'::jsonb) FROM jsonb_array_elements(s -> 'other_jobs') o), b ->> 'xero_invoice_id' || ' other jobs');
   PERFORM pg_temp.sb_assert((b ->> 'where_counted' NOT IN ('held', 'unknown') AND b ->> 'outcome' = b ->> 'where_counted')
     OR (b ->> 'where_counted' IN ('held', 'unknown') AND b ->> 'reason' IS NOT NULL
         AND b ->> 'outcome' = (b ->> 'where_counted') || ': ' || (b ->> 'reason')), b ->> 'xero_invoice_id' || ' outcome words: ' || b::text);
  END LOOP;
  -- no amount: no number, no money-named key, in the block or the card that carries it
  PERFORM pg_temp.sb_assert(NOT jsonb_path_exists(blk, 'strict $.** ? (@.type() == "number")'), 'a number in the block: ' || blk::text);
  PERFORM pg_temp.sb_assert(NOT jsonb_path_exists(blk, 'lax $.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "(_ex|_inc|amount|total|price|cost|owing|paid)" flag "i")'),
   'a money-named key in the block: ' || blk::text);
  PERFORM pg_temp.sb_assert(NOT jsonb_path_exists(public.context_job_story_writer_input(j) #> '{card,bill_outcomes}', 'strict $.** ? (@.type() == "number")'),
   'a number in the writer''s bill_outcomes');
  -- C order: invoice number, then bill id
  SELECT array_agg(e.value ->> 'xero_invoice_id' ORDER BY ord) INTO got FROM jsonb_array_elements(blk -> 'bills') WITH ORDINALITY e(value, ord);
  SELECT array_agg(e.value ->> 'xero_invoice_id' ORDER BY coalesce(e.value ->> 'invoice_number', '') COLLATE "C", e.value ->> 'xero_invoice_id' COLLATE "C")
    INTO want FROM jsonb_array_elements(blk -> 'bills') e;
  PERFORM pg_temp.sb_assert(got = want, 'bill order is not C: ' || array_to_string(got, ','));
 END LOOP;
 -- the case-differing number sorts after the upper-case ones in C order
 SELECT array_agg(e.value ->> 'invoice_number' ORDER BY ord) INTO got
   FROM jsonb_array_elements(public.context_job_story_bill_outcomes(j2) -> 'bills') WITH ORDINALITY e(value, ord);
 PERFORM pg_temp.sb_assert(got[cardinality(got)] = 'b-h7-a', 'the lower-case bill number is not last on J2: ' || array_to_string(got, ','));

 -- named bills, seen from J1 and J3
 blk := public.context_job_story_bill_outcomes(j1);
 FOR c IN SELECT * FROM (VALUES
  ('H7-PLAIN', 'here', 'engine_reads_xero_lines', 'counted_in_full', 'here'),
  ('H7-MOVE', 'elsewhere', 'xero_link_read_through_rows', 'counted_in_full', 'elsewhere'),
  ('H7-SPLIT', 'here_and_elsewhere', 'engine_reads_allocation_rows', 'counted_in_full', 'here_and_elsewhere'),
  ('H7-UNBAL', 'here', 'engine_reads_allocation_rows', 'counted_in_part', 'here'),
  ('H7-VOID', 'no_job', 'bill_voided', 'voided', 'no_job'),
  ('H7-INST', 'no_job', 'installer_unconfirmed', 'not_counted', 'no_job'),
  ('H7-OH', 'no_job', 'xero_link_read_through_overhead', 'overhead', 'no_job'),
  -- F1 / JP-21: a not-job-related mark on a bill the engine counts: held, never settled
  ('H7-NJR', 'held', 'not_job_related_mark_on_counted_bill', 'held', 'held: not_job_related_mark_on_counted_bill'),
  -- no stored copy of the bill: unknown with its reason, never "here" and never 0
  ('H7-MISS', 'unknown', 'bill_state_unknown', 'unknown', 'unknown: bill_state_unknown')
 ) t(bill, wc, reason, state, outcome) LOOP
  SELECT e INTO b FROM jsonb_array_elements(blk -> 'bills') e WHERE e ->> 'xero_invoice_id' = c.bill;
  PERFORM pg_temp.sb_assert(b ->> 'where_counted' = c.wc AND b ->> 'reason' = c.reason AND b ->> 'bill_state' = c.state AND b ->> 'outcome' = c.outcome
   AND b -> 'mirror_bill' = 'false'::jsonb, 'J1 ' || c.bill || ': ' || coalesce(b::text, 'not listed'));
 END LOOP;
 SELECT e INTO b FROM jsonb_array_elements(blk -> 'bills') e WHERE e ->> 'xero_invoice_id' = 'H7-MOVE';
 PERFORM pg_temp.sb_assert(b -> 'other_jobs' = '[{"job_number": "H7-J2", "counts": "counted"}]'::jsonb, 'H7-MOVE counts on H7-J2: ' || (b -> 'other_jobs')::text);
 -- a trade-app mirror a person placed: marked, counted through the trade lines
 SELECT e INTO b FROM jsonb_array_elements(public.context_job_story_bill_outcomes(j3) -> 'bills') e WHERE e ->> 'xero_invoice_id' = 'H7-MIRP';
 PERFORM pg_temp.sb_assert(b ->> 'where_counted' = 'trade_app' AND b -> 'mirror_bill' = 'true'::jsonb AND b ->> 'bill_state' = 'trade_mirror'
  AND b ->> 'reason' = 'mirror_bill_person_placed', 'J3 H7-MIRP: ' || coalesce(b::text, 'not listed'));
 PERFORM pg_temp.sb_assert((SELECT count(*) FROM jsonb_array_elements(blk -> 'bills') e WHERE e -> 'mirror_bill' <> 'false'::jsonb) = 0,
  'a bill on J1 is marked a mirror');
END $$;

-- 4. The card and its hashes (the fixture writes below as the owner).
RESET ROLE;
DO $$
DECLARE
 j1 constant uuid := 'c7000000-0000-4000-8000-000000000001';
 j5 constant uuid := 'c7000000-0000-4000-8000-000000000007';
 w jsonb; w5 jsonb; d1 text; d2 text; card jsonb;
BEGIN
 w := public.context_job_story_writer_input(j1);
 PERFORM pg_temp.sb_assert(w ->> 'version' = 'story-writer-input-v2' AND w -> 'card' -> 'bill_outcomes' = public.context_job_story_bill_outcomes(j1)
  AND w #>> '{card,book,version}' = 'story-book-v1', 'the writer''s card carries the block beside the book');
 PERFORM pg_temp.sb_assert(w ->> 'card_hash' = public.context_job_story_full_hash(w -> 'card'), 'writer input hash is the full hash');
 PERFORM pg_temp.sb_assert(w ->> 'card_hash' = md5('story-digest-v1+story-book-v1+story-bills-v1|' || public.context_job_story_card_hash(w -> 'card')
  || '|' || (w #>> '{card,book,digest}') || '|' || (w #>> '{card,bill_outcomes,digest}')), 'the full hash folds in the block''s digest');
 PERFORM pg_temp.sb_assert(public.context_job_story_full_hash(w -> 'card') <> public.context_job_story_full_hash((w -> 'card') - 'bill_outcomes'),
  'the block does not move the freshness hash');
 PERFORM pg_temp.sb_assert(public.context_job_story_card_hash(w -> 'card') = public.context_job_story_card_hash((w -> 'card') - 'bill_outcomes'),
  'the block moved context_job_story_card_hash (story-digest-v1)');
 -- a job with no placed bill: no key, and the hash exactly as the money book made it
 w5 := public.context_job_story_writer_input(j5);
 PERFORM pg_temp.sb_assert(w5 -> 'card' IS NOT NULL AND NOT (w5 -> 'card') ? 'bill_outcomes' AND public.context_job_story_bill_outcomes(j5) IS NULL,
  'a job with no bill carries a block');
 PERFORM pg_temp.sb_assert(w5 ->> 'card_hash' = md5('story-digest-v1+story-book-v1|' || public.context_job_story_card_hash(w5 -> 'card') || '|'
  || coalesce(w5 #>> '{card,book,digest}', 'none')), 'a job with no bill does not hash as the money book did');
 -- the digest: a payment never moves it; where a bill counts does
 d1 := public.context_job_story_bill_outcomes(j1) ->> 'digest';
 UPDATE public.xero_invoices SET status = 'PAID' WHERE xero_invoice_id = 'H7-PLAIN';
 d2 := public.context_job_story_bill_outcomes(j1) ->> 'digest';
 PERFORM pg_temp.sb_assert(d1 = d2, 'a payment moved the block digest');
 PERFORM pg_temp.sb_assert((SELECT e ->> 'bill_status' FROM jsonb_array_elements(public.context_job_story_bill_outcomes(j1) -> 'bills') e
   WHERE e ->> 'xero_invoice_id' = 'H7-PLAIN') = 'PAID', 'the block does not show Xero''s status');
 UPDATE public.xero_invoices SET status = 'VOIDED' WHERE xero_invoice_id = 'H7-PLAIN';
 PERFORM pg_temp.sb_assert(public.context_job_story_bill_outcomes(j1) ->> 'digest' <> d1, 'a voided bill left the block digest');
 UPDATE public.xero_invoices SET status = 'AUTHORISED' WHERE xero_invoice_id = 'H7-PLAIN';
 PERFORM pg_temp.sb_assert(public.context_job_story_bill_outcomes(j1) ->> 'digest' = d1, 'the digest is not a function of the facts');
END $$;

-- 5. Freshness: the staff read and "recent" compare the same card as the writer.
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'context_job_story_text_v1';
-- a job with no story compares nothing, so the staff read never runs the bill read for it
-- (review, 29 Oct: every job page ran it twice); the block is made to fail, inside a savepoint only
SAVEPOINT sb_no_story;
CREATE OR REPLACE FUNCTION public.context_job_story_bill_outcomes(p_job_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $b$
BEGIN RAISE EXCEPTION 'sb: the bill read ran'; END $b$;
DO $$
DECLARE j1 constant uuid := 'c7000000-0000-4000-8000-000000000001'; g jsonb; ran boolean := false;
BEGIN
 PERFORM pg_temp.sb_assert(NOT EXISTS (SELECT 1 FROM public.context_job_story_texts x WHERE x.job_id = j1), 'H7-J1 already has a story');
 g := public.context_job_story_text_get(j1, public.context_job_story(j1, now()), true);
 PERFORM pg_temp.sb_assert(g ->> 'status' = 'none' AND g -> 'card_hash' = 'null'::jsonb AND g -> 'text' = 'null'::jsonb
  AND g -> 'money' IS NOT NULL, 'no story: ' || coalesce(g::text, 'null'));
 -- with a story the block is read, so the failing one is reached
 INSERT INTO public.context_job_story_texts (job_id, checked_at, job_status, card_hash, model, sections, checks, written_at)
 VALUES (j1, now(), 'complete', md5('sb-no-story'), 'gpt-test',
  '{"headline":"h","the_job":"j","how_we_got_here":"h","where_it_is_at":"w","watch_out":"Nothing stands out."}', '{}', now());
 BEGIN
  PERFORM public.context_job_story_text_get(j1, public.context_job_story(j1, now()), true);
 EXCEPTION WHEN OTHERS THEN
  ran := SQLERRM = 'sb: the bill read ran';
 END;
 PERFORM pg_temp.sb_assert(ran, 'with a story the bill read was not run');
END $$;
ROLLBACK TO SAVEPOINT sb_no_story;
DO $$
DECLARE j1 constant uuid := 'c7000000-0000-4000-8000-000000000001'; w jsonb := public.context_job_story_writer_input('c7000000-0000-4000-8000-000000000001');
BEGIN
 INSERT INTO public.context_job_story_texts (job_id, checked_at, job_status, card_hash, model, sections, checks, written_at)
 VALUES (j1, now(), 'complete', w ->> 'card_hash', 'gpt-test',
  '{"headline":"h","the_job":"j","how_we_got_here":"h","where_it_is_at":"w","watch_out":"Nothing stands out."}',
  jsonb_build_object('writer', 'luna-story:v4', 'money_sig', w #>> '{card,book,money_sig}'), now());
 PERFORM pg_temp.sb_assert(public.context_job_story_text_get(j1, NULL, true) ->> 'status' = 'fresh', 'a story written from the writer''s input is not fresh');
 -- the overview passes the card without its book or block: the same answer
 PERFORM pg_temp.sb_assert(public.context_job_story_text_get(j1, public.context_job_story(j1, now()), true) ->> 'status' = 'fresh', 'the overview''s card');
 PERFORM pg_temp.sb_assert(public.context_job_story_request(j1, 'user:sb-test', 'asked') ->> 'outcome' = 'recent', 'a fresh story just written is not recent');
 -- where a bill counts changes: the story is stale, and a request is queued
 UPDATE public.xero_invoices SET status = 'VOIDED' WHERE xero_invoice_id = 'H7-OH2';
 PERFORM pg_temp.sb_assert(public.context_job_story_text_get(j1, NULL, true) ->> 'status' = 'stale', 'a bill voided left the story fresh');
 PERFORM pg_temp.sb_assert(public.context_job_story_text_get(j1, public.context_job_story(j1, now()), true) ->> 'status' = 'stale', 'the overview''s card after a void');
 PERFORM pg_temp.sb_assert(public.context_job_story_request(j1, 'user:sb-test', 'asked') ->> 'outcome' = 'queued', 'a changed bill was still recent');
END $$;
ROLLBACK;

-- 6 and 7. Refused reads, and values the card does not know. The H7 read is replaced inside a
-- rolled-back transaction only.
BEGIN;
DO $do$
DECLARE r text; blk jsonb; j constant uuid := 'c7000000-0000-4000-8000-0000000000aa';
BEGIN
 FOR r IN SELECT unnest(ARRAY['amount_number', 'amount_key', 'contract_mismatch', 'versions_disagree', 'invalid_shape', 'read_failed']) LOOP
  EXECUTE format($f$CREATE OR REPLACE FUNCTION public.context_job_bill_outcomes(p_job uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $b$
   BEGIN
    IF %L = 'read_failed' THEN RAISE EXCEPTION 'a broken read'; END IF;
    RETURN jsonb_build_object('shape', CASE WHEN %L = 'invalid_shape' THEN 'other-shape' ELSE 'context-job-bill-outcomes-v1' END,
     'job_id', p_job, 'contract_version', CASE WHEN %L = 'contract_mismatch' THEN 'cfo-bill-cost-outcome-v2' ELSE 'cfo-bill-cost-outcome-v1' END,
     'contract_versions_agree', %L <> 'versions_disagree',
     'bills', jsonb_build_array(jsonb_build_object('xero_invoice_id', 'X1', 'where_counted', 'here', 'bill_state', 'counted_in_full', 'mirror_bill', false,
       'here', jsonb_build_object('counts', 'counted', 'reason', 'engine_reads_xero_lines'))
       || CASE WHEN %L = 'amount_number' THEN jsonb_build_object('rows', 3) WHEN %L = 'amount_key' THEN jsonb_build_object('bill_ex', 'x') ELSE '{}'::jsonb END));
   END $b$
  $f$, r, r, r, r, r, r);
  blk := public.context_job_story_bill_outcomes(j);
  PERFORM pg_temp.sb_assert(blk ->> 'status' = 'refused' AND blk -> 'bills' = '[]'::jsonb
   AND blk ->> 'refused' = CASE WHEN r LIKE 'amount_%' THEN 'amount_present' WHEN r = 'versions_disagree' THEN 'contract_mismatch' ELSE r END
   AND blk ->> 'outcome' = 'unknown: ' || (blk ->> 'refused') AND blk ->> 'digest' ~ '^[0-9a-f]{32}$', r || ' was not refused: ' || coalesce(blk::text, 'null'));
  PERFORM pg_temp.sb_assert(NOT jsonb_path_exists(blk, 'strict $.** ? (@.type() == "number")') AND NOT blk::text ~ 'bill_ex', r || ': the refusal passed an amount on');
 END LOOP;
 -- a value the card does not know reads unknown with its reason, never as counted
 CREATE OR REPLACE FUNCTION public.context_job_bill_outcomes(p_job uuid) RETURNS jsonb LANGUAGE sql STABLE AS $b$
  SELECT jsonb_build_object('shape', 'context-job-bill-outcomes-v1', 'job_id', p_job, 'contract_version', 'cfo-bill-cost-outcome-v1',
   'contract_versions_agree', true, 'bills', jsonb_build_array(
    jsonb_build_object('xero_invoice_id', 'U1', 'invoice_number', 'U-1', 'where_counted', 'somewhere', 'bill_state', 'counted_in_full',
     'here', jsonb_build_object('counts', 'counted', 'reason', 'engine_reads_xero_lines')),
    jsonb_build_object('xero_invoice_id', 'U2', 'invoice_number', 'U-2', 'where_counted', 'here', 'bill_state', 'a_new_state',
     'here', jsonb_build_object('counts', 'counted', 'reason', 'engine_reads_xero_lines')),
    jsonb_build_object('xero_invoice_id', 'U3', 'invoice_number', 'U-3', 'where_counted', 'here', 'bill_state', 'counted_in_full',
     'here', jsonb_build_object('counts', 'unknown', 'reason', 'amount_unreadable')),
    jsonb_build_object('xero_invoice_id', 'U4', 'invoice_number', 'U-4', 'where_counted', 'here', 'bill_state', 'counted_in_full',
     'here', jsonb_build_object('counts', 'not_counted', 'reason', 'bill_voided')),
    jsonb_build_object('xero_invoice_id', 'U5', 'invoice_number', 'U-5', 'where_counted', 'elsewhere', 'bill_state', 'counted_in_full', 'here', null)))
 $b$;
 blk := public.context_job_story_bill_outcomes(j);
 PERFORM pg_temp.sb_assert(blk ->> 'status' = 'ok' AND (SELECT array_agg(e ->> 'outcome' ORDER BY e ->> 'invoice_number' COLLATE "C") FROM jsonb_array_elements(blk -> 'bills') e)
   = ARRAY['unknown: where_counted_unknown', 'here', 'unknown: amount_unreadable', 'unknown: where_counted_unknown', 'unknown: not_placed_here'],
  'values the card does not know: ' || (blk -> 'bills')::text);
 PERFORM pg_temp.sb_assert((SELECT e ->> 'bill_state' FROM jsonb_array_elements(blk -> 'bills') e WHERE e ->> 'xero_invoice_id' = 'U2') = 'unknown'
  AND (SELECT e -> 'mirror_bill' FROM jsonb_array_elements(blk -> 'bills') e WHERE e ->> 'xero_invoice_id' = 'U2') = 'null'::jsonb,
  'an unknown bill state or an absent mirror flag was read as known');
END $do$;
ROLLBACK;

-- 8. A second apply changes nothing; the rollback restores the money book's bodies; it applies again.
BEGIN;
CREATE TEMP TABLE sb_before ON COMMIT DROP AS
 SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS md5, obj_description(p.oid, 'pg_proc') AS cmt, p.proacl::text AS acl
 FROM pg_proc p WHERE obj_description(p.oid, 'pg_proc') LIKE '%Story bill outcomes (20261029170200)%';
\ir ../../../migrations/20261029170200_context_story_bill_outcomes.sql
DO $$
BEGIN
 PERFORM pg_temp.sb_assert((SELECT count(*) FROM sb_before) = 5, 'expected the block and four replaced bodies, got ' || (SELECT count(*) FROM sb_before));
 PERFORM pg_temp.sb_assert(NOT EXISTS (SELECT 1 FROM sb_before b LEFT JOIN pg_proc p ON p.oid = b.sig::regprocedure
   WHERE md5(p.prosrc) IS DISTINCT FROM b.md5 OR obj_description(p.oid, 'pg_proc') IS DISTINCT FROM b.cmt OR p.proacl::text IS DISTINCT FROM b.acl),
  'a second apply changed a body, a comment or a grant');
END $$;
\ir ../../../rollbacks/20261029170200_context_story_bill_outcomes_down.sql
DO $$
BEGIN
 PERFORM pg_temp.sb_assert(to_regprocedure('public.context_job_story_bill_outcomes(uuid)') IS NULL, 'the rollback left the block');
 PERFORM pg_temp.sb_assert((SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.context_job_story_writer_input(uuid)')) = '13097e3cc7abebfdeabff122bee66e1a',
  'the rollback did not restore the money book''s writer input');
END $$;
\ir ../../../migrations/20261029170200_context_story_bill_outcomes.sql
DO $$
BEGIN
 PERFORM pg_temp.sb_assert(NOT EXISTS (SELECT 1 FROM sb_before b LEFT JOIN pg_proc p ON p.oid = b.sig::regprocedure
   WHERE md5(p.prosrc) IS DISTINCT FROM b.md5 OR obj_description(p.oid, 'pg_proc') IS DISTINCT FROM b.cmt OR p.proacl::text IS DISTINCT FROM b.acl),
  'applying after the rollback did not restore every body, comment and grant');
END $$;
ROLLBACK;
