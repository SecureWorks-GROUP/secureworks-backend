-- Contract for 20261028190000_context_story_money_book: the job story's Money block.
-- Every fixture write is rolled back; ids, names and numbers are made up.
--  1. Shape: the new functions with this migration's comment, service role only; the five
--     replaced bodies are this migration's; the policy's numbers.
--  2. The book on a job with a quote, an invoice owing, crew pay, a placed bill, a priced order,
--     a bill waiting in Bills to place and a sign-off: every line, word for word, and the same
--     figures as v_job_profit (Job Profit's screen reads the same row).
--  3. "Costs incomplete": named with counts and no dollar figure; gone once nothing is waiting
--     and Job Profit shows a margin; a quote-stage job is not started.
--  4. The money signature: moved by a bill placed or removed, not by a sync touching a row.
--  5. Freshness: a bill placed on the job makes a fresh story stale; the staff read carries the
--     Money block; the writer's input carries the book and the same hash.
--  6. The sweep: wakes on money (checks.money_sig), keeps waking a completed job for 30 days, not
--     after; rewrites a story written without the block only while few requests are open.
--  7. A second apply changes nothing; the rollback restores the 20261009100000 bodies.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.mb_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'story money book contract: %', p_msg; END IF; END $$;

-- 1. Shape.
DO $$
DECLARE f text; x record; live text;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_job_story_book_policy()', 'public.context_job_story_money_words(numeric)',
   'public.context_job_story_money_sig(uuid)', 'public.context_job_story_book(uuid,timestamptz)', 'public.context_job_story_full_hash(jsonb)'] LOOP
  PERFORM pg_temp.mb_assert(to_regprocedure(f) IS NOT NULL, f || ' missing');
  PERFORM pg_temp.mb_assert(obj_description(to_regprocedure(f), 'pg_proc') LIKE 'Story money book (20261028190000)%', f || ' comment');
  PERFORM pg_temp.mb_assert(has_function_privilege('service_role', to_regprocedure(f), 'EXECUTE'), f || ' not the service role''s');
  PERFORM pg_temp.mb_assert(NOT has_function_privilege('anon', to_regprocedure(f), 'EXECUTE')
   AND NOT has_function_privilege('authenticated', to_regprocedure(f), 'EXECUTE'), f || ' open to anon or authenticated');
 END LOOP;
 FOR x IN SELECT * FROM (VALUES
  ('public.context_job_story_text_policy()', '27ac61c4fee7d15d3b71356271295eab'),
  ('public.context_job_story_request(uuid,text,text)', '7a75f855aafb50a8821a106ff64ba173'),
  ('public.context_job_story_enqueue_changed(integer)', '6fdbb9442d7184241971f3a96da378bc'),
  ('public.context_job_story_writer_input(uuid)', '13097e3cc7abebfdeabff122bee66e1a'),
  ('public.context_job_story_text_get(uuid,jsonb,boolean)', '3cea9dd6df2d2f00660ccd8438637385')
 ) v(sig, want) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  PERFORM pg_temp.mb_assert(live = x.want, x.sig || ' md5 ' || coalesce(live, '<missing>'));
  PERFORM pg_temp.mb_assert(obj_description(to_regprocedure(x.sig), 'pg_proc') LIKE 'Story money book (20261028190000), job story text (20261009100000)%',
   x.sig || ' comment');
  PERFORM pg_temp.mb_assert(NOT has_function_privilege('anon', to_regprocedure(x.sig), 'EXECUTE'), x.sig || ' open to anon');
 END LOOP;
 PERFORM pg_temp.mb_assert((public.context_job_story_text_policy() ->> 'calls_per_day')::integer = 240, 'story calls a day');
 PERFORM pg_temp.mb_assert(public.context_job_story_text_policy() - 'calls_per_day' = '{"flag":"context_job_story_text_v1","lease_minutes":15,"min_rewrite_minutes":10,'
  '"quiet_minutes":15,"enqueue_per_call":5,"max_attempts":3,"retry_minutes":[30,120],"digest":"story-digest-v1","writer":"luna-story-writer"}'::jsonb,
  'the policy''s other numbers moved');
 PERFORM pg_temp.mb_assert(public.context_job_story_book_policy() = '{"version":"story-book-v1","after_done_days":30,"backfill_open_max":10,'
  '"owing_max":6,"crew_max":6,"payers_max":4}'::jsonb, 'book policy');
 PERFORM pg_temp.mb_assert(public.context_job_story_money_words(1234567.891) = '$1,234,567.89' AND public.context_job_story_money_words(-0.5) = '-$0.50',
  'dollar words');
 PERFORM pg_temp.mb_assert(public.context_job_story_book(NULL) IS NULL AND public.context_job_story_book('5eb00000-0000-4000-8000-0000000000ff') IS NULL,
  'an unknown job has no book');
END $$;

-- Fixtures: MB-1 a fencing job in progress with every kind of money; MB-2 a quote-stage job.
BEGIN;
INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, legacy, metadata, pricing_json, created_at) VALUES
 ('5eb00000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'in_progress', 'fencing', 'MB-1', 'Client One', false, '{}', '{}', '2026-07-01T00:00:00Z'),
 ('5eb00000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'MB-2', 'Client Two', false, '{}', '{}', '2026-07-01T00:00:00Z');
INSERT INTO public.users (id, org_id, name) VALUES ('5eb10000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'Crew Lee')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.job_documents (id, job_id, type, sent_at, created_at) VALUES
 ('5eb20000-0000-4000-8000-000000000001', '5eb00000-0000-4000-8000-000000000001', 'quote', '2026-07-05T00:00:00Z', '2026-07-05T00:00:00Z'),
 ('5eb20000-0000-4000-8000-000000000002', '5eb00000-0000-4000-8000-000000000002', 'quote', '2026-07-05T00:00:00Z', '2026-07-05T00:00:00Z');
INSERT INTO public.quote_revisions (job_id, job_document_id, version, sent_at, released_via, totals_snapshot_json, internal_cost_snapshot_json) VALUES
 ('5eb00000-0000-4000-8000-000000000001', '5eb20000-0000-4000-8000-000000000001', 1, '2026-07-05T00:00:00Z', 'send-quote/send',
  '{"total_inc_gst": 2200, "total_ex_gst": 2000}', '{"cost_estimates": {"labour_total": 600, "material_total": 400, "subcontract_commission_total": 0}}'),
 ('5eb00000-0000-4000-8000-000000000002', '5eb20000-0000-4000-8000-000000000002', 1, '2026-07-05T00:00:00Z', 'send-quote/send',
  '{"total_inc_gst": 1100, "total_ex_gst": 1000}', '{"cost_estimates": {"labour_total": 0, "material_total": 0, "subcontract_commission_total": 0}}');
INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, amount_paid, amount_due,
  invoice_date, due_date, job_id, raw_json, line_items, updated_at) VALUES
 ('00000000-0000-0000-0000-000000000001', 'MB-INV-1', 'INV-MB1', 'ACCREC', 'AUTHORISED', 'Client One', 2000, 2200, 1100, 1100, '2026-08-01', '2026-08-15',
  '5eb00000-0000-4000-8000-000000000001', '{}', '[{"LineAmount": 2000, "AccountCode": "200", "Description": "Fence"}]', '2026-08-01T00:00:00Z');
INSERT INTO public.trade_invoices (id, org_id, user_id, week_start, status, subtotal_ex, invoice_number, paid_at, gst_on, gst, total_inc, super_rate,
  super_amount, gross_earned, net_pay) VALUES
 ('5eb30000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', '5eb10000-0000-4000-8000-000000000001', '2026-08-03', 'paid', 600,
  'SW-INV-MB1', '2026-08-20', false, 0, 600, 0.12, 72, 600, 564);
INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, job_number, line_type, description, line_total_ex, total_hours, line_date) VALUES
 ('5eb30000-0000-4000-8000-000000000001', '5eb00000-0000-4000-8000-000000000001', NULL, 'labour', 'Fence labour', 600, 12, '2026-08-04');
INSERT INTO public.job_materials_facts (job_id, xero_invoice_id, invoice_number, contact_name, lane, kind, amount_ex_gst, confidence, fact_date, automation_source) VALUES
 ('5eb00000-0000-4000-8000-000000000001', 'MB-BILL-1', 'B-1', 'Fence Supplies', 'materials', 'actual', 350, 'high', '2026-08-02', 'manual_queue');
INSERT INTO public.purchase_orders (id, job_id, po_number, supplier_name, status, subtotal, total, created_at) VALUES
 ('5eb40000-0000-4000-8000-000000000001', '5eb00000-0000-4000-8000-000000000001', 'PO-MB1', 'Fence Supplies', 'sent', 80, 88, '2026-08-01T00:00:00Z');
INSERT INTO public.materials_reconciliation_queue (id, xero_invoice_id, invoice_number, sub_total, total, suggested_job_id, status, updated_at) VALUES
 ('5eb50000-0000-4000-8000-000000000001', 'MB-BILL-2', 'B-2', 120, 132, '5eb00000-0000-4000-8000-000000000001', 'open', '2026-08-03T00:00:00Z'),
 ('5eb50000-0000-4000-8000-000000000002', 'MB-BILL-3', 'B-3', 999, 1098.9, '5eb00000-0000-4000-8000-000000000001', 'not_job_related', '2026-08-03T00:00:00Z');
INSERT INTO public.job_client_signoffs (job_id, method, signed_name, happy, signature_media_id, waiver_reason, captured_by_actor, created_at)
SELECT '5eb00000-0000-4000-8000-000000000001', 'office_waiver', NULL, true, NULL, 'Customer away', 'user:test', '2026-08-20T03:00:00Z';

-- 2 and 3. The book, word for word, against Job Profit's row.
DO $$
DECLARE b jsonb := public.context_job_story_book('5eb00000-0000-4000-8000-000000000001', '2026-09-01T00:00:00Z'); p record; q jsonb;
BEGIN
 SELECT * INTO p FROM public.v_job_profit WHERE job_id = '5eb00000-0000-4000-8000-000000000001';
 PERFORM pg_temp.mb_assert(b ->> 'version' = 'story-book-v1' AND b ->> 'source' = 'job_profit' AND b ->> 'job_id' = '5eb00000-0000-4000-8000-000000000001',
  'book header ' || b::text);
 PERFORM pg_temp.mb_assert(b -> 'lines' = jsonb_build_array(
   'Quoted: ' || public.context_job_story_money_words(p.quoted_ex) || ' ex GST.',
   'Expected cost at the quote: $1,000.00 ex GST (labour $600.00, materials $400.00, commission $0.00).',
   'Invoiced: $2,000.00 ex GST on 1 invoice; collected ' || public.context_job_story_money_words(p.collected_ex) || ' ex GST.',
   'Owing now on INV-MB1: $1,100.00 inc GST, due Sat 15 Aug, overdue.',
   'Labour placed: ' || public.context_job_story_money_words(p.actual_labour_ex) || ' ex GST.',
   'Crew invoices placed (ex GST): Crew Lee $600.00.',
   'Materials placed: ' || public.context_job_story_money_words(p.actual_materials_ex) || ' ex GST.',
   'Total costs placed: ' || public.context_job_story_money_words(p.actual_cost_ex) || ' ex GST.',
   'Ordered, not billed yet: $80.00 ex GST on 1 priced purchase order.',
   'Bills that probably belong to this job, waiting to be placed: 1, $120.00 ex GST.',
   'Work order: drafted, not approved yet.',
   'Margin: ' || public.context_job_story_money_words(p.profit_ex) || ' ex GST profit, ' || p.margin_pct::text || '% of invoiced, on the costs placed so far.',
   'Costs incomplete: 1 bill that probably belongs to this job is waiting to be placed; 1 priced purchase order has no bill yet.'),
  'book lines ' || (b -> 'lines')::text);
 PERFORM pg_temp.mb_assert(p.quoted_ex = 2000 AND p.actual_cost_ex = 950 AND p.profit_ex = 1050 AND p.margin_ok, 'job profit fixture ' || row_to_json(p)::text);
 PERFORM pg_temp.mb_assert(b -> 'job_lines' = '["Client sign-off: waived by the office Thu 20 Aug, the customer said they were happy."]'::jsonb,
  'job lines ' || (b -> 'job_lines')::text);
 PERFORM pg_temp.mb_assert((b ->> 'complete')::boolean = false AND (b ->> 'started')::boolean AND b ->> 'reason' = 'costs_waiting', 'complete flags');
 PERFORM pg_temp.mb_assert(b ->> 'incomplete_line' !~ '\$', 'the incomplete line carries a dollar figure');
 PERFORM pg_temp.mb_assert(b ->> 'digest' ~ '^[0-9a-f]{32}$' AND b ->> 'money_sig' = public.context_job_story_money_sig('5eb00000-0000-4000-8000-000000000001'),
  'digest and signature');
 -- the quote-stage job: margin unknown with its reason, not started
 q := public.context_job_story_book('5eb00000-0000-4000-8000-000000000002', '2026-09-01T00:00:00Z');
 PERFORM pg_temp.mb_assert((q ->> 'started')::boolean = false AND q -> 'lines' @> '["Margin: Unknown, because no customer invoice is issued yet."]'::jsonb
  AND q -> 'lines' @> '["Invoiced: no customer invoice is issued yet."]'::jsonb, 'quote-stage book ' || q::text);
END $$;

-- 3. Nothing waiting: the order billed, the waiting bill placed elsewhere: complete, no incomplete line.
SAVEPOINT complete_case;
UPDATE public.purchase_orders SET status = 'billed' WHERE id = '5eb40000-0000-4000-8000-000000000001';
UPDATE public.materials_reconciliation_queue SET status = 'assigned' WHERE id = '5eb50000-0000-4000-8000-000000000001';
DO $$
DECLARE b jsonb := public.context_job_story_book('5eb00000-0000-4000-8000-000000000001', '2026-09-01T00:00:00Z');
BEGIN
 PERFORM pg_temp.mb_assert((b ->> 'complete')::boolean AND b -> 'incomplete_line' = 'null'::jsonb AND b ->> 'reason' = 'complete', 'complete book ' || b::text);
 PERFORM pg_temp.mb_assert(NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(b -> 'lines') l WHERE l LIKE '%incomplete%' OR l LIKE '%so far%'),
  'a complete book still says incomplete');
END $$;
ROLLBACK TO SAVEPOINT complete_case;

-- 4. The money signature.
DO $$
DECLARE j uuid := '5eb00000-0000-4000-8000-000000000001'; s0 text := public.context_job_story_money_sig('5eb00000-0000-4000-8000-000000000001'); s1 text;
BEGIN
 UPDATE public.xero_invoices SET updated_at = now(), synced_at = now() WHERE xero_invoice_id = 'MB-INV-1';
 PERFORM pg_temp.mb_assert(public.context_job_story_money_sig(j) = s0, 'a sync touching a row moved the signature');
 INSERT INTO public.job_materials_facts (job_id, xero_invoice_id, invoice_number, contact_name, lane, kind, amount_ex_gst, confidence, fact_date, automation_source)
 VALUES (j, 'MB-BILL-9', 'B-9', 'Concrete Co', 'materials', 'actual', 75, 'high', '2026-08-09', 'manual_queue');
 s1 := public.context_job_story_money_sig(j);
 PERFORM pg_temp.mb_assert(s1 <> s0, 'a bill placed did not move the signature');
 DELETE FROM public.job_materials_facts WHERE xero_invoice_id = 'MB-BILL-9';
 PERFORM pg_temp.mb_assert(public.context_job_story_money_sig(j) = s0, 'a bill removed did not move the signature back');
END $$;

-- 5. Freshness, the staff read and the writer's input.
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'context_job_story_text_v1';
DO $$
DECLARE j uuid := '5eb00000-0000-4000-8000-000000000001'; w jsonb := public.context_job_story_writer_input('5eb00000-0000-4000-8000-000000000001'); g jsonb;
BEGIN
 PERFORM pg_temp.mb_assert(w ->> 'version' = 'story-writer-input-v2' AND w #>> '{card,book,version}' = 'story-book-v1'
  AND w -> 'card' -> 'book' -> 'lines' = public.context_job_story_book(j) -> 'lines', 'writer input carries the book');
 PERFORM pg_temp.mb_assert(w ->> 'card_hash' = public.context_job_story_full_hash(w -> 'card')
  AND w ->> 'card_hash' <> public.context_job_story_card_hash(w -> 'card'), 'writer input hash is the full hash');
 INSERT INTO public.context_job_story_texts (job_id, checked_at, job_status, card_hash, model, sections, checks, written_at)
 VALUES (j, now() - interval '1 hour', 'in_progress', w ->> 'card_hash', 'gpt-test',
  '{"headline":"h","the_job":"j","how_we_got_here":"h","where_it_is_at":"w","watch_out":"Nothing stands out."}',
  jsonb_build_object('writer', 'luna-story:v4', 'money_sig', w #>> '{card,book,money_sig}'), now() - interval '1 hour');
 g := public.context_job_story_text_get(j, NULL, true);
 PERFORM pg_temp.mb_assert(g ->> 'status' = 'fresh', 'a story written from this input is fresh: ' || coalesce(g ->> 'status', 'null'));
 PERFORM pg_temp.mb_assert(g -> 'money' -> 'lines' = w -> 'card' -> 'book' -> 'lines' AND g #>> '{money,source}' = 'job_profit'
  AND (g #>> '{money,complete}')::boolean = false AND g #>> '{money,incomplete_line}' LIKE 'Costs incomplete: %', 'the staff read carries the Money block');
 -- the card the overview passes (no book) gives the same answer
 PERFORM pg_temp.mb_assert(public.context_job_story_text_get(j, public.context_job_story(j, now()), true) ->> 'status' = 'fresh', 'the overview''s card');
 -- a bill placed on the job: stale
 INSERT INTO public.job_materials_facts (job_id, xero_invoice_id, invoice_number, contact_name, lane, kind, amount_ex_gst, confidence, fact_date, automation_source)
 VALUES (j, 'MB-BILL-8', 'B-8', 'Concrete Co', 'materials', 'actual', 75, 'high', '2026-08-09', 'manual_queue');
 PERFORM pg_temp.mb_assert(public.context_job_story_text_get(j, NULL, true) ->> 'status' = 'stale', 'a bill placed left the story fresh');
 PERFORM pg_temp.mb_assert(public.context_job_story_text_get(j, NULL, false) -> 'money' -> 'lines' IS NOT NULL, 'unchecked read still shows money');
END $$;

-- 6. The sweep.
DO $$
DECLARE j uuid := '5eb00000-0000-4000-8000-000000000001'; r jsonb;
BEGIN
 -- the bill placed above moved the money signature: queued
 DELETE FROM public.context_job_story_requests;
 r := public.context_job_story_enqueue_changed(5);
 PERFORM pg_temp.mb_assert(r -> 'job_ids' @> to_jsonb(ARRAY[j::text]), 'money moved, not queued: ' || r::text);
 -- the same signature: not queued
 DELETE FROM public.context_job_story_requests;
 UPDATE public.context_job_story_texts SET checks = checks || jsonb_build_object('money_sig', public.context_job_story_money_sig(j)),
  record_sig = public.context_job_story_record_sig(j) WHERE job_id = j;
 r := public.context_job_story_enqueue_changed(5);
 PERFORM pg_temp.mb_assert(NOT r -> 'job_ids' @> to_jsonb(ARRAY[j::text]), 'nothing moved, queued: ' || r::text);
 -- complete 10 days ago: still woken by money
 UPDATE public.jobs SET status = 'complete', completed_at = now() - interval '10 days' WHERE id = j;
 UPDATE public.context_job_story_texts SET job_status = 'complete' WHERE job_id = j;
 INSERT INTO public.job_materials_facts (job_id, xero_invoice_id, invoice_number, contact_name, lane, kind, amount_ex_gst, confidence, fact_date, automation_source)
 VALUES (j, 'MB-BILL-7', 'B-7', 'Concrete Co', 'materials', 'actual', 15, 'high', '2026-08-29', 'manual_queue');
 r := public.context_job_story_enqueue_changed(5);
 PERFORM pg_temp.mb_assert(r -> 'job_ids' @> to_jsonb(ARRAY[j::text]), 'a bill on a job completed 10 days ago did not wake it: ' || r::text);
 -- completed 40 days ago and signed off long before: quiet
 DELETE FROM public.context_job_story_requests;
 UPDATE public.jobs SET completed_at = now() - interval '40 days' WHERE id = j;
 r := public.context_job_story_enqueue_changed(5);
 PERFORM pg_temp.mb_assert(NOT r -> 'job_ids' @> to_jsonb(ARRAY[j::text]), 'a job completed 40 days ago was woken: ' || r::text);
 -- a sign-off 5 days ago keeps it awake
 INSERT INTO public.job_client_signoffs (job_id, method, happy, waiver_reason, captured_by_actor, created_at)
 VALUES (j, 'office_waiver', NULL, 'Late sign-off', 'user:test', now() - interval '5 days');
 r := public.context_job_story_enqueue_changed(5);
 PERFORM pg_temp.mb_assert(r -> 'job_ids' @> to_jsonb(ARRAY[j::text]), 'a sign-off 5 days ago did not keep the job awake: ' || r::text);
 -- a story written without the block: rewritten while few requests are open, not while many are
 DELETE FROM public.context_job_story_requests;
 UPDATE public.jobs SET status = 'in_progress', completed_at = NULL WHERE id = j;
 UPDATE public.context_job_story_texts SET job_status = 'in_progress', checks = checks - 'money_sig' WHERE job_id = j;
 r := public.context_job_story_enqueue_changed(5);
 PERFORM pg_temp.mb_assert(r -> 'job_ids' @> to_jsonb(ARRAY[j::text]), 'a story without the block was not rewritten: ' || r::text);
 DELETE FROM public.context_job_story_requests;
 INSERT INTO public.jobs (id, org_id, status, type, job_number, legacy, metadata, created_at)
 SELECT ('5eb60000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, '00000000-0000-0000-0000-000000000001', 'in_progress', 'fencing', 'MB-Q' || n, false,
  '{}', '2026-07-01T00:00:00Z' FROM generate_series(1, 10) n;
 INSERT INTO public.context_job_story_requests (job_id, requested_by, reason)
 SELECT ('5eb60000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'test', 'asked' FROM generate_series(1, 10) n;
 r := public.context_job_story_enqueue_changed(5);
 PERFORM pg_temp.mb_assert(NOT r -> 'job_ids' @> to_jsonb(ARRAY[j::text]), 'a rewrite without a change was queued behind 10 open requests: ' || r::text);
END $$;
ROLLBACK;

-- 7. A second apply changes nothing; the rollback restores the 20261009100000 bodies.
BEGIN;
\ir ../../../migrations/20261028190000_context_story_money_book.sql
\ir ../../../rollbacks/20261028190000_context_story_money_book_down.sql
DO $$
BEGIN
 PERFORM pg_temp.mb_assert(to_regprocedure('public.context_job_story_book(uuid,timestamptz)') IS NULL, 'the rollback left the book');
 PERFORM pg_temp.mb_assert((public.context_job_story_text_policy() ->> 'calls_per_day')::integer = 80, 'the rollback left 240 calls');
 PERFORM pg_temp.mb_assert(public.context_job_story_writer_input('5eb00000-0000-4000-8000-0000000000ff') IS NULL, 'writer input after rollback');
END $$;
\ir ../../../rollbacks/20261028190000_context_story_money_book_down.sql
\ir ../../../migrations/20261028190000_context_story_money_book.sql
ROLLBACK;
