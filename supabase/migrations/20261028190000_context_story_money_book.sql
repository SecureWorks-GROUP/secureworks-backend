-- The job story's Money block, written by the database from Job Profit (TP-14 to TP-17, 28 Oct 2026).
--
-- Why. The story writer (secureworks-jarvis luna-story-writer.ts) was given customer invoices and
-- placed supplier bills only. It never saw crew pay, purchase orders, the work order, the client
-- sign-off, the Xero Project total or the Job Profit result, and the story was not rewritten when
-- a bill landed or after the job finished. The architecture review of 28 Oct 2026
-- (cio/framework-20261026/10-architecture-assessment-20261028.md) put most of the measured 81% story
-- accuracy against the owner's 95 to 99% bar down to those inputs, not the model. The owner's bar,
-- 28 Oct 2026: 95 to 99% accuracy, edge cases to a person.
--
-- What it adds:
--  1. context_job_story_book(job, as_of) ("the book"): the job's money in fixed plain lines, built
--     from v_job_profit (the one engine Job Profit's screen reads) and the rows beside it: quoted;
--     expected cost at the quote; invoiced and collected, by payer; owing now per invoice (Xero, inc
--     GST); labour, and crew invoices by crew member; materials, commission and other costs placed; total
--     placed; priced orders not billed, unpriced orders, invoices emailed with no bill placed; bills
--     that probably belong to the job but wait in Bills to place; the Xero Project total as a
--     cross-check; the job work order; the margin, or "Unknown" with its reason. Every figure is the
--     engine's, never worked out here beyond formatting. When anything is still missing the book adds
--     one line that says so ("Costs incomplete: ..."), with counts and no dollar figure. Beside the
--     money it gives job lines the writer reads (client sign-off), a digest of its words and a money
--     signature (context_job_story_money_sig).
--  2. context_job_story_money_sig(job): md5 of the raw rows the book is built from (the job's Xero
--     invoices and bills, placed bill rows, crew invoice lines, purchase orders, bills suggested for
--     the job, work orders, client sign-offs, Xero Projects). Only a real change moves it.
--  3. context_job_story_full_hash(card): what a saved story is fresh against now: the card's
--     story-digest-v1 hash together with the book's digest (story-digest-v1+story-book-v1). A bill
--     placed on the job makes the story stale. Every saved story reads stale once, which is true:
--     none of them was written with the book.
--  4. Replaced (bodies of 20261009100000):
--     context_job_story_writer_input: version story-writer-input-v2; card.book is the book; card_hash
--      is the full hash.
--     context_job_story_text_get: freshness by the full hash; adds money {version, lines, complete,
--      incomplete_line} so the job page shows the book word for word under the story.
--     context_job_story_request: "recent" compares the full hash.
--     context_job_story_enqueue_changed: also wakes a story when the job's money signature differs
--      from the one the story was written with (checks.money_sig, saved by the writer); keeps waking
--      complete, completed and archived jobs for 30 days after completion or the client sign-off;
--      rewrites a story written without the book (no checks.money_sig) only while fewer than 10
--      requests are open, so a real change is never queued behind the one-off rewrite of every story.
--     context_job_story_text_policy: calls_per_day 240 (was 80), so the one-off rewrite of every
--      story (about 630) takes days, not weeks. Everything else as it was.
--  5. context_job_story_book_policy(): this slice's numbers.
--
-- Writes nothing: no table, column, row, trigger or cron job. Service role only.
--
-- Rollback: supabase/rollbacks/20261028190000_context_story_money_book_down.sql (the five bodies
-- back byte for byte, the new functions dropped).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Guard. Reports every problem at once.
DO $guard$
DECLARE problems text[] := '{}'; x record; live text; t text; f text;
BEGIN
 -- The replaced bodies: 20261009100000's, or this migration's (a re-apply).
 FOR x IN SELECT * FROM (VALUES
  ('public.context_job_story_text_policy()', ARRAY['b263f36187edbfa9e49f6ddf0333c7d3', '27ac61c4fee7d15d3b71356271295eab']),
  ('public.context_job_story_request(uuid,text,text)', ARRAY['7b08a13cc6477ae00194acd6d96f8539', '7a75f855aafb50a8821a106ff64ba173']),
  ('public.context_job_story_enqueue_changed(integer)', ARRAY['700761eeee2696d31131e07ae46e5ee3', '6fdbb9442d7184241971f3a96da378bc']),
  ('public.context_job_story_writer_input(uuid)', ARRAY['3ba2c297f97483afccffd83d3d8f4cb2', '13097e3cc7abebfdeabff122bee66e1a']),
  ('public.context_job_story_text_get(uuid,jsonb,boolean)', ARRAY['ecf91571c4e75613c05bce5aaa3a9146', '3cea9dd6df2d2f00660ccd8438637385'])
 ) v(sig, accepted) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS NULL OR NOT live = ANY (x.accepted) THEN
   problems := problems || format('%s md5 %s', x.sig, coalesce(live, '<missing>'));
  END IF;
 END LOOP;
 -- Read, never replaced.
 FOREACH f IN ARRAY ARRAY['public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)', 'public.context_job_story_card_hash(jsonb)',
   'public.context_job_story_ledger(uuid,uuid,timestamptz)', 'public.context_job_story_reading(uuid)', 'public.context_job_story_record_sig(uuid)',
   'public.context_lead_monitored_jobs(uuid[],timestamptz)', 'public.context_job_story_day(date,date)', 'public.context_job_story_text_on()'] LOOP
  IF to_regprocedure(f) IS NULL THEN problems := problems || format('%s missing', f); END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.v_job_profit', 'public.v_job_cost_events', 'public.v_job_revenue_events'] LOOP
  IF to_regclass(f) IS NULL THEN problems := problems || format('%s missing', f); END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['v_job_profit.quoted_ex', 'v_job_profit.expected_source', 'v_job_profit.expected_cost_ex', 'v_job_profit.expected_labour_ex',
   'v_job_profit.expected_materials_ex', 'v_job_profit.expected_commission_ex', 'v_job_profit.invoiced_ex', 'v_job_profit.collected_ex',
   'v_job_profit.invoice_count', 'v_job_profit.draft_revenue_ex', 'v_job_profit.actual_labour_ex', 'v_job_profit.actual_materials_ex',
   'v_job_profit.actual_commission_ex', 'v_job_profit.actual_other_ex', 'v_job_profit.actual_cost_ex', 'v_job_profit.actual_cost_events',
   'v_job_profit.trade_lines_ex', 'v_job_profit.committed_open_ex', 'v_job_profit.ordered_not_billed_count', 'v_job_profit.invoice_emailed_count',
   'v_job_profit.invoice_emailed_ex', 'v_job_profit.xero_project_expenses_ex', 'v_job_profit.xero_project_count', 'v_job_profit.profit_ex',
   'v_job_profit.margin_pct', 'v_job_profit.margin_ok', 'v_job_profit.revenue_flag', 'v_job_profit.cost_flag', 'v_job_profit.work_type',
   'v_job_profit.holding_job', 'v_job_cost_events.source', 'v_job_cost_events.is_actual', 'v_job_cost_events.party', 'v_job_cost_events.amount_ex',
   'v_job_revenue_events.party', 'v_job_revenue_events.amount_ex', 'v_job_revenue_events.counts_as_invoiced',
   'jobs.completed_at', 'jobs.work_order_id', 'work_orders.job_id', 'work_orders.kind', 'work_orders.status', 'work_orders.approved_at',
   'work_orders.agreed_labour_ex', 'xero_invoices.sub_total', 'xero_invoices.raw_json', 'job_materials_facts.job_id',
   'job_materials_facts.xero_invoice_id', 'job_materials_facts.amount_ex_gst', 'job_materials_facts.lane', 'job_materials_facts.kind',
   'trade_invoice_lines.job_id', 'trade_invoice_lines.trade_invoice_id', 'trade_invoice_lines.line_total_ex', 'trade_invoices.status',
   'purchase_orders.job_id', 'purchase_orders.status', 'purchase_orders.total', 'materials_reconciliation_queue.suggested_job_id',
   'materials_reconciliation_queue.status', 'materials_reconciliation_queue.sub_total', 'job_client_signoffs.job_id',
   'job_client_signoffs.method', 'job_client_signoffs.happy', 'job_client_signoffs.created_at', 'xero_projects.job_id',
   'xero_projects.total_expenses', 'context_job_story_texts.checks'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.' || split_part(t, '.', 1))
    AND a.attname = split_part(t, '.', 2) AND NOT a.attisdropped) THEN
   problems := problems || format('public.%s missing', t);
  END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_job_story_book_policy()', 'public.context_job_story_money_words(numeric)',
   'public.context_job_story_money_sig(uuid)', 'public.context_job_story_book(uuid,timestamptz)', 'public.context_job_story_full_hash(jsonb)'] LOOP
  IF to_regprocedure(f) IS NOT NULL
     AND coalesce(obj_description(to_regprocedure(f), 'pg_proc'), '') NOT LIKE 'Story money book (20261028190000)%' THEN
   problems := problems || format('%s exists and is not this migration''s', f);
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_story_money_book_preimage_mismatch: %; read the live definitions before replacing them',
   array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. This slice's numbers. Changed only by migration.
CREATE OR REPLACE FUNCTION public.context_job_story_book_policy()
RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog
AS $fn$
 SELECT jsonb_build_object(
  'version', 'story-book-v1',
  -- a complete, completed or archived job keeps waking for this long after it was completed or signed off
  'after_done_days', 30,
  -- a story written without the book is rewritten only while fewer requests than this are open
  'backfill_open_max', 10,
  -- the most owing invoices and crew members the book names one by one
  'owing_max', 6,
  'crew_max', 6,
  'payers_max', 4)
$fn$;
COMMENT ON FUNCTION public.context_job_story_book_policy() IS
 'Story money book (20261028190000): this slice''s numbers: version story-book-v1, after_done_days 30 (a complete, completed or archived job keeps waking that long after its completion or client sign-off), backfill_open_max 10 (a story written without the book is rewritten only while fewer requests are open), owing_max 6, crew_max 6, payers_max 4 (named one by one, the rest counted). Changed only by migration. Service role only.';

-- 2. A dollar figure as the story writes it: "$1,234.50", "-$12.00". Pure.
CREATE OR REPLACE FUNCTION public.context_job_story_money_words(p numeric)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $fn$
 SELECT CASE WHEN p IS NULL THEN NULL
             ELSE CASE WHEN round(p, 2) < 0 THEN '-' ELSE '' END || to_char(abs(round(p, 2)), 'FM$999,999,999,990.00') END
$fn$;
COMMENT ON FUNCTION public.context_job_story_money_words(numeric) IS
 'Story money book (20261028190000): a dollar figure in the story''s words ("$1,234.50", "-$12.00"), rounded to the cent; null for null. Pure. Service role only.';

-- 3. The money signature: only a real change to the rows the book is built from moves it.
CREATE OR REPLACE FUNCTION public.context_job_story_money_sig(p_job_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 SELECT md5(concat_ws('|', 'money-sig-v1',
  (SELECT string_agg(concat_ws(',', x.id::text, upper(coalesce(x.invoice_type, '')), upper(coalesce(x.status, '')), x.sub_total::text, x.total::text,
          x.amount_due::text, x.amount_paid::text, x.raw_json ->> 'AmountCredited', to_char(x.due_date, 'YYYY-MM-DD')), ';' ORDER BY x.id)
   FROM public.xero_invoices x WHERE x.job_id = p_job_id),
  (SELECT string_agg(concat_ws(',', f.id::text, f.xero_invoice_id, f.amount_ex_gst::text, f.lane, f.kind), ';' ORDER BY f.id)
   FROM public.job_materials_facts f WHERE f.job_id = p_job_id),
  (SELECT string_agg(concat_ws(',', l.id::text, l.line_total_ex::text, ti.status), ';' ORDER BY l.id)
   FROM public.trade_invoice_lines l LEFT JOIN public.trade_invoices ti ON ti.id = l.trade_invoice_id WHERE l.job_id = p_job_id),
  (SELECT string_agg(concat_ws(',', po.id::text, po.status, po.total::text), ';' ORDER BY po.id)
   FROM public.purchase_orders po WHERE po.job_id = p_job_id),
  (SELECT string_agg(concat_ws(',', q.id::text, q.status, q.sub_total::text), ';' ORDER BY q.id)
   FROM public.materials_reconciliation_queue q WHERE q.suggested_job_id = p_job_id AND q.status = 'open'),
  (SELECT string_agg(concat_ws(',', w.id::text, w.kind, w.status, to_char(w.approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
          w.agreed_labour_ex::text), ';' ORDER BY w.id)
   FROM public.work_orders w WHERE w.job_id = p_job_id),
  (SELECT string_agg(s.id::text, ';' ORDER BY s.id) FROM public.job_client_signoffs s WHERE s.job_id = p_job_id),
  (SELECT string_agg(concat_ws(',', xp.id::text, xp.total_expenses::text), ';' ORDER BY xp.id::text)
   FROM public.xero_projects xp WHERE xp.job_id = p_job_id),
  (SELECT concat_ws(',', jb.work_order_id::text, to_char(jb.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')) FROM public.jobs jb WHERE jb.id = p_job_id)))
$fn$;
COMMENT ON FUNCTION public.context_job_story_money_sig(uuid) IS
 'Story money book (20261028190000): md5 (money-sig-v1) of the rows a job''s Money block is built from: its Xero invoices and bills (type, status, sub total, total, due, paid, credited, due date), placed bill rows (job_materials_facts), crew invoice lines and their invoice''s status, purchase orders, open bills suggested for it in Bills to place, work orders, client sign-offs, Xero Projects, and the job''s work order and completion time. A sync that rewrites a row without changing these leaves it alone. The story writer saves it in checks.money_sig; context_job_story_enqueue_changed wakes the story when it moves. Service role only.';

-- 4. The book: the job's money in fixed lines, from Job Profit.
CREATE OR REPLACE FUNCTION public.context_job_story_book(p_job_id uuid, p_as_of timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE pol jsonb := public.context_job_story_book_policy(); p record; v_today date := (coalesce(p_as_of, now()) AT TIME ZONE 'Australia/Perth')::date;
 v_lines text[] := '{}'; v_job_lines text[] := '{}'; v_reasons text[] := '{}'; v_cost_reasons integer := 0;
 v_txt text; v_n integer; v_amt numeric; v_why text; v_complete boolean; v_started boolean; v_incomplete text;
 v_likely_n integer; v_likely_ex numeric; v_priced_n integer; w record; s record;
BEGIN
 IF p_job_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.jobs jb WHERE jb.id = p_job_id) THEN
  RETURN NULL;
 END IF;
 SELECT * INTO p FROM public.v_job_profit v WHERE v.job_id = p_job_id;
 -- bills that probably belong to the job, waiting in Bills to place
 SELECT count(*)::integer, coalesce(sum(q.sub_total), 0) INTO v_likely_n, v_likely_ex
 FROM public.materials_reconciliation_queue q WHERE q.suggested_job_id = p_job_id AND q.status = 'open';
 IF p.job_id IS NULL THEN
  -- a legacy job: Job Profit has no row, so the book says so and nothing else
  v_lines := ARRAY['Money: Job Profit has no record of this job, so no figures are shown.'];
  v_incomplete := 'Costs incomplete: Job Profit has no record of this job.';
  RETURN jsonb_build_object('version', pol ->> 'version', 'job_id', p_job_id, 'source', 'none', 'complete', false, 'started', false,
   'reason', 'no_job_profit_row', 'reasons', jsonb_build_array('no_job_profit_row'), 'lines', to_jsonb(v_lines), 'job_lines', '[]'::jsonb,
   'incomplete_line', v_incomplete, 'facts', '{}'::jsonb,
   'digest', md5(jsonb_build_object('v', pol ->> 'version', 'lines', to_jsonb(v_lines), 'incomplete', v_incomplete)::text),
   'money_sig', public.context_job_story_money_sig(p_job_id));
 END IF;

 -- Quoted and expected
 v_lines := v_lines || CASE WHEN p.quoted_ex IS NOT NULL THEN 'Quoted: ' || public.context_job_story_money_words(p.quoted_ex) || ' ex GST.'
                            ELSE 'Quoted: no sent quote is on record.' END;
 IF p.expected_source IS NOT NULL THEN
  v_lines := v_lines || ('Expected cost at the quote: ' || public.context_job_story_money_words(p.expected_cost_ex) || ' ex GST (labour '
   || public.context_job_story_money_words(coalesce(p.expected_labour_ex, 0)) || ', materials '
   || public.context_job_story_money_words(coalesce(p.expected_materials_ex, 0)) || ', commission '
   || public.context_job_story_money_words(coalesce(p.expected_commission_ex, 0)) || ').');
 END IF;

 -- Invoiced, collected, by payer, owing now
 IF coalesce(p.invoice_count, 0) = 0 THEN
  v_lines := v_lines || 'Invoiced: no customer invoice is issued yet.'::text;
 ELSE
  v_lines := v_lines || ('Invoiced: ' || public.context_job_story_money_words(p.invoiced_ex) || ' ex GST on ' || p.invoice_count
   || CASE WHEN p.invoice_count = 1 THEN ' invoice' ELSE ' invoices' END || '; collected '
   || public.context_job_story_money_words(p.collected_ex) || ' ex GST.');
  SELECT count(*)::integer, string_agg(x.party || ' ' || public.context_job_story_money_words(x.ex), ', ' ORDER BY x.ex DESC, x.party COLLATE "C")
         FILTER (WHERE x.o <= (pol ->> 'payers_max')::integer)
  INTO v_n, v_txt
  FROM (SELECT coalesce(nullif(btrim(e.party), ''), 'a payer not named') AS party, sum(e.amount_ex) AS ex,
               row_number() OVER (ORDER BY sum(e.amount_ex) DESC, coalesce(nullif(btrim(e.party), ''), 'a payer not named') COLLATE "C") AS o
        FROM public.v_job_revenue_events e WHERE e.job_id = p_job_id AND e.counts_as_invoiced
        GROUP BY 1) x;
  IF v_n > 1 THEN
   v_lines := v_lines || ('Invoiced by payer (ex GST): ' || v_txt
    || CASE WHEN v_n > (pol ->> 'payers_max')::integer THEN ' and ' || (v_n - (pol ->> 'payers_max')::integer) || ' more' ELSE '' END || '.');
  END IF;
 END IF;
 IF coalesce(p.draft_revenue_ex, 0) > 0 THEN
  v_lines := v_lines || ('Draft invoices, never issued: ' || public.context_job_story_money_words(p.draft_revenue_ex) || ' ex GST.');
 END IF;
 FOR w IN
  SELECT x.invoice_number, x.amount_due, x.due_date, row_number() OVER (ORDER BY x.due_date NULLS LAST, x.invoice_number COLLATE "C", x.id) AS o,
         count(*) OVER () AS n
  FROM public.xero_invoices x
  WHERE x.job_id = p_job_id AND upper(coalesce(x.invoice_type, 'ACCREC')) = 'ACCREC'
    AND upper(coalesce(x.status, '')) IN ('AUTHORISED', 'SUBMITTED') AND coalesce(x.amount_due, 0) > 0
  ORDER BY 4
 LOOP
  IF w.o <= (pol ->> 'owing_max')::integer THEN
   v_lines := v_lines || ('Owing now on ' || coalesce(nullif(btrim(w.invoice_number), ''), 'an invoice without a number') || ': '
    || public.context_job_story_money_words(w.amount_due) || ' inc GST'
    || CASE WHEN w.due_date IS NOT NULL THEN ', due ' || public.context_job_story_day(w.due_date, v_today) ELSE '' END
    || CASE WHEN w.due_date < v_today THEN ', overdue' ELSE '' END || '.');
  ELSIF w.o = (pol ->> 'owing_max')::integer + 1 THEN
   v_lines := v_lines || ('Owing now on ' || (w.n - (pol ->> 'owing_max')::integer) || ' more invoices.');
  END IF;
 END LOOP;

 -- Costs placed
 v_lines := v_lines || ('Labour placed: ' || public.context_job_story_money_words(p.actual_labour_ex) || ' ex GST.');
 SELECT count(*)::integer, string_agg(x.party || ' ' || public.context_job_story_money_words(x.ex), ', ' ORDER BY x.ex DESC, x.party COLLATE "C")
        FILTER (WHERE x.o <= (pol ->> 'crew_max')::integer)
 INTO v_n, v_txt
 FROM (SELECT coalesce(nullif(btrim(e.party), ''), 'a crew member not named') AS party, sum(e.amount_ex) AS ex,
              row_number() OVER (ORDER BY sum(e.amount_ex) DESC, coalesce(nullif(btrim(e.party), ''), 'a crew member not named') COLLATE "C") AS o
       FROM public.v_job_cost_events e WHERE e.job_id = p_job_id AND e.source = 'trade_line' AND e.is_actual
       GROUP BY 1) x;
 IF v_n > 0 THEN
  v_lines := v_lines || ('Crew invoices placed (ex GST): ' || v_txt
   || CASE WHEN v_n > (pol ->> 'crew_max')::integer THEN ' and ' || (v_n - (pol ->> 'crew_max')::integer) || ' more' ELSE '' END || '.');
 END IF;
 v_lines := v_lines || ('Materials placed: ' || public.context_job_story_money_words(p.actual_materials_ex) || ' ex GST.');
 IF coalesce(p.actual_commission_ex, 0) <> 0 OR coalesce(p.expected_commission_ex, 0) > 0 THEN
  v_lines := v_lines || ('Commission placed: ' || public.context_job_story_money_words(p.actual_commission_ex) || ' ex GST.');
 END IF;
 IF coalesce(p.actual_other_ex, 0) <> 0 THEN
  v_lines := v_lines || ('Other costs placed: ' || public.context_job_story_money_words(p.actual_other_ex) || ' ex GST.');
 END IF;
 v_lines := v_lines || ('Total costs placed: ' || public.context_job_story_money_words(p.actual_cost_ex) || ' ex GST.');

 -- Costs still coming
 SELECT count(*)::integer INTO v_priced_n FROM public.v_job_cost_events e WHERE e.job_id = p_job_id AND e.source = 'po_committed';
 IF coalesce(p.committed_open_ex, 0) > 0 THEN
  v_lines := v_lines || ('Ordered, not billed yet: ' || public.context_job_story_money_words(p.committed_open_ex) || ' ex GST on '
   || v_priced_n || CASE WHEN v_priced_n = 1 THEN ' priced purchase order.' ELSE ' priced purchase orders.' END);
 END IF;
 IF coalesce(p.ordered_not_billed_count, 0) > 0 THEN
  v_lines := v_lines || ('Purchase orders sent with no price and no bill yet: ' || p.ordered_not_billed_count || '.');
 END IF;
 IF coalesce(p.invoice_emailed_count, 0) > 0 THEN
  v_lines := v_lines || ('Supplier invoices emailed for an order, bill not placed on this job yet: ' || p.invoice_emailed_count
   || CASE WHEN coalesce(p.invoice_emailed_ex, 0) > 0 THEN ', ' || public.context_job_story_money_words(p.invoice_emailed_ex) || ' ex GST' ELSE '' END || '.');
 END IF;
 IF v_likely_n > 0 THEN
  v_lines := v_lines || ('Bills that probably belong to this job, waiting to be placed: ' || v_likely_n || ', '
   || public.context_job_story_money_words(v_likely_ex) || ' ex GST.');
 END IF;
 IF coalesce(p.xero_project_count, 0) > 0 AND p.xero_project_expenses_ex IS NOT NULL THEN
  v_lines := v_lines || ('Xero Project expenses on record: ' || public.context_job_story_money_words(p.xero_project_expenses_ex)
   || ' ex GST (a cross-check, not counted as cost).');
 END IF;

 -- The job's work order
 SELECT wo.status, wo.approved_at, wo.agreed_labour_ex INTO w
 FROM public.jobs jb JOIN public.work_orders wo ON wo.id = jb.work_order_id WHERE jb.id = p_job_id;
 IF w.status IS NOT NULL THEN
  v_lines := v_lines || CASE WHEN w.approved_at IS NOT NULL
   THEN 'Work order: approved ' || public.context_job_story_day((w.approved_at AT TIME ZONE 'Australia/Perth')::date, v_today)
        || CASE WHEN w.agreed_labour_ex IS NOT NULL THEN ', agreed labour ' || public.context_job_story_money_words(w.agreed_labour_ex) || ' ex GST' ELSE '' END || '.'
   ELSE 'Work order: drafted, not approved yet.' END;
 ELSIF p.work_type IN ('fencing', 'patio', 'decking', 'combo') THEN
  v_lines := v_lines || 'Work order: none on record.'::text;
 END IF;

 -- What is still missing, and the margin
 IF p.revenue_flag IS DISTINCT FROM 'ok' THEN v_reasons := v_reasons || 'no customer invoice is issued yet'::text; END IF;
 v_why := CASE p.cost_flag
  WHEN 'xero_project_exceeds_line_costs' THEN 'the Xero Project shows more costs than are placed on this job'
  WHEN 'installer_bill_unconfirmed' THEN 'an installer bill on this job is waiting for a person to confirm it'
  WHEN 'no_cost_linked' THEN 'no costs are placed on this job yet'
  WHEN 'incomplete_invoice_lines' THEN 'a crew invoice on this job has incomplete lines'
  WHEN 'unclassified_lines' THEN 'some cost lines are not sorted into labour or materials'
  WHEN 'materials_not_linked' THEN 'no materials bills are placed on this job yet'
  WHEN 'no_labour_linked' THEN 'no crew pay or labour is placed on this job yet'
  END;
 IF v_why IS NOT NULL THEN v_reasons := v_reasons || v_why; v_cost_reasons := v_cost_reasons + 1; END IF;
 IF v_likely_n > 0 THEN
  v_reasons := v_reasons || (v_likely_n || CASE WHEN v_likely_n = 1 THEN ' bill that probably belongs to this job is' ELSE ' bills that probably belong to this job are' END
   || ' waiting to be placed');
  v_cost_reasons := v_cost_reasons + 1;
 END IF;
 IF v_priced_n > 0 THEN
  v_reasons := v_reasons || (v_priced_n || CASE WHEN v_priced_n = 1 THEN ' priced purchase order has' ELSE ' priced purchase orders have' END || ' no bill yet');
  v_cost_reasons := v_cost_reasons + 1;
 END IF;
 IF coalesce(p.ordered_not_billed_count, 0) > 0 THEN
  v_reasons := v_reasons || (p.ordered_not_billed_count || CASE WHEN p.ordered_not_billed_count = 1 THEN ' purchase order with no price has' ELSE ' purchase orders with no price have' END
   || ' no bill yet');
  v_cost_reasons := v_cost_reasons + 1;
 END IF;
 IF coalesce(p.invoice_emailed_count, 0) > 0 THEN
  v_reasons := v_reasons || (p.invoice_emailed_count || CASE WHEN p.invoice_emailed_count = 1 THEN ' supplier invoice was' ELSE ' supplier invoices were' END
   || ' emailed but its bill is not placed');
  v_cost_reasons := v_cost_reasons + 1;
 END IF;
 v_complete := coalesce(p.margin_ok, false) AND cardinality(v_reasons) = 0;
 v_started := coalesce(p.invoice_count, 0) > 0 OR coalesce(p.actual_cost_events, 0) > 0 OR v_likely_n > 0 OR v_priced_n > 0
  OR coalesce(p.ordered_not_billed_count, 0) > 0 OR coalesce(p.invoice_emailed_count, 0) > 0 OR coalesce(p.draft_revenue_ex, 0) > 0;
 v_lines := v_lines || CASE WHEN coalesce(p.margin_ok, false) AND p.profit_ex IS NOT NULL
  THEN 'Margin: ' || public.context_job_story_money_words(p.profit_ex) || ' ex GST profit, ' || p.margin_pct::text || '% of invoiced'
       || CASE WHEN v_complete THEN '.' ELSE ', on the costs placed so far.' END
  ELSE 'Margin: Unknown, because ' || coalesce(v_reasons[1], CASE WHEN p.holding_job THEN 'this is a holding job, not a customer''s job'
                                                               ELSE 'Job Profit does not show one' END) || '.' END;
 IF NOT v_complete THEN
  v_incomplete := CASE WHEN v_cost_reasons > 0 THEN 'Costs incomplete: ' ELSE 'Money incomplete: ' END
   || coalesce(array_to_string(v_reasons, '; '), 'Job Profit does not show a margin') || '.';
  IF cardinality(v_reasons) = 0 THEN
   v_incomplete := 'Costs incomplete: Job Profit does not show a margin yet.';
  END IF;
  v_lines := v_lines || v_incomplete;
 END IF;

 -- The job lines the writer reads beside the money: the client's sign-off
 SELECT sg.method, sg.happy, sg.created_at INTO s FROM public.job_client_signoffs sg
 WHERE sg.job_id = p_job_id ORDER BY sg.created_at DESC, sg.id DESC LIMIT 1;
 v_job_lines := v_job_lines || CASE WHEN s.created_at IS NULL THEN 'Client sign-off: none on record.'
  ELSE 'Client sign-off: ' || CASE WHEN s.method = 'office_waiver' THEN 'waived by the office' ELSE 'signed on site' END || ' '
       || public.context_job_story_day((s.created_at AT TIME ZONE 'Australia/Perth')::date, v_today)
       || CASE WHEN s.happy IS TRUE THEN ', the customer said they were happy' WHEN s.happy IS FALSE THEN ', the customer said they were not happy' ELSE '' END || '.' END;

 RETURN jsonb_build_object(
  'version', pol ->> 'version',
  'job_id', p_job_id,
  'source', 'job_profit',
  'complete', v_complete,
  'started', v_started,
  'reason', CASE WHEN v_complete THEN 'complete' WHEN p.revenue_flag IS DISTINCT FROM 'ok' AND p.cost_flag IN ('ok', 'text_matched_lines') THEN p.revenue_flag
                 WHEN p.cost_flag NOT IN ('ok', 'text_matched_lines') THEN p.cost_flag ELSE 'costs_waiting' END,
  'reasons', to_jsonb(v_reasons),
  'lines', to_jsonb(v_lines),
  'job_lines', to_jsonb(v_job_lines),
  'incomplete_line', v_incomplete,
  'facts', jsonb_build_object('margin_ok', coalesce(p.margin_ok, false), 'cost_flag', p.cost_flag, 'revenue_flag', p.revenue_flag,
   'likely_unplaced_bills', v_likely_n, 'priced_orders_open', v_priced_n, 'orders_unpriced_open', coalesce(p.ordered_not_billed_count, 0),
   'invoices_emailed_unplaced', coalesce(p.invoice_emailed_count, 0), 'signed_off', s.created_at IS NOT NULL, 'work_order', coalesce(w.status, 'none')),
  'digest', md5(jsonb_build_object('v', pol ->> 'version', 'lines', to_jsonb(v_lines), 'job_lines', to_jsonb(v_job_lines),
                                   'incomplete', v_incomplete)::text),
  'money_sig', public.context_job_story_money_sig(p_job_id));
END $fn$;
COMMENT ON FUNCTION public.context_job_story_book(uuid, timestamptz) IS
 'Story money book (20261028190000): the job''s money in fixed plain lines from Job Profit (v_job_profit, v_job_cost_events, v_job_revenue_events, the engine Job Profit''s screen reads; figures are the engine''s, formatted, never worked out here): {version story-book-v1, job_id, source job_profit|none, complete, started (any invoice, cost, order or waiting bill), reason, reasons, lines, job_lines, incomplete_line, facts, digest, money_sig}. lines: quoted; expected cost at the quote; invoiced and collected (ex GST) and by payer; owing now per invoice (Xero, inc GST); labour, and crew invoices by crew member; materials, commission, other and total costs placed; priced orders not billed, unpriced orders, invoices emailed with no bill placed; bills that probably belong to the job waiting in Bills to place (open queue rows suggested for it); the Xero Project total (a cross-check); the job work order; the margin or "Unknown, because ..."; and, unless complete, one "Costs incomplete: ..." (or "Money incomplete: ...") line with counts and no dollar figure. complete: Job Profit shows a margin and nothing is waiting. job_lines: the client sign-off. digest: md5 of the words. NULL for an unknown job. Read only. Service role only.';

-- 5. What a saved story is fresh against: the card's digest and the book's.
CREATE OR REPLACE FUNCTION public.context_job_story_full_hash(p_card jsonb)
RETURNS text
LANGUAGE sql STABLE STRICT
AS $fn$
 SELECT md5('story-digest-v1+story-book-v1|' || coalesce(public.context_job_story_card_hash(p_card), '') || '|'
            || coalesce(p_card #>> '{book,digest}', 'none'))
$fn$;
COMMENT ON FUNCTION public.context_job_story_full_hash(jsonb) IS
 'Story money book (20261028190000): the hash a saved story is fresh against (story-digest-v1+story-book-v1): md5 of the card''s story-digest-v1 hash (context_job_story_card_hash) and the book''s digest (card.book.digest, none without one). A money change the book shows makes the story stale; the clock alone never does. Null for a null card. Service role only.';

-- 6. The policy: calls_per_day 240 (was 80). Every other number as it was.
CREATE OR REPLACE FUNCTION public.context_job_story_text_policy()
RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog
AS $fn$
 SELECT jsonb_build_object(
  'flag', 'context_job_story_text_v1',
  -- story model calls a Perth day (one per write, one more for a strict retry);
  -- 240 since 20261028190000 (was 80), for the one-off rewrite of every story with its Money block
  'calls_per_day', 240,
  -- a claimed request is the worker's for this long
  'lease_minutes', 15,
  -- a story under this age that is still fresh is not rewritten (asked or not),
  -- and the sweep leaves a story this young alone
  'min_rewrite_minutes', 10,
  -- with no live AI reading, a new message wakes a rewrite only after this quiet time
  'quiet_minutes', 15,
  -- job_changed requests the sweep queues a call, at most
  'enqueue_per_call', 5,
  -- counted attempts before a request closes failed (max_attempts)
  'max_attempts', 3,
  -- the wait after the first and the second counted failure, in minutes
  'retry_minutes', jsonb_build_array(30, 120),
  -- the digest of the card the freshness hash reads (context_job_story_card_hash)
  'digest', 'story-digest-v1',
  -- who a job_changed request is requested by
  'writer', 'luna-story-writer')
$fn$;
COMMENT ON FUNCTION public.context_job_story_text_policy() IS
 'Story money book (20261028190000), job story text (20261009100000): every number of the saved job story: calls_per_day 240 (story model calls a Perth day; 80 before 20261028190000), lease_minutes 15, min_rewrite_minutes 10, quiet_minutes 15, enqueue_per_call 5, max_attempts 3, retry_minutes [30, 120], digest story-digest-v1 (the card part of the freshness hash; the book''s digest is the other part, context_job_story_full_hash), writer luna-story-writer. Changed only by migration. Service role only.';

-- 7. The staff read: the current story, whether it is still current, the writer's state, and the Money block.
CREATE OR REPLACE FUNCTION public.context_job_story_text_get(p_job_id uuid, p_card jsonb DEFAULT NULL, p_check boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE t public.context_job_story_texts; r public.context_job_story_requests; v_card jsonb; v_hash text; v_status text;
 v_fail_error text; v_fail_at timestamptz; v_book jsonb;
BEGIN
 IF p_job_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.jobs jb WHERE jb.id = p_job_id) THEN
  RETURN NULL;
 END IF;
 SELECT * INTO t FROM public.context_job_story_texts x WHERE x.job_id = p_job_id AND x.status = 'current';
 -- the card the caller passed carries the book when it came from the writer's input; else it is built once here
 IF jsonb_typeof(p_card -> 'book') = 'object' AND (p_card #>> '{book,job_id}') = p_job_id::text THEN
  v_book := p_card -> 'book';
 ELSE
  v_book := public.context_job_story_book(p_job_id, now());
 END IF;
 IF coalesce(p_check, true) THEN
  -- the card the caller just read, else built now (only when there is a story to compare)
  v_card := coalesce(p_card, CASE WHEN t.id IS NOT NULL THEN public.context_job_story(p_job_id, now()) END);
  -- a card that is not this job's is no answer
  IF v_card IS NOT NULL AND (v_card #>> '{job,id}') IS DISTINCT FROM p_job_id::text THEN
   v_card := NULL;
  END IF;
  IF v_card IS NOT NULL THEN
   v_card := v_card || jsonb_build_object('book', v_book);
  END IF;
  v_hash := public.context_job_story_full_hash(v_card);
 END IF;
 v_status := CASE WHEN t.id IS NULL THEN 'none' WHEN v_hash IS NULL THEN 'unchecked'
                  WHEN v_hash = t.card_hash THEN 'fresh' ELSE 'stale' END;
 SELECT * INTO r FROM public.context_job_story_requests q WHERE q.job_id = p_job_id AND q.done_at IS NULL;
 SELECT q.error, q.done_at INTO v_fail_error, v_fail_at FROM public.context_job_story_requests q
 WHERE q.job_id = p_job_id AND q.outcome = 'failed' AND q.done_at > coalesce(t.written_at, '-infinity'::timestamptz)
 ORDER BY q.done_at DESC, q.id DESC LIMIT 1;
 RETURN jsonb_build_object(
  'version', 'job-story-text-v1',
  'job_id', p_job_id,
  'status', v_status,
  'card_hash', v_hash,
  'text', CASE WHEN t.id IS NOT NULL THEN jsonb_build_object('id', t.id, 'written_at', t.written_at, 'checked_at', t.checked_at,
           'evidence_until', t.evidence_until, 'generation_id', t.generation_id, 'card_hash', t.card_hash, 'model', t.model,
           'sections', t.sections,
           'inputs', CASE WHEN jsonb_typeof(t.checks -> 'inputs') = 'object' THEN t.checks -> 'inputs' ELSE '{}'::jsonb END) END,
  'writer', jsonb_build_object(
   'on', public.context_job_story_text_on(),
   'open_request', CASE WHEN r.id IS NOT NULL THEN jsonb_build_object('id', r.id, 'reason', r.reason, 'requested_at', r.requested_at,
                    'picked_at', r.picked_at, 'attempts', r.attempts, 'next_attempt_at', r.next_attempt_at) END,
   'last_failure', CASE WHEN v_fail_at IS NOT NULL THEN jsonb_build_object('error', v_fail_error, 'at', v_fail_at) END),
  -- (20261028190000) the Money block, written by the database from Job Profit, shown word for word under the story
  'money', CASE WHEN v_book IS NOT NULL THEN jsonb_build_object('version', v_book -> 'version', 'source', v_book -> 'source',
            'lines', v_book -> 'lines', 'complete', v_book -> 'complete', 'incomplete_line', v_book -> 'incomplete_line') END);
END $fn$;
COMMENT ON FUNCTION public.context_job_story_text_get(uuid, jsonb, boolean) IS
 'Story money book (20261028190000), job story text (20261009100000): the saved story of one job for the staff door (ops-api job_overview): {version job-story-text-v1, job_id, status, card_hash, text, writer, money}. status: none (no story), fresh (its card_hash equals context_job_story_full_hash of the card now with its book), stale, or unchecked (not compared: p_check false, or no card of this job). p_card: the job-story-v1 card the caller has just read (a card of another job is ignored); null builds context_job_story(job, now()) when there is a story to compare; the book is p_card.book when it is this job''s, else built once (context_job_story_book). text: {id, written_at, checked_at, evidence_until, generation_id, card_hash, model, sections, inputs} or null. writer: {on, open_request {id, reason, requested_at, picked_at, attempts, next_attempt_at} or null, last_failure {error, at} newer than the story, or null}. money: the book''s {version, source, lines, complete, incomplete_line}, shown word for word under the story. NULL for an unknown job. Read only. Service role only.';

-- 8. Ask for a story (staff), idempotent and rate limited: "recent" by the full hash.
CREATE OR REPLACE FUNCTION public.context_job_story_request(p_job_id uuid, p_by text, p_reason text DEFAULT 'asked')
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE pol jsonb := public.context_job_story_text_policy(); r public.context_job_story_requests; t public.context_job_story_texts;
 v_card jsonb; v_monitored boolean; v_id uuid; v_at timestamptz;
BEGIN
 IF p_job_id IS NULL OR p_by IS NULL OR p_by !~ '^[A-Za-z0-9_.:@-]{1,128}$' OR p_reason IS NULL OR p_reason NOT IN ('asked', 'job_changed')
  OR NOT EXISTS (SELECT 1 FROM public.jobs jb WHERE jb.id = p_job_id) THEN
  RAISE EXCEPTION 'context_job_story_request_invalid' USING ERRCODE = '22023';
 END IF;
 IF NOT public.context_job_story_text_on() THEN
  RETURN jsonb_build_object('outcome', 'off');
 END IF;
 -- one decision at a time per job
 PERFORM pg_advisory_xact_lock(20261009, hashtext(p_job_id::text));
 SELECT * INTO r FROM public.context_job_story_requests q WHERE q.job_id = p_job_id AND q.done_at IS NULL;
 IF r.id IS NOT NULL THEN
  RETURN jsonb_build_object('outcome', 'already_open', 'request_id', r.id, 'requested_at', r.requested_at, 'reason', r.reason);
 END IF;
 IF p_reason = 'job_changed' THEN
  SELECT m.monitored INTO v_monitored FROM public.context_lead_monitored_jobs(ARRAY[p_job_id], now()) m;
  IF NOT coalesce(v_monitored, false) OR EXISTS (SELECT 1 FROM public.jobs jb WHERE jb.id = p_job_id
     AND (jb.status::text IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
          OR coalesce(jb.metadata ->> 'do_not_schedule', '') IN ('true', '1'))) THEN
   RETURN jsonb_build_object('outcome', 'not_live');
  END IF;
 END IF;
 SELECT * INTO t FROM public.context_job_story_texts x WHERE x.job_id = p_job_id AND x.status = 'current';
 IF t.id IS NOT NULL AND t.written_at > now() - make_interval(mins => (pol ->> 'min_rewrite_minutes')::integer) THEN
  v_card := public.context_job_story(p_job_id, now());
  IF v_card IS NOT NULL
     AND public.context_job_story_full_hash(v_card || jsonb_build_object('book', public.context_job_story_book(p_job_id, now()))) = t.card_hash THEN
   RETURN jsonb_build_object('outcome', 'recent', 'text_id', t.id, 'written_at', t.written_at);
  END IF;
 END IF;
 INSERT INTO public.context_job_story_requests (job_id, requested_by, reason) VALUES (p_job_id, p_by, p_reason)
 RETURNING id, requested_at INTO v_id, v_at;
 RETURN jsonb_build_object('outcome', 'queued', 'request_id', v_id, 'requested_at', v_at, 'reason', p_reason);
END $fn$;
COMMENT ON FUNCTION public.context_job_story_request(uuid, text, text) IS
 'Story money book (20261028190000), job story text (20261009100000): asks for a job''s story to be written or rewritten: {outcome queued|already_open|recent|off|not_live, request_id, requested_at, reason}. off while the switch is off (nothing written); already_open returns the open request (idempotent; one open a job); recent while the current story is under min_rewrite_minutes old and its card_hash still equals the full hash of the card now with its book (context_job_story_full_hash; built once, only then); job_changed only for a live, monitored job (context_lead_monitored_jobs; else not_live), asked on any job. p_by: user:<id> from the verified session, or a server caller''s actor (letters, digits and _ . : @ -, 1 to 128). Raises context_job_story_request_invalid for bad arguments or an unknown job. Takes the job''s advisory lock (20261009). Service role only.';

-- 9. The writer's sweep: the one rule for "something new happened", now with money.
CREATE OR REPLACE FUNCTION public.context_job_story_enqueue_changed(p_limit integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE pol jsonb := public.context_job_story_text_policy(); bpol jsonb := public.context_job_story_book_policy(); v_cap integer; v_limit integer;
 v_rewrite interval; v_quiet interval; v_after interval; v_open integer; v_cand uuid[]; v_jobs uuid[]; v_ids jsonb;
BEGIN
 IF NOT public.context_job_story_text_on() THEN
  RETURN jsonb_build_object('outcome', 'off', 'queued', 0, 'job_ids', '[]'::jsonb);
 END IF;
 v_cap := (pol ->> 'enqueue_per_call')::integer;
 v_limit := least(greatest(coalesce(p_limit, v_cap), 0), v_cap);
 IF v_limit = 0 THEN
  RETURN jsonb_build_object('outcome', 'queued', 'queued', 0, 'job_ids', '[]'::jsonb, 'candidates', 0);
 END IF;
 v_rewrite := make_interval(mins => (pol ->> 'min_rewrite_minutes')::integer);
 v_quiet := make_interval(mins => (pol ->> 'quiet_minutes')::integer);
 v_after := make_interval(days => (bpol ->> 'after_done_days')::integer);
 SELECT count(*)::integer INTO v_open FROM public.context_job_story_requests q WHERE q.done_at IS NULL;
 -- 1. Cheap signals first: a current story older than the rewrite floor, no open request, a live job
 --    (or one complete, completed or archived inside after_done_days of its completion or client
 --    sign-off, when its last costs land), and something newer than the story covers: the job's
 --    status, its AI reading (a new generation, or the same one read further), its customer
 --    invoices' money or its quotes' times (only when a row was touched since, then confirmed by the
 --    record signature), its money (the money signature differs from the one the story was written
 --    with: a bill, crew line, order, credit or sign-off placed or removed), or, with no AI reading at
 --    all, a message row recorded since that has been quiet for quiet_minutes. A story written without
 --    the Money block (no checks.money_sig) is rewritten only while fewer than backfill_open_max
 --    requests are open, and after every real change. Oldest checked first.
 SELECT array_agg(c.job_id ORDER BY c.backfill, c.checked_at, c.job_id) INTO v_cand
 FROM (
  SELECT t.job_id, t.checked_at, NOT coalesce(t.checks ? 'money_sig', false) AS backfill
  FROM public.context_job_story_texts t
  JOIN public.jobs jb ON jb.id = t.job_id
  LEFT JOIN LATERAL public.context_job_story_reading(t.job_id) lg ON true
  WHERE t.status = 'current'
    AND t.written_at <= now() - v_rewrite
    AND NOT EXISTS (SELECT 1 FROM public.context_job_story_requests q WHERE q.job_id = t.job_id AND q.done_at IS NULL)
    AND (jb.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
         OR (jb.status::text IN ('archived', 'complete', 'completed')
             AND greatest(jb.completed_at, (SELECT max(s.created_at) FROM public.job_client_signoffs s WHERE s.job_id = t.job_id))
                 > now() - v_after))
    AND coalesce(jb.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1')
    AND (jb.status::text IS DISTINCT FROM t.job_status
         OR lg.generation_id IS DISTINCT FROM t.generation_id
         OR date_trunc('milliseconds', lg.evidence_until) IS DISTINCT FROM date_trunc('milliseconds', t.evidence_until)
         OR ((EXISTS (SELECT 1 FROM public.xero_invoices x WHERE x.job_id = t.job_id AND x.updated_at > t.checked_at)
              OR EXISTS (SELECT 1 FROM public.job_documents d WHERE d.job_id = t.job_id AND d.type = 'quote'
                         AND greatest(d.sent_at, d.accepted_at, d.declined_at, d.superseded_at) > t.checked_at))
             AND public.context_job_story_record_sig(t.job_id) IS DISTINCT FROM t.record_sig)
         OR (lg.generation_id IS NULL AND EXISTS (
              SELECT 1 FROM public.business_events e
              WHERE e.job_id = t.job_id
                AND (e.channel IN ('sms', 'email', 'call', 'note', 'whatsapp', 'chat')
                     OR e.event_type IN ('client.reply', 'client.email_in', 'client.email_out', 'client.sms_in', 'client.sms_out',
                       'client.call_complete', 'client.call_logged', 'call.transcript_completed', 'client.message_in',
                       'supplier.email_in', 'ghl.note_added', 'note.added'))
                AND e.metadata #>> '{duplicate_of}' IS NULL
                AND coalesce(e.recorded_at, e.occurred_at) > t.checked_at
                AND coalesce(e.recorded_at, e.occurred_at) <= now() - v_quiet))
         OR (coalesce(t.checks ? 'money_sig', false)
             AND public.context_job_story_money_sig(t.job_id) IS DISTINCT FROM t.checks ->> 'money_sig')
         OR (NOT coalesce(t.checks ? 'money_sig', false) AND v_open < (bpol ->> 'backfill_open_max')::integer))
  ORDER BY 3, t.checked_at, t.job_id
  LIMIT v_limit * 10
 ) c;
 IF v_cand IS NULL THEN
  RETURN jsonb_build_object('outcome', 'queued', 'queued', 0, 'job_ids', '[]'::jsonb, 'candidates', 0);
 END IF;
 -- 2. Then the lead rule, for the survivors only: a lead no longer followed up is never rewritten by itself.
 SELECT array_agg(m.job_id ORDER BY array_position(v_cand, m.job_id)) INTO v_jobs
 FROM public.context_lead_monitored_jobs(v_cand, now()) m WHERE m.monitored;
 WITH ins AS (
  INSERT INTO public.context_job_story_requests (job_id, requested_by, reason)
  SELECT j.job_id, pol ->> 'writer', 'job_changed'
  FROM unnest(coalesce(v_jobs, '{}'::uuid[])) WITH ORDINALITY AS j(job_id, ord)
  WHERE j.ord <= v_limit
  ON CONFLICT (job_id) WHERE done_at IS NULL DO NOTHING
  RETURNING job_id)
 SELECT coalesce(jsonb_agg(ins.job_id ORDER BY ins.job_id), '[]'::jsonb) INTO v_ids FROM ins;
 RETURN jsonb_build_object('outcome', 'queued', 'queued', jsonb_array_length(v_ids), 'job_ids', v_ids, 'candidates', cardinality(v_cand));
END $fn$;
COMMENT ON FUNCTION public.context_job_story_enqueue_changed(integer) IS
 'Story money book (20261028190000), job story text (20261009100000): the one rule for "something new happened" (SQL decides what is due; the worker calls it each tick): queues reason job_changed, requested_by luna-story-writer, for at most p_limit (default and most enqueue_per_call, 5) jobs: a current story written more than min_rewrite_minutes ago, no open request, a live job (not cancelled, draft, archived, complete, completed or lost, never a holding job) or one complete, completed or archived whose completion (jobs.completed_at) or newest client sign-off is inside after_done_days (30), monitored by the lead rule (context_lead_monitored_jobs, read only for the jobs the cheap signals keep), and something newer than the story covers: the job''s status differs from the story''s; its AI reading (context_job_story_reading) is another generation or reads to another evidence_until; a customer invoice or quote row was touched since checked_at and the record signature (context_job_story_record_sig) differs; its money signature (context_job_story_money_sig) differs from the story''s checks.money_sig; with no AI reading, a message row (not a copy) recorded since checked_at and quiet for quiet_minutes; or the story was written without the Money block (no checks.money_sig), only while fewer than backfill_open_max (10) requests are open. Real changes first, then the rewrites without the block, oldest checked first. {outcome off|queued, queued, job_ids, candidates}. Service role only.';

-- 10. What the writer reads, from one snapshot: the card with its book.
CREATE OR REPLACE FUNCTION public.context_job_story_writer_input(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE v_status text; v_card jsonb; t public.context_job_story_texts;
BEGIN
 SELECT jb.status::text INTO v_status FROM public.jobs jb WHERE jb.id = p_job_id;
 IF NOT FOUND THEN
  RETURN NULL;
 END IF;
 v_card := public.context_job_story(p_job_id, now());
 -- (20261028190000) the Money block and the job lines from Job Profit: the writer shows the book, never sums
 IF v_card IS NOT NULL THEN
  v_card := v_card || jsonb_build_object('book', public.context_job_story_book(p_job_id, now()));
 END IF;
 SELECT * INTO t FROM public.context_job_story_texts x WHERE x.job_id = p_job_id AND x.status = 'current';
 RETURN jsonb_build_object(
  'version', 'story-writer-input-v2',
  'job_id', p_job_id,
  'as_of', now(),
  'job_status', v_status,
  'card', v_card,
  'card_hash', public.context_job_story_full_hash(v_card),
  'current', CASE WHEN t.id IS NOT NULL THEN jsonb_build_object('text_id', t.id, 'card_hash', t.card_hash,
              'written_at', t.written_at, 'checked_at', t.checked_at) END,
  'notes', public.context_job_story_ledger(p_job_id, NULL, now()),
  -- call transcripts on the job: never prompt text (speakers unlabelled, names misheard)
  'transcript_row_ids', coalesce((SELECT jsonb_agg(e.id::text ORDER BY e.id) FROM public.business_events e
                                  WHERE e.job_id = p_job_id AND e.event_type = 'call.transcript_completed'), '[]'::jsonb));
END $fn$;
COMMENT ON FUNCTION public.context_job_story_writer_input(uuid) IS
 'Story money book (20261028190000), job story text (20261009100000): everything the story writer reads, from one snapshot (STABLE): {version story-writer-input-v2, job_id, as_of, job_status, card (context_job_story(job, now()) with book: context_job_story_book(job, now()), the Money block and job lines from Job Profit), card_hash (context_job_story_full_hash of that card), current {text_id, card_hash, written_at, checked_at} or null, notes (context_job_story_ledger(job, null, now()): the live AI reading with every citation re-checked), transcript_row_ids (the job''s call.transcript_completed rows: their words are never prompt text)}. NULL for an unknown job. Read only. Service role only.';

-- 11. Access: service role only, every function.
DO $grants$
DECLARE f text;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_job_story_book_policy()', 'public.context_job_story_money_words(numeric)',
   'public.context_job_story_money_sig(uuid)', 'public.context_job_story_book(uuid,timestamptz)', 'public.context_job_story_full_hash(jsonb)',
   'public.context_job_story_text_policy()', 'public.context_job_story_text_get(uuid,jsonb,boolean)',
   'public.context_job_story_request(uuid,text,text)', 'public.context_job_story_enqueue_changed(integer)',
   'public.context_job_story_writer_input(uuid)'] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
 END LOOP;
END $grants$;

-- 12. Proof in the same transaction.
DO $verify$
DECLARE x record; live text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_job_story_text_policy()', '27ac61c4fee7d15d3b71356271295eab'),
  ('public.context_job_story_request(uuid,text,text)', '7a75f855aafb50a8821a106ff64ba173'),
  ('public.context_job_story_enqueue_changed(integer)', '6fdbb9442d7184241971f3a96da378bc'),
  ('public.context_job_story_writer_input(uuid)', '13097e3cc7abebfdeabff122bee66e1a'),
  ('public.context_job_story_text_get(uuid,jsonb,boolean)', '3cea9dd6df2d2f00660ccd8438637385')
 ) v(sig, want) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.want THEN
   RAISE EXCEPTION 'context_story_money_book_body_mismatch: % md5 %', x.sig, coalesce(live, '<missing>');
  END IF;
 END LOOP;
 IF public.context_job_story_money_words(1234.5) IS DISTINCT FROM '$1,234.50' OR public.context_job_story_money_words(-12) IS DISTINCT FROM '-$12.00'
    OR public.context_job_story_money_words(0) IS DISTINCT FROM '$0.00' OR public.context_job_story_money_words(NULL) IS NOT NULL THEN
  RAISE EXCEPTION 'context_story_money_book_words_mismatch: dollar figures are not written as the story writes them';
 END IF;
 IF public.context_job_story_full_hash('{"job":{"id":"x","status":"quoted"},"book":{"digest":"a"}}'::jsonb)
    IS NOT DISTINCT FROM public.context_job_story_full_hash('{"job":{"id":"x","status":"quoted"},"book":{"digest":"b"}}'::jsonb) THEN
  RAISE EXCEPTION 'context_story_money_book_hash_mismatch: the book''s digest does not move the freshness hash';
 END IF;
END $verify$;
