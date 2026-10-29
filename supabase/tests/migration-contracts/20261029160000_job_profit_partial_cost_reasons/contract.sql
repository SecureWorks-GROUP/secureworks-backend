-- Contract for 20261029160000_job_profit_partial_cost_reasons (TP-13).
--
-- Synthetic jobs, no customer data. Everything rolls back. A blind sample of
-- 21 finished fencing jobs, each invoiced (2,000 ex unless named), with labour
-- 500 and materials 600 placed (a person placed both), and an expected cost
-- frozen at acceptance of labour 500, materials 700, commission 0. The answer
-- key (tp13_key) is written from how each job was built, never read off the
-- view: which jobs are partial (a bill or an invoice is still missing), the
-- reason the engine must name, whether it may publish a margin under the
-- policy as shipped, and the profit it must publish when it may.
--
--   TP13-01  complete                                  margin 900
--   TP13-02  materials 500 of 700 (71%, above 70%)     margin 1,000
--   TP13-03  priced order, delivery 10 days ago        open_purchase_orders, margin shown
--   TP13-04  quote 1,200 + variation 300, invoiced 2,000 (covered)   margin 900
--   TP13-05  completed 5 days ago, no labour           no_labour_linked, not overdue
--   TP13-06  quote 1,200 + variation 300, invoiced 1,500 (covered)   margin 400
--   TP13-11  materials 300 of 700 (43%)                materials_below_quote (holds; warns under its switch)
--   TP13-12  priced order, delivery 45 days ago        po_no_bill_overdue (warns)
--   TP13-13  unpriced order sent 45 days ago           ordered_not_billed_over_30_days (warns)
--   TP13-14  supplier invoice emailed 40 days ago      po_no_bill_overdue (warns)
--   TP13-15  completed 20 days ago, no labour          work_done_no_labour_overdue
--   TP13-16  signed off (office waiver) 20 days ago, no labour  work_done_no_labour_overdue
--   TP13-17  Xero Project 2,000 against 1,100 placed   xero_project_exceeds_line_costs
--   TP13-18  variation accepted, no cost figure        variation_not_costed (warns)
--   TP13-19  quote 1,200 + variation 300, invoiced 1,200   variation_not_invoiced (holds)
--   TP13-20  variation status 'invoiced', no quote     variation_invoice_unchecked (warns)
--   TP13-21  no materials placed                       materials_not_linked (existing)
--   TP13-22  expected cost with no commission lane     expected_cost_lane_missing, margin 900
--   TP13-23  variation costed at 0, quote covers it    margin 900 (0 is a cost figure)
--   TP13-24  priced order, no delivery day, created 29 Perth days ago at 01:00 Perth
--            (30 days by the UTC day): not overdue     open_purchase_orders, margin shown
--   TP13-25  the same, created 30 Perth days ago       po_no_bill_overdue
--
-- Dated cases sit at 5, 10, 20, 40 and 45 days from the run, well clear of
-- the 14 and 30 day limits, and the two Perth-day cases are built from the
-- Perth day of the run itself; no fixture date is compared with a recorded
-- one, so no assertion depends on the day or hour it runs.

\set ON_ERROR_STOP on

BEGIN;
-- The session zone is UTC, so a session-day reading of an order would differ
-- from its Perth day (TP13-24).
SET LOCAL TimeZone = 'UTC';

INSERT INTO public.jobs (id, org_id, status, type, job_number, legacy, metadata, pricing_json, expected_costs, created_at)
SELECT ('d1300000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, '00000000-0000-0000-0000-000000000001',
       'complete', 'fencing', 'TP13-' || lpad(n::text, 2, '0'), false, '{}', '{}',
       CASE WHEN n = 22 THEN '{"lanes": {"labour": {"amount_ex_gst": 500}, "materials": {"amount_ex_gst": 700}}}'::jsonb
            ELSE '{"lanes": {"labour": {"amount_ex_gst": 500}, "materials": {"amount_ex_gst": 700}, "commission": {"amount_ex_gst": 0}}}'::jsonb END,
       timestamptz '2026-08-01T00:00:00Z'
FROM unnest(ARRAY[1, 2, 3, 4, 5, 6, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]) n;

INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, line_items, raw_json, job_id)
SELECT '00000000-0000-0000-0000-000000000001', 'TP13-S-' || j.k, 'INV-TP13-' || j.k, 'ACCREC', 'AUTHORISED', 'TP13 Customer',
       j.ex, j.ex * 1.1, date '2026-08-25',
       jsonb_build_array(jsonb_build_object('Description', 'Fence', 'AccountCode', '200', 'LineAmount', j.ex, 'TaxAmount', j.ex * 0.1)),
       '{"LineAmountTypes": "Exclusive"}'::jsonb, j.id
FROM (SELECT id, right(job_number, 2) AS k,
             CASE job_number WHEN 'TP13-06' THEN 1500 WHEN 'TP13-19' THEN 1200 ELSE 2000 END::numeric AS ex
      FROM public.jobs WHERE job_number LIKE 'TP13-%') j;

-- Placed by a person (manual_queue): labour 500 and materials 600 unless named.
INSERT INTO public.job_materials_facts (job_id, xero_invoice_id, invoice_number, contact_name, lane, kind, amount_ex_gst, confidence, fact_date, automation_source)
SELECT j.id, 'TP13-L-' || right(j.job_number, 2), 'BL-TP13-' || right(j.job_number, 2), 'TP13 Installer', 'labour', 'actual', 500, 'high', date '2026-08-20', 'manual_queue'
FROM public.jobs j WHERE j.job_number LIKE 'TP13-%' AND j.job_number NOT IN ('TP13-05', 'TP13-15', 'TP13-16')
UNION ALL
SELECT j.id, 'TP13-M-' || right(j.job_number, 2), 'BM-TP13-' || right(j.job_number, 2), 'TP13 Steel', 'materials', 'actual',
       CASE j.job_number WHEN 'TP13-02' THEN 500 WHEN 'TP13-11' THEN 300 ELSE 600 END, 'high', date '2026-08-20', 'manual_queue'
FROM public.jobs j WHERE j.job_number LIKE 'TP13-%' AND j.job_number <> 'TP13-21';

-- Orders (12, 13, 14, 25) and the not-yet-overdue controls (03, 24).
INSERT INTO public.purchase_orders (id, org_id, job_id, po_number, supplier_name, source, status, subtotal, total, delivery_date, created_at, last_sent_at, invoice_received_at) VALUES
  ('d1310000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'd1300000-0000-4000-8000-000000000003', 'PO-TP13-03', 'TP13 Timber', NULL, 'sent', 100, 110,
   ((now() AT TIME ZONE 'Australia/Perth')::date - 10), now() - interval '12 days', now() - interval '12 days', NULL),
  ('d1310000-0000-4000-8000-000000000012', '00000000-0000-0000-0000-000000000001', 'd1300000-0000-4000-8000-000000000012', 'PO-TP13-12', 'TP13 Timber', NULL, 'sent', 100, 110,
   ((now() AT TIME ZONE 'Australia/Perth')::date - 45), now() - interval '50 days', now() - interval '50 days', NULL),
  ('d1310000-0000-4000-8000-000000000013', '00000000-0000-0000-0000-000000000001', 'd1300000-0000-4000-8000-000000000013', 'PO-TP13-13', 'TP13 Timber', NULL, 'sent', 0, 0,
   NULL, now() - interval '45 days', now() - interval '45 days', NULL),
  ('d1310000-0000-4000-8000-000000000014', '00000000-0000-0000-0000-000000000001', 'd1300000-0000-4000-8000-000000000014', 'PO-TP13-14', 'TP13 Timber', NULL, 'confirmed', 100, 110,
   NULL, now() - interval '60 days', now() - interval '60 days', now() - interval '40 days'),
  -- 01:00 in Perth is 17:00 UTC the day before: 29 Perth days old, 30 by the UTC day
  ('d1310000-0000-4000-8000-000000000024', '00000000-0000-0000-0000-000000000001', 'd1300000-0000-4000-8000-000000000024', 'PO-TP13-24', 'TP13 Timber', NULL, 'sent', 100, 110,
   NULL, (((now() AT TIME ZONE 'Australia/Perth')::date - 29) + time '01:00') AT TIME ZONE 'Australia/Perth', NULL, NULL),
  ('d1310000-0000-4000-8000-000000000025', '00000000-0000-0000-0000-000000000001', 'd1300000-0000-4000-8000-000000000025', 'PO-TP13-25', 'TP13 Timber', NULL, 'sent', 100, 110,
   NULL, (((now() AT TIME ZONE 'Australia/Perth')::date - 30) + time '01:00') AT TIME ZONE 'Australia/Perth', NULL, NULL);

-- Work done: completion (05, 15) and a client sign-off (16).
UPDATE public.jobs SET completed_at = now() - interval '5 days' WHERE job_number = 'TP13-05';
UPDATE public.jobs SET completed_at = now() - interval '20 days' WHERE job_number = 'TP13-15';
INSERT INTO public.job_client_signoffs (job_id, method, waiver_reason, captured_by_actor, created_at) VALUES
  ('d1300000-0000-4000-8000-000000000016', 'office_waiver', 'Customer away, office signed', 'contract@test', now() - interval '20 days');

-- Xero Project (17): named with the job number, more than the costs placed.
INSERT INTO public.xero_projects (job_id, project_name, total_expenses, total_invoiced) VALUES
  ('d1300000-0000-4000-8000-000000000017', 'TP13-17 Fence Rd', 2000, 2200);

-- Sent quotes (04, 06, 19, 23): 1,320 inc GST, 1,200 ex.
INSERT INTO public.job_documents (id, job_id, type, sent_at, accepted_at, created_at)
SELECT ('d1320000-0000-4000-8000-0000000000' || n)::uuid, ('d1300000-0000-4000-8000-0000000000' || n)::uuid, 'quote',
       timestamptz '2026-07-20T00:00:00Z', timestamptz '2026-07-22T00:00:00Z', timestamptz '2026-07-20T00:00:00Z'
FROM unnest(ARRAY['04', '06', '19', '23']) n;
INSERT INTO public.quote_revisions (job_id, job_document_id, version, sent_at, released_via, totals_snapshot_json, internal_cost_snapshot_json)
SELECT ('d1300000-0000-4000-8000-0000000000' || n)::uuid, ('d1320000-0000-4000-8000-0000000000' || n)::uuid, 1, timestamptz '2026-07-20T00:00:00Z', 'send-quote/send',
       '{"total_inc_gst": 1320, "total_ex_gst": 1200}'::jsonb, '{"cost_estimates": {"labour_total": 500, "material_total": 700, "subcontract_commission_total": 0}}'::jsonb
FROM unnest(ARRAY['04', '06', '19', '23']) n;

-- Variations: 330 inc GST (300 ex) each.
INSERT INTO public.job_variations (id, job_id, variation_number, description, amount, gst_included, status, accepted_at, cost_estimate, created_at) VALUES
  ('d1330000-0000-4000-8000-000000000004', 'd1300000-0000-4000-8000-000000000004', 1, 'Extra panel', 330, true, 'accepted', '2026-08-10T00:00:00Z', 100, '2026-08-09T00:00:00Z'),
  ('d1330000-0000-4000-8000-000000000006', 'd1300000-0000-4000-8000-000000000006', 1, 'Extra panel', 330, true, 'accepted', '2026-08-10T00:00:00Z', 100, '2026-08-09T00:00:00Z'),
  ('d1330000-0000-4000-8000-000000000018', 'd1300000-0000-4000-8000-000000000018', 1, 'Extra panel', 330, true, 'accepted', '2026-08-10T00:00:00Z', NULL, '2026-08-09T00:00:00Z'),
  ('d1330000-0000-4000-8000-000000000019', 'd1300000-0000-4000-8000-000000000019', 1, 'Extra panel', 330, true, 'accepted', '2026-08-10T00:00:00Z', 100, '2026-08-09T00:00:00Z'),
  ('d1330000-0000-4000-8000-000000000020', 'd1300000-0000-4000-8000-000000000020', 1, 'Extra panel', 330, true, 'invoiced', NULL, 100, '2026-08-09T00:00:00Z'),
  ('d1330000-0000-4000-8000-000000000023', 'd1300000-0000-4000-8000-000000000023', 1, 'Extra panel', 330, true, 'accepted', '2026-08-10T00:00:00Z', 0, '2026-08-09T00:00:00Z'),
  -- a declined variation flags nothing
  ('d1330000-0000-4000-8000-000000000101', 'd1300000-0000-4000-8000-000000000001', 1, 'Gate', 550, true, 'declined', NULL, NULL, '2026-08-09T00:00:00Z');
UPDATE public.job_variations SET declined_at = '2026-08-11T00:00:00Z' WHERE id = 'd1330000-0000-4000-8000-000000000101';

-- ── The answer key (the policy as shipped) ────────────────────────────────
CREATE TEMP TABLE tp13_key (job_number text PRIMARY KEY, partial boolean, want_reason text, want_margin boolean,
                            want_cost_flag text, want_profit numeric) ON COMMIT DROP;
INSERT INTO tp13_key VALUES
  ('TP13-01', false, NULL,                              true,  'ok', 900),
  ('TP13-02', false, NULL,                              true,  'ok', 1000),
  ('TP13-03', true,  'open_purchase_orders',            true,  'ok', 900),
  ('TP13-04', false, NULL,                              true,  'ok', 900),
  ('TP13-05', true,  'no_labour_linked',                false, 'no_labour_linked', NULL),
  ('TP13-06', false, NULL,                              true,  'ok', 400),
  ('TP13-11', true,  'materials_below_quote',           false, 'materials_below_quote', NULL),
  ('TP13-12', true,  'po_no_bill_overdue',              true,  'ok', 900),
  ('TP13-13', true,  'ordered_not_billed_over_30_days', true,  'ok', 900),
  ('TP13-14', true,  'po_no_bill_overdue',              true,  'ok', 900),
  ('TP13-15', true,  'work_done_no_labour_overdue',     false, 'no_labour_linked', NULL),
  ('TP13-16', true,  'work_done_no_labour_overdue',     false, 'no_labour_linked', NULL),
  ('TP13-17', true,  'xero_project_exceeds_line_costs', false, 'xero_project_exceeds_line_costs', NULL),
  ('TP13-18', true,  'variation_not_costed',            true,  'ok', 900),
  ('TP13-19', true,  'variation_not_invoiced',          false, 'ok', NULL),
  ('TP13-20', true,  'variation_invoice_unchecked',     true,  'ok', 900),
  ('TP13-21', true,  'materials_not_linked',            false, 'materials_not_linked', NULL),
  ('TP13-22', false, 'expected_cost_lane_missing',      true,  'ok', 900),
  ('TP13-23', false, NULL,                              true,  'ok', 900),
  ('TP13-24', true,  'open_purchase_orders',            true,  'ok', 900),
  ('TP13-25', true,  'po_no_bill_overdue',              true,  'ok', 900);

-- The blind-sample check as a list of problems, so the breaks below can show
-- the same check catching each rule's removal.
CREATE FUNCTION pg_temp.tp13_problems() RETURNS text[] LANGUAGE plpgsql AS $fn$
DECLARE r record; out text[] := '{}';
BEGIN
  FOR r IN
    SELECT k.*, v.completeness, v.margin_ok, v.cost_flag, v.profit_ex, v.margin_pct, v.revenue_flag
    FROM tp13_key k LEFT JOIN public.v_job_profit v USING (job_number) ORDER BY k.job_number
  LOOP
    IF r.want_reason IS NOT NULL AND NOT (r.want_reason = ANY (coalesce(r.completeness, '{}'))) THEN
      out := out || format('%s does not name %s', r.job_number, r.want_reason);
    END IF;
    IF r.partial AND cardinality(coalesce(r.completeness, '{}')) = 0 THEN
      out := out || format('%s is partial and names no reason', r.job_number);
    END IF;
    IF r.margin_ok IS DISTINCT FROM r.want_margin THEN
      out := out || format('%s margin_ok %s, expected %s', r.job_number, r.margin_ok, r.want_margin);
    END IF;
    IF r.cost_flag IS DISTINCT FROM r.want_cost_flag THEN
      out := out || format('%s cost_flag %s, expected %s', r.job_number, r.cost_flag, r.want_cost_flag);
    END IF;
    IF r.profit_ex IS DISTINCT FROM r.want_profit THEN
      out := out || format('%s profit %s, expected %s', r.job_number, r.profit_ex, r.want_profit);
    END IF;
    IF NOT r.want_margin AND r.margin_pct IS NOT NULL THEN
      out := out || format('%s publishes a margin while a cost is missing', r.job_number);
    END IF;
    IF r.revenue_flag IS DISTINCT FROM 'ok' THEN
      out := out || format('%s revenue_flag %s', r.job_number, r.revenue_flag);
    END IF;
    IF NOT r.partial AND r.completeness && ARRAY['materials_below_quote', 'po_no_bill_overdue', 'work_done_no_labour_overdue',
        'variation_not_costed', 'variation_not_invoiced', 'variation_invoice_unchecked', 'ordered_not_billed_over_30_days'] THEN
      out := out || format('%s is complete and carries %s', r.job_number, r.completeness);
    END IF;
  END LOOP;
  RETURN out;
END $fn$;

-- ── The numbers ────────────────────────────────────────────────────────────
DO $$
DECLARE p jsonb := public.job_profit_partial_cost_policy();
BEGIN
  IF p IS DISTINCT FROM '{"version": "tp13-v1", "po_no_bill_days": 30, "work_done_no_labour_days": 14,
       "materials_below_quote_share": 0.7, "variation_cover_tolerance_ex": 1.00,
       "holds_margin": {"materials_below_quote": true, "ordered_not_billed_over_30_days": false, "po_no_bill_overdue": false,
                        "variation_not_costed": false, "variation_not_invoiced": true}}'::jsonb THEN
    RAISE EXCEPTION 'tp13 policy: %', p;
  END IF;
  IF has_function_privilege('anon', 'public.job_profit_partial_cost_policy()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.job_profit_partial_cost_policy()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.job_profit_partial_cost_policy()', 'EXECUTE') THEN
    RAISE EXCEPTION 'tp13 policy: grants are not service role only';
  END IF;
  IF has_table_privilege('anon', 'public.v_job_profit', 'SELECT')
     OR has_table_privilege('authenticated', 'public.v_job_profit', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.v_job_profit', 'SELECT') THEN
    RAISE EXCEPTION 'tp13 grants: v_job_profit is not service role only';
  END IF;
  IF has_function_privilege('anon', 'public.context_job_story_book(uuid,timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.context_job_story_money_sig(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.context_job_story_book(uuid,timestamptz)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.context_job_story_money_sig(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'tp13 grants: the story book functions are not service role only';
  END IF;
END $$;

-- ── Fixture sanity: the sample is built as the key says ───────────────────
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'TP13-19';
  IF r.quoted_ex IS DISTINCT FROM 1200::numeric OR r.variations_listed_ex IS DISTINCT FROM 300::numeric OR r.invoiced_ex <> 1200 THEN
    RAISE EXCEPTION 'tp13 fixture: TP13-19 quoted % variations % invoiced %', r.quoted_ex, r.variations_listed_ex, r.invoiced_ex;
  END IF;
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'TP13-11';
  IF r.actual_materials_ex <> 300 OR r.expected_materials_ex <> 700 OR r.actual_labour_ex <> 500 THEN
    RAISE EXCEPTION 'tp13 fixture: TP13-11 materials % of %, labour %', r.actual_materials_ex, r.expected_materials_ex, r.actual_labour_ex;
  END IF;
  IF (SELECT count(*) FROM public.v_job_profit v JOIN tp13_key k USING (job_number)) <> 21 THEN
    RAISE EXCEPTION 'tp13 fixture: the sample is not 21 jobs';
  END IF;
  -- TP13-24's order is 30 days old by the session's (UTC) day and 29 by Perth's.
  IF (SELECT ((now() AT TIME ZONE 'Australia/Perth')::date - po.created_at::date,
              (now() AT TIME ZONE 'Australia/Perth')::date - (po.created_at AT TIME ZONE 'Australia/Perth')::date)
      FROM public.purchase_orders po WHERE po.po_number = 'PO-TP13-24') IS DISTINCT FROM (30, 29) THEN
    RAISE EXCEPTION 'tp13 fixture: PO-TP13-24 is not 30 UTC days and 29 Perth days old';
  END IF;
END $$;

-- ── The blind sample ───────────────────────────────────────────────────────
-- Every partial job names its reason, and the margin is published exactly
-- when the key allows it, with the profit the key says.
DO $$
DECLARE pr text[] := pg_temp.tp13_problems();
BEGIN
  IF cardinality(pr) > 0 THEN
    RAISE EXCEPTION 'tp13 blind sample: %', array_to_string(pr, '; ');
  END IF;
END $$;

-- ── Exact shapes ───────────────────────────────────────────────────────────
DO $$
DECLARE r record; x record;
BEGIN
  -- Every earlier reason keeps its place; TP-13 codes come after.
  FOR x IN SELECT * FROM (VALUES
    ('TP13-14', ARRAY['invoice_emailed_bill_not_placed', 'po_no_bill_overdue']),
    ('TP13-12', ARRAY['open_purchase_orders', 'po_no_bill_overdue']),
    ('TP13-03', ARRAY['open_purchase_orders']),
    ('TP13-24', ARRAY['open_purchase_orders']),
    ('TP13-25', ARRAY['open_purchase_orders', 'po_no_bill_overdue']),
    ('TP13-05', ARRAY['no_labour_linked']),
    ('TP13-15', ARRAY['no_labour_linked', 'work_done_no_labour_overdue']),
    ('TP13-13', ARRAY['ordered_not_billed', 'ordered_not_billed_over_30_days']),
    ('TP13-18', ARRAY['variation_not_costed', 'variation_invoice_unchecked']),
    ('TP13-19', ARRAY['variation_not_invoiced']),
    ('TP13-20', ARRAY['variation_invoice_unchecked']),
    ('TP13-22', ARRAY['expected_cost_lane_missing']),
    ('TP13-01', ARRAY[]::text[]),
    ('TP13-04', ARRAY[]::text[]),
    ('TP13-06', ARRAY[]::text[]),
    ('TP13-23', ARRAY[]::text[])
  ) v(job_number, want) LOOP
    SELECT completeness INTO r FROM public.v_job_profit WHERE job_number = x.job_number;
    IF r.completeness IS DISTINCT FROM x.want THEN
      RAISE EXCEPTION 'tp13 shape: % completeness %, expected %', x.job_number, r.completeness, x.want;
    END IF;
  END LOOP;
  -- Expected, committed and actual stay apart: no figure moves.
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'TP13-22';
  IF r.expected_cost_ex IS DISTINCT FROM 1200::numeric OR r.expected_commission_ex IS NOT NULL THEN
    RAISE EXCEPTION 'tp13 shape: TP13-22 expected % (commission %)', r.expected_cost_ex, r.expected_commission_ex;
  END IF;
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'TP13-12';
  IF r.committed_open_ex <> 100 OR r.actual_cost_ex <> 1100 OR r.profit_ex_unsuppressed <> 900 THEN
    RAISE EXCEPTION 'tp13 shape: TP13-12 committed % actual % unsuppressed %', r.committed_open_ex, r.actual_cost_ex, r.profit_ex_unsuppressed;
  END IF;
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'TP13-11';
  IF r.actual_cost_ex <> 800 OR r.expected_cost_ex <> 1200 OR r.profit_ex_unsuppressed <> 1200 THEN
    RAISE EXCEPTION 'tp13 shape: TP13-11 actual % expected % unsuppressed %', r.actual_cost_ex, r.expected_cost_ex, r.profit_ex_unsuppressed;
  END IF;
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'TP13-19';
  IF r.profit_ex_unsuppressed <> 100 OR r.variations_listed_ex <> 300 THEN
    RAISE EXCEPTION 'tp13 shape: TP13-19 unsuppressed % variations %', r.profit_ex_unsuppressed, r.variations_listed_ex;
  END IF;
END $$;

-- ── Readers: job_profit(uuid) and the story money book ────────────────────
DO $$
DECLARE r record; b jsonb;
BEGIN
  IF obj_description('public.context_job_story_book(uuid,timestamptz)'::regprocedure, 'pg_proc')
       NOT LIKE 'Story money book (20261028190000), job profit TP-13 (20261029160000):%'
     OR obj_description('public.context_job_story_money_sig(uuid)'::regprocedure, 'pg_proc')
       NOT LIKE 'Story money book (20261028190000), job profit TP-13 (20261029160000):%' THEN
    RAISE EXCEPTION 'tp13: the story book functions do not name both slices first';
  END IF;
  SELECT * INTO r FROM public.job_profit('d1300000-0000-4000-8000-000000000011');
  IF r.cost_flag IS DISTINCT FROM 'materials_below_quote' OR r.profit_ex IS NOT NULL THEN
    RAISE EXCEPTION 'tp13 reader: job_profit(uuid) % %', r.cost_flag, r.profit_ex;
  END IF;
  -- the margin line names the real reason
  b := public.context_job_story_book('d1300000-0000-4000-8000-000000000011');
  IF b ->> 'complete' <> 'false' OR b ->> 'reason' <> 'materials_below_quote'
     OR NOT (b -> 'lines') ? 'Margin: Unknown, because the materials bills placed are well under the materials in the quote, so a bill is probably still to come.' THEN
    RAISE EXCEPTION 'tp13 reader: story book TP13-11 % %', b ->> 'reason', b -> 'lines';
  END IF;
  -- an uninvoiced variation is money not billed, never costs_waiting
  b := public.context_job_story_book('d1300000-0000-4000-8000-000000000019');
  IF b ->> 'complete' <> 'false' OR b ->> 'reason' <> 'variation_not_invoiced'
     OR NOT (b -> 'lines') ? 'Margin: Unknown, because an agreed variation is not covered by the invoices yet.'
     OR b ->> 'incomplete_line' <> 'Money incomplete: an agreed variation is not covered by the invoices yet.' THEN
    RAISE EXCEPTION 'tp13 reader: story book TP13-19 % % %', b ->> 'reason', b -> 'lines', b ->> 'incomplete_line';
  END IF;
  b := public.context_job_story_book('d1300000-0000-4000-8000-000000000001');
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(b -> 'lines') l WHERE l LIKE 'Margin: $900.00 ex GST profit%') THEN
    RAISE EXCEPTION 'tp13 reader: story book lost the complete job''s margin: %', b -> 'lines';
  END IF;
  -- a warning shows the margin on the costs placed so far
  b := public.context_job_story_book('d1300000-0000-4000-8000-000000000012');
  IF NOT (b -> 'lines') ? 'Margin: $900.00 ex GST profit, 45.0% of invoiced, on the costs placed so far.' THEN
    RAISE EXCEPTION 'tp13 reader: story book TP13-12 %', b -> 'lines';
  END IF;
  -- The clock stays out of the words: an order 45 days old reads exactly as
  -- one 10 days old.
  IF public.context_job_story_book('d1300000-0000-4000-8000-000000000012') ->> 'digest'
     IS DISTINCT FROM public.context_job_story_book('d1300000-0000-4000-8000-000000000003') ->> 'digest' THEN
    RAISE EXCEPTION 'tp13 reader: an overdue order changes the story''s words under the policy as shipped';
  END IF;
END $$;

-- ── The money signature: unchanged for a job with no variation ─────────────
-- Kept in settings made before the savepoints, so they outlive each rollback.
SELECT set_config('tp13.sig03', public.context_job_story_money_sig('d1300000-0000-4000-8000-000000000003'), false),
       set_config('tp13.sig12', public.context_job_story_money_sig('d1300000-0000-4000-8000-000000000012'), false),
       set_config('tp13.sig19', public.context_job_story_money_sig('d1300000-0000-4000-8000-000000000019'), false) \gset tp13_
SAVEPOINT tp13_old_sig;
\ir ../../../rollbacks/20261029160000_job_profit_partial_cost_reasons_down.sql
DO $$
BEGIN
  IF public.context_job_story_money_sig('d1300000-0000-4000-8000-000000000003') IS DISTINCT FROM current_setting('tp13.sig03')
     OR public.context_job_story_money_sig('d1300000-0000-4000-8000-000000000012') IS DISTINCT FROM current_setting('tp13.sig12') THEN
    RAISE EXCEPTION 'tp13 money sig: a job with no variation has a new signature';
  END IF;
  IF public.context_job_story_money_sig('d1300000-0000-4000-8000-000000000019') IS NOT DISTINCT FROM current_setting('tp13.sig19') THEN
    RAISE EXCEPTION 'tp13 money sig: a job''s variations are not in its signature';
  END IF;
END $$;
ROLLBACK TO SAVEPOINT tp13_old_sig;
-- an accepted variation moves the signature
DO $$
DECLARE before text := public.context_job_story_money_sig('d1300000-0000-4000-8000-000000000020');
BEGIN
  UPDATE public.job_variations SET status = 'accepted', accepted_at = '2026-08-12T00:00:00Z' WHERE id = 'd1330000-0000-4000-8000-000000000020';
  IF public.context_job_story_money_sig('d1300000-0000-4000-8000-000000000020') IS NOT DISTINCT FROM before THEN
    RAISE EXCEPTION 'tp13 money sig: accepting a variation does not move the signature';
  END IF;
  UPDATE public.job_variations SET status = 'invoiced', accepted_at = NULL WHERE id = 'd1330000-0000-4000-8000-000000000020';
END $$;

-- ── The other way: every check that can hold, holds ───────────────────────
-- What a later migration does to hide the margin instead: change only the
-- policy. The checks then hold, cost_flag and the story name them, and the
-- order checks join the money signature, so the day an order turns overdue
-- wakes the story.
SAVEPOINT tp13_hold_all;
DO $$
DECLARE shipped jsonb := public.job_profit_partial_cost_policy();
BEGIN
  EXECUTE format($f$CREATE OR REPLACE FUNCTION public.job_profit_partial_cost_policy()
    RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $b$ SELECT %L::jsonb $b$ $f$,
    jsonb_set(shipped, '{holds_margin}', '{"materials_below_quote": true, "ordered_not_billed_over_30_days": true, "po_no_bill_overdue": true,
                                          "variation_not_costed": true, "variation_not_invoiced": true}'::jsonb)::text);
END $$;
DO $$
DECLARE r record; x record; b jsonb;
BEGIN
  FOR x IN SELECT * FROM (VALUES
    ('TP13-12', 'po_no_bill_overdue'), ('TP13-14', 'po_no_bill_overdue'), ('TP13-25', 'po_no_bill_overdue'),
    ('TP13-13', 'ordered_not_billed_over_30_days'), ('TP13-18', 'variation_not_costed')
  ) v(job_number, flag) LOOP
    SELECT * INTO r FROM public.v_job_profit WHERE job_number = x.job_number;
    IF r.margin_ok OR r.profit_ex IS NOT NULL OR r.cost_flag IS DISTINCT FROM x.flag THEN
      RAISE EXCEPTION 'tp13 hold: % margin_ok % cost_flag %', x.job_number, r.margin_ok, r.cost_flag;
    END IF;
  END LOOP;
  FOR r IN SELECT v.* FROM public.v_job_profit v WHERE v.job_number IN ('TP13-01', 'TP13-03', 'TP13-20', 'TP13-24') LOOP
    IF NOT r.margin_ok THEN
      RAISE EXCEPTION 'tp13 hold: % lost its margin (% %)', r.job_number, r.cost_flag, r.completeness;
    END IF;
  END LOOP;
  b := public.context_job_story_book('d1300000-0000-4000-8000-000000000012');
  IF b ->> 'reason' <> 'po_no_bill_overdue' OR NOT (b -> 'lines') ? 'Margin: Unknown, because a purchase order is still waiting for its bill.' THEN
    RAISE EXCEPTION 'tp13 hold: story book TP13-12 % %', b ->> 'reason', b -> 'lines';
  END IF;
  b := public.context_job_story_book('d1300000-0000-4000-8000-000000000013');
  IF NOT (b -> 'lines') ? 'Margin: Unknown, because a purchase order sent with no price is still waiting for its bill.' THEN
    RAISE EXCEPTION 'tp13 hold: story book TP13-13 %', b -> 'lines';
  END IF;
  b := public.context_job_story_book('d1300000-0000-4000-8000-000000000018');
  IF NOT (b -> 'lines') ? 'Margin: Unknown, because an agreed variation has no cost figure.' THEN
    RAISE EXCEPTION 'tp13 hold: story book TP13-18 %', b -> 'lines';
  END IF;
  -- the overdue order is in the signature now; the order not yet overdue is not
  IF public.context_job_story_money_sig('d1300000-0000-4000-8000-000000000012') IS NOT DISTINCT FROM current_setting('tp13.sig12') THEN
    RAISE EXCEPTION 'tp13 hold: an overdue order that holds the margin is not in the money signature';
  END IF;
  IF public.context_job_story_money_sig('d1300000-0000-4000-8000-000000000003') IS DISTINCT FROM current_setting('tp13.sig03') THEN
    RAISE EXCEPTION 'tp13 hold: an order not yet overdue moved the money signature';
  END IF;
END $$;
ROLLBACK TO SAVEPOINT tp13_hold_all;

-- And variation_not_invoiced set to warn: the margin shows, the gap is named.
SAVEPOINT tp13_warn_variation;
DO $$
DECLARE shipped jsonb := public.job_profit_partial_cost_policy();
BEGIN
  EXECUTE format($f$CREATE OR REPLACE FUNCTION public.job_profit_partial_cost_policy()
    RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $b$ SELECT %L::jsonb $b$ $f$,
    jsonb_set(shipped, '{holds_margin,variation_not_invoiced}', 'false'::jsonb)::text);
END $$;
DO $$
DECLARE r record; b jsonb;
BEGIN
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'TP13-19';
  IF NOT r.margin_ok OR r.profit_ex IS DISTINCT FROM 100::numeric OR NOT ('variation_not_invoiced' = ANY (r.completeness)) THEN
    RAISE EXCEPTION 'tp13 warn: TP13-19 margin_ok % profit % completeness %', r.margin_ok, r.profit_ex, r.completeness;
  END IF;
  b := public.context_job_story_book('d1300000-0000-4000-8000-000000000019');
  IF b ->> 'incomplete_line' <> 'Money incomplete: an agreed variation is not covered by the invoices yet.' THEN
    RAISE EXCEPTION 'tp13 warn: story book TP13-19 %', b ->> 'incomplete_line';
  END IF;
END $$;
ROLLBACK TO SAVEPOINT tp13_warn_variation;

-- And materials_below_quote set to warn (materials that really came in under
-- quote): TP13-11 shows its margin on the costs placed, the gap stays named,
-- and every other check is as shipped. The switch is the only thing that
-- moves it: a body that read another switch for it is caught.
SAVEPOINT tp13_warn_materials;
DO $$
DECLARE shipped jsonb := public.job_profit_partial_cost_policy();
BEGIN
  EXECUTE format($f$CREATE OR REPLACE FUNCTION public.job_profit_partial_cost_policy()
    RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $b$ SELECT %L::jsonb $b$ $f$,
    jsonb_set(shipped, '{holds_margin,materials_below_quote}', 'false'::jsonb)::text);
END $$;
CREATE FUNCTION pg_temp.tp13_materials_warn_problems() RETURNS text[] LANGUAGE plpgsql AS $$
DECLARE r record; b jsonb; pr text[] := '{}';
BEGIN
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'TP13-11';
  IF NOT r.margin_ok OR r.profit_ex IS DISTINCT FROM 1200::numeric OR r.cost_flag IS DISTINCT FROM 'ok'
     OR NOT ('materials_below_quote' = ANY (r.completeness)) THEN
    pr := pr || format('TP13-11 under the warn switch: margin_ok %s profit %s cost_flag %s completeness %s',
                       r.margin_ok, r.profit_ex, r.cost_flag, r.completeness);
  END IF;
  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'TP13-19';
  IF r.margin_ok THEN
    pr := pr || 'TP13-19 lost its variation hold under the materials warn switch'::text;
  END IF;
  b := public.context_job_story_book('d1300000-0000-4000-8000-000000000011');
  IF b ->> 'reason' = 'materials_below_quote'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(b -> 'lines') l WHERE l LIKE 'Margin: Unknown%') THEN
    pr := pr || format('TP13-11 story book still withholds the margin: %s', b -> 'lines');
  END IF;
  RETURN pr;
END $$;
DO $$
DECLARE pr text[];
BEGIN
  pr := pg_temp.tp13_materials_warn_problems();
  IF cardinality(pr) > 0 THEN
    RAISE EXCEPTION 'tp13 warn materials: %', array_to_string(pr, '; ');
  END IF;
END $$;
DO $$
DECLARE pr text[]; v_def text := pg_get_viewdef('public.v_job_profit'::regclass);
  v_from text := $s$'holds_margin'::text) ->> 'materials_below_quote'::text)$s$;
BEGIN
  IF (length(v_def) - length(replace(v_def, v_from, ''))) / length(v_from) <> 1 THEN
    RAISE EXCEPTION 'tp13 break: the materials switch is not read exactly once in the view body';
  END IF;
  BEGIN
    EXECUTE 'CREATE OR REPLACE VIEW public.v_job_profit AS '
      || replace(v_def, v_from, $s$'holds_margin'::text) ->> 'variation_not_invoiced'::text)$s$);
    pr := pg_temp.tp13_materials_warn_problems();
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = array_to_string(pr, '; ');
  EXCEPTION WHEN SQLSTATE 'P0099' THEN
    IF cardinality(pr) = 0 OR pr[1] NOT LIKE 'TP13-11 under the warn switch:%' THEN
      RAISE EXCEPTION 'tp13 break: a body that ignores the materials switch was not caught (%)', pr;
    END IF;
  END;
  IF cardinality(pg_temp.tp13_materials_warn_problems()) > 0 THEN
    RAISE EXCEPTION 'tp13 break: the materials switch break leaked';
  END IF;
END $$;
ROLLBACK TO SAVEPOINT tp13_warn_materials;

-- ── Each rule, broken on its own, is caught by the blind sample ───────────
-- The break takes the rule's code out of the live body (every place the view
-- writes it), the way a body that lost the rule would read.
DO $$
DECLARE x record; pr text[]; v_def text := pg_get_viewdef('public.v_job_profit'::regclass);
BEGIN
  FOR x IN SELECT * FROM (VALUES
    ('materials_below_quote', 'TP13-11 does not name materials_below_quote'),
    ('po_no_bill_overdue', 'TP13-12 does not name po_no_bill_overdue'),
    ('work_done_no_labour_overdue', 'TP13-15 does not name work_done_no_labour_overdue'),
    ('variation_not_costed', 'TP13-18 does not name variation_not_costed'),
    ('variation_not_invoiced', 'TP13-19 does not name variation_not_invoiced'),
    ('variation_invoice_unchecked', 'TP13-20 does not name variation_invoice_unchecked'),
    ('expected_cost_lane_missing', 'TP13-22 does not name expected_cost_lane_missing')
  ) v(code, want) LOOP
    IF position(quote_literal(x.code) || '::text' IN v_def) = 0 THEN
      RAISE EXCEPTION 'tp13 break: % is not in the view body', x.code;
    END IF;
    BEGIN
      EXECUTE 'CREATE OR REPLACE VIEW public.v_job_profit AS ' || replace(v_def, quote_literal(x.code) || '::text', 'NULL::text');
      pr := pg_temp.tp13_problems();
      RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = array_to_string(pr, '; ');
    EXCEPTION WHEN SQLSTATE 'P0099' THEN
      IF NOT (x.want = ANY (pr)) THEN
        RAISE EXCEPTION 'tp13 break: without % the sample did not report "%" (it reported %)', x.code, x.want, pr;
      END IF;
    END;
  END LOOP;
  IF cardinality(pg_temp.tp13_problems()) > 0 THEN
    RAISE EXCEPTION 'tp13 break: a break leaked: %', pg_temp.tp13_problems();
  END IF;
END $$;

-- ── The down migration refuses while a later body is live ─────────────────
-- ON_ERROR_ROLLBACK keeps the transaction open past the refused statement, so
-- the refusal's message can be read; the savepoint then drops whatever the
-- rest of the down file did.
\echo 'tp13: the next two ERROR lines are the down migration refusing, as it must'
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
SAVEPOINT tp13_later_view;
COMMENT ON VIEW public.v_job_profit IS 'Job profit engine (20261009130000, CFO-12 20261019120000, JP-12 20261020181800, TP-13 20261029160000, LATER 20261201000000): a later body.';
\ir ../../../rollbacks/20261029160000_job_profit_partial_cost_reasons_down.sql
SELECT :'LAST_ERROR_MESSAGE' AS tp13_down_view_refusal \gset
ROLLBACK TO SAVEPOINT tp13_later_view;
SAVEPOINT tp13_later_book;
CREATE OR REPLACE FUNCTION public.context_job_story_book(p_job_id uuid, p_as_of timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE sql STABLE AS $b$ SELECT NULL::jsonb $b$;
\ir ../../../rollbacks/20261029160000_job_profit_partial_cost_reasons_down.sql
SELECT :'LAST_ERROR_MESSAGE' AS tp13_down_book_refusal \gset
ROLLBACK TO SAVEPOINT tp13_later_book;
\set ON_ERROR_ROLLBACK off
\set ON_ERROR_STOP on
SELECT set_config('tp13.down_view', :'tp13_down_view_refusal', false), set_config('tp13.down_book', :'tp13_down_book_refusal', false) \gset tp13_
DO $$
BEGIN
  IF current_setting('tp13.down_view') NOT LIKE 'tp13 down: the live v_job_profit is not TP-13''s%' THEN
    RAISE EXCEPTION 'tp13 down: ran over a later v_job_profit (last error: %)', current_setting('tp13.down_view');
  END IF;
  IF current_setting('tp13.down_book') NOT LIKE 'tp13 down: public.context_job_story_book(uuid,timestamptz) is not TP-13''s body%' THEN
    RAISE EXCEPTION 'tp13 down: ran over a later story book (last error: %)', current_setting('tp13.down_book');
  END IF;
  IF obj_description('public.v_job_profit'::regclass, 'pg_class') NOT LIKE '%, TP-13 20261029160000): %'
     OR to_regprocedure('public.job_profit_partial_cost_policy()') IS NULL THEN
    RAISE EXCEPTION 'tp13 down: the refusal proof left the database changed';
  END IF;
END $$;

ROLLBACK;
