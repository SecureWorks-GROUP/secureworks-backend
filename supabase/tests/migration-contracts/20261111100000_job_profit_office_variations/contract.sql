-- 20261111100000 (RQ-15.g): an approved office variation (work_order_customer_variations) counts in Job Profit as an
-- agreed variation: its customer price on the job's revenue events and agreed variations, the margin held until the
-- invoices cover it, its trade allocation in the new expected-with-variations columns, and the quote's own figures
-- unchanged. A draft or cancelled one counts nowhere. Synthetic jobs through the real views; every expected figure
-- is worked out by hand from the fixture. All fixture writes roll back. Self-run checks (Claude), no production.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL TimeZone = 'UTC';
CREATE TEMP TABLE rq15g_checks(name text, passed boolean);
CREATE FUNCTION pg_temp.prove(n text, p boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  IF p IS DISTINCT FROM true THEN RAISE EXCEPTION 'RQ-15.g office variations: %', n; END IF;
  INSERT INTO rq15g_checks VALUES (n, p);
END $$;

INSERT INTO public.users (id, org_id, name, role) VALUES
  ('d15a0000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'ZZTEST Scope Checker', 'admin')
ON CONFLICT (id) DO NOTHING;
UPDATE public.work_order_settings
   SET approver_user_ids = approver_user_ids || 'd15a0000-0000-4000-8000-000000000001'::uuid WHERE id = 1;

-- Three accepted fencing jobs, each quoted 1,200 ex GST (labour 500, materials 700, commission 0), invoiced
-- 1,200 ex, labour 500 and materials 600 placed, and an approved job work order.
--   RQ15G-1: office variations approved (300 price, 120 trade), draft (500, 200) and cancelled (700, 300)
--   RQ15G-2: none (the control)
--   RQ15G-3: one approved office variation (200, 80) beside an old-style job variation with no cost figure
INSERT INTO public.jobs (id, org_id, status, type, job_number, legacy, metadata, pricing_json, expected_costs, created_at)
SELECT ('d15b0000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing',
       'ZZTEST-SE-20261111-0' || n, false, '{}', '{}',
       '{"lanes": {"labour": {"amount_ex_gst": 500}, "materials": {"amount_ex_gst": 700}, "commission": {"amount_ex_gst": 0}}}'::jsonb,
       timestamptz '2026-08-01T00:00:00Z'
FROM generate_series(1, 3) n;
INSERT INTO public.job_documents (id, job_id, type, sent_at, accepted_at, created_at)
SELECT ('d15c0000-0000-4000-8000-00000000000' || n)::uuid, ('d15b0000-0000-4000-8000-00000000000' || n)::uuid, 'quote',
       timestamptz '2026-07-20T00:00:00Z', timestamptz '2026-07-22T00:00:00Z', timestamptz '2026-07-20T00:00:00Z'
FROM generate_series(1, 3) n;
INSERT INTO public.quote_revisions (job_id, job_document_id, version, sent_at, released_via, totals_snapshot_json, internal_cost_snapshot_json)
SELECT ('d15b0000-0000-4000-8000-00000000000' || n)::uuid, ('d15c0000-0000-4000-8000-00000000000' || n)::uuid, 1,
       timestamptz '2026-07-20T00:00:00Z', 'send-quote/send', '{"total_inc_gst": 1320, "total_ex_gst": 1200}'::jsonb,
       '{"cost_estimates": {"labour_total": 500, "material_total": 700, "subcontract_commission_total": 0}}'::jsonb
FROM generate_series(1, 3) n;
INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, line_items, raw_json, job_id)
SELECT '00000000-0000-0000-0000-000000000001', 'RQ15G-S-' || n, 'INV-RQ15G-' || n, 'ACCREC', 'AUTHORISED', 'ZZTEST Scope Checker',
       1200, 1320, date '2026-08-25',
       '[{"Description": "Fence", "AccountCode": "200", "LineAmount": 1200, "TaxAmount": 120}]'::jsonb,
       '{"LineAmountTypes": "Exclusive"}'::jsonb, ('d15b0000-0000-4000-8000-00000000000' || n)::uuid
FROM generate_series(1, 3) n;
INSERT INTO public.job_materials_facts (job_id, xero_invoice_id, invoice_number, contact_name, lane, kind, amount_ex_gst, confidence, fact_date, automation_source)
SELECT ('d15b0000-0000-4000-8000-00000000000' || n)::uuid, 'RQ15G-' || l.lane || '-' || n, 'B-RQ15G-' || l.lane || '-' || n,
       'ZZTEST Supplier', l.lane, 'actual', l.amt, 'high', date '2026-08-20', 'manual_queue'
FROM generate_series(1, 3) n, (VALUES ('labour', 500), ('materials', 600)) l(lane, amt);
INSERT INTO public.job_variations (id, job_id, variation_number, description, amount, gst_included, status, accepted_at, cost_estimate, created_at) VALUES
  ('d15d0000-0000-4000-8000-000000000003', 'd15b0000-0000-4000-8000-000000000003', 1, 'Old-style extra', 330, true, 'accepted',
   timestamptz '2026-08-02T00:00:00Z', NULL, timestamptz '2026-08-02T00:00:00Z');

DO $fx$
DECLARE
  approver constant uuid := 'd15a0000-0000-4000-8000-000000000001';
  org constant uuid := '00000000-0000-0000-0000-000000000001';
  j uuid; wo uuid; v uuid; n int;
BEGIN
  FOR n IN 1..3 LOOP
    j := ('d15b0000-0000-4000-8000-00000000000' || n)::uuid;
    wo := (SELECT id FROM public.work_orders WHERE job_id = j AND kind = 'job');
    IF wo IS NULL THEN wo := public.ensure_job_work_order_draft(j, 'manual'); END IF;
    UPDATE public.work_orders SET agreed_labour_ex = 500,
        scope_items = '[{"description":"Synthetic crew labour","qty":1,"unit":"job","price":500}]'
      WHERE id = wo;
    PERFORM public.approve_job_work_order(wo, approver, 'session', (SELECT updated_at FROM public.work_orders WHERE id = wo), org);
  END LOOP;
  -- RQ15G-1: one approved, one left a draft, one cancelled. RQ15G-3: one approved.
  FOR j, n IN VALUES ('d15b0000-0000-4000-8000-000000000001'::uuid, 300), ('d15b0000-0000-4000-8000-000000000001'::uuid, 500),
                     ('d15b0000-0000-4000-8000-000000000001'::uuid, 700), ('d15b0000-0000-4000-8000-000000000003'::uuid, 200) LOOP
    INSERT INTO public.work_order_customer_variations (org_id, job_id, description, tasks, trade_allocation_ex, customer_price_ex, created_by)
    VALUES (org, j, 'Extra ' || n, '[{"description":"Extra works","hours":2}]'::jsonb, round(n * 0.4), n, 'user:' || approver)
    RETURNING id INTO v;
    IF n IN (300, 200) THEN
      PERFORM public.approve_work_order_customer_variation(v, approver, 'session',
        (SELECT updated_at FROM public.work_order_customer_variations WHERE id = v));
    ELSIF n = 700 THEN
      UPDATE public.work_order_customer_variations SET status = 'cancelled', cancelled_by = 'user:' || approver WHERE id = v;
    END IF;
  END LOOP;
END $fx$;

DO $test$
DECLARE
  r record;
  j1 constant uuid := 'd15b0000-0000-4000-8000-000000000001';
  j2 constant uuid := 'd15b0000-0000-4000-8000-000000000002';
  j3 constant uuid := 'd15b0000-0000-4000-8000-000000000003';
  approved uuid := (SELECT id FROM public.work_order_customer_variations WHERE job_id = j1 AND status = 'approved');
BEGIN
  PERFORM pg_temp.prove('an approved office variation is listed once as an agreed variation',
    (SELECT count(*) = 1 AND bool_and(kind = 'variation' AND agreed AND amount_ex = 300 AND NOT counts_as_invoiced
             AND status = 'approved' AND document_id = approved::text AND invoice_date = (SELECT approved_at::date
               FROM public.work_order_customer_variations WHERE id = approved))
       FROM public.v_job_revenue_events WHERE source_id = 'office_variation:' || approved));
  PERFORM pg_temp.prove('a draft or cancelled office variation is not listed',
    (SELECT count(*) FROM public.v_job_revenue_events WHERE job_id = j1 AND source_id LIKE 'office_variation:%') = 1);
  PERFORM pg_temp.prove('the job''s invoice lines are unchanged',
    (SELECT count(*) = 1 AND sum(amount_ex) = 1200 FROM public.v_job_revenue_events WHERE job_id = j1 AND counts_as_invoiced));

  SELECT * INTO r FROM public.v_job_profit WHERE job_id = j1;
  PERFORM pg_temp.prove('the quote''s own figures are unchanged',
    r.quoted_ex = 1200 AND r.expected_labour_ex = 500 AND r.expected_materials_ex = 700 AND r.expected_commission_ex = 0
    AND r.expected_cost_ex = 1200 AND r.expected_source IS NOT NULL AND r.invoiced_ex = 1200);
  PERFORM pg_temp.prove('the approved variation is an agreed variation with its cost figure',
    r.variations_listed_ex = 300 AND NOT ('variation_not_costed' = ANY (r.completeness))
    AND NOT ('variation_invoice_unchecked' = ANY (r.completeness)));
  PERFORM pg_temp.prove('the new columns carry only the approved variation',
    r.office_variations_ex = 300 AND r.office_variation_labour_ex = 120
    AND r.expected_labour_with_variations_ex = 620 AND r.expected_cost_with_variations_ex = 1320);
  PERFORM pg_temp.prove('the margin is held until the invoices cover quote plus variation',
    NOT r.margin_ok AND r.profit_ex IS NULL
    AND 'variation_not_invoiced' = ANY (r.completeness));

  SELECT * INTO r FROM public.v_job_profit WHERE job_id = j2;
  PERFORM pg_temp.prove('a job with no office variation reads as before, zero added',
    r.variations_listed_ex = 0 AND NOT ('variation_not_invoiced' = ANY (r.completeness)) AND r.office_variations_ex = 0 AND r.office_variation_labour_ex = 0
    AND r.expected_labour_with_variations_ex = r.expected_labour_ex AND r.expected_cost_with_variations_ex = r.expected_cost_ex
    AND r.margin_ok AND r.profit_ex = 100);

  SELECT * INTO r FROM public.v_job_profit WHERE job_id = j3;
  PERFORM pg_temp.prove('an old-style job variation still counts, and only it can be not costed',
    r.variations_listed_ex = 500 AND 'variation_not_costed' = ANY (r.completeness)
    AND 'variation_not_invoiced' = ANY (r.completeness)
    AND r.office_variations_ex = 200 AND r.office_variation_labour_ex = 80);
  PERFORM pg_temp.prove('job_profit(uuid) returns the same row with the new columns',
    (SELECT office_variations_ex = 200 FROM public.job_profit(j3)));

  -- The variation invoiced: the job's invoices now cover 1,200 + 300, so the margin shows (1,500 - 1,100).
  INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, line_items, raw_json, job_id)
  VALUES ('00000000-0000-0000-0000-000000000001', 'RQ15G-V-1', 'INV-RQ15G-V1', 'ACCREC', 'AUTHORISED', 'ZZTEST Scope Checker',
          300, 330, date '2026-08-28', '[{"Description": "Work order variation 1", "AccountCode": "200", "LineAmount": 300, "TaxAmount": 30}]'::jsonb,
          '{"LineAmountTypes": "Exclusive"}'::jsonb, j1);
  SELECT * INTO r FROM public.v_job_profit WHERE job_id = j1;
  PERFORM pg_temp.prove('once invoiced, the hold clears and profit is invoiced less actual cost',
    NOT ('variation_not_invoiced' = ANY (r.completeness)) AND r.margin_ok AND r.invoiced_ex = 1500 AND r.profit_ex = 400 AND r.office_variations_ex = 300);
END $test$;
SELECT jsonb_build_object('checks', count(*), 'passed', count(*) FILTER (WHERE passed)) AS result FROM rq15g_checks;
ROLLBACK;
