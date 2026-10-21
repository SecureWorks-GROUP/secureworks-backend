-- Contract for 20261020220000_job_profit_quote_costs_incomplete.
--
-- Synthetic jobs, no customer data. Everything rolls back.
--
--   QC-A  one sent revision, costs to confirm (null totals, costs_complete false)
--         -> quote_costs_incomplete, no expected cost, flag listed
--   QC-B  one sent revision with costs -> not incomplete, expected from it
--   QC-C  no quote at all -> not incomplete (uncosted is a different answer)
--   QC-D  accepted v1 with costs, later re-quote v2 sent with costs to confirm
--         -> the accepted revision stands: not incomplete, expected from v1
--   QC-E  expected costs frozen at acceptance, newest sent revision incomplete
--         -> frozen wins: not incomplete
--   QC-F  sent v1 with costs, newer sent v2 with costs to confirm -> v2 stands:
--         incomplete, and v1's figures are NOT used as the expected cost
--   QC-G  newest accepted revision has costs to confirm and was never sent; an
--         older costed revision was sent -> the engine reads the sent revision
--         (expected 200), so not incomplete (pins the "nothing fixed" terms)
--   QC-H  older accepted document costed, newer accepted document with costs
--         to confirm, neither sent -> the newer stands: incomplete, no expected
--         cost, the older figures are NOT used
--   QC-I  one accepted document, v2 with costs to confirm sent first, v1 with
--         no costs (zero) sent later -> v2 stands, by version as accepted_rev
--         orders, so incomplete (an order by send time would pick v1 and miss it)

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.jobs (id, org_id, status, type, job_number, legacy, metadata, pricing_json, expected_costs, created_at) VALUES
  ('a7d00000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'QC-A', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z'),
  ('a7d00000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'QC-B', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z'),
  ('a7d00000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'draft', 'fencing', 'QC-C', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z'),
  ('a7d00000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000001', 'accepted', 'patio', 'QC-D', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z'),
  ('a7d00000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'QC-E', false, '{}', '{}',
   '{"lanes": {"labour": {"amount_ex_gst": 300}, "materials": {"amount_ex_gst": 400}, "commission": {"amount_ex_gst": 0}}}', '2026-07-01T00:00:00Z'),
  ('a7d00000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'QC-F', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z'),
  ('a7d00000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'QC-G', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z'),
  ('a7d00000-0000-4000-8000-000000000008', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'QC-H', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z'),
  ('a7d00000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'QC-I', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z');

INSERT INTO public.job_documents (id, job_id, type, sent_at, accepted_at, created_at) VALUES
  ('a7d30000-0000-4000-8000-000000000001', 'a7d00000-0000-4000-8000-000000000001', 'quote', '2026-07-20T00:00:00Z', NULL, '2026-07-20T00:00:00Z'),
  ('a7d30000-0000-4000-8000-000000000002', 'a7d00000-0000-4000-8000-000000000002', 'quote', '2026-07-20T00:00:00Z', NULL, '2026-07-20T00:00:00Z'),
  ('a7d30000-0000-4000-8000-000000000004', 'a7d00000-0000-4000-8000-000000000004', 'quote', '2026-07-20T00:00:00Z', '2026-07-22T00:00:00Z', '2026-07-20T00:00:00Z'),
  ('a7d30000-0000-4000-8000-000000000041', 'a7d00000-0000-4000-8000-000000000004', 'quote', '2026-07-25T00:00:00Z', NULL, '2026-07-25T00:00:00Z'),
  ('a7d30000-0000-4000-8000-000000000005', 'a7d00000-0000-4000-8000-000000000005', 'quote', '2026-07-25T00:00:00Z', NULL, '2026-07-25T00:00:00Z'),
  ('a7d30000-0000-4000-8000-000000000006', 'a7d00000-0000-4000-8000-000000000006', 'quote', '2026-07-18T00:00:00Z', NULL, '2026-07-18T00:00:00Z'),
  ('a7d30000-0000-4000-8000-000000000061', 'a7d00000-0000-4000-8000-000000000006', 'quote', '2026-07-20T00:00:00Z', NULL, '2026-07-20T00:00:00Z'),
  ('a7d30000-0000-4000-8000-000000000007', 'a7d00000-0000-4000-8000-000000000007', 'quote', '2026-07-18T00:00:00Z', NULL, '2026-07-18T00:00:00Z'),
  ('a7d30000-0000-4000-8000-000000000071', 'a7d00000-0000-4000-8000-000000000007', 'quote', NULL, '2026-07-22T00:00:00Z', '2026-07-21T00:00:00Z'),
  ('a7d30000-0000-4000-8000-000000000008', 'a7d00000-0000-4000-8000-000000000008', 'quote', NULL, '2026-07-20T00:00:00Z', '2026-07-19T00:00:00Z'),
  ('a7d30000-0000-4000-8000-000000000081', 'a7d00000-0000-4000-8000-000000000008', 'quote', NULL, '2026-07-24T00:00:00Z', '2026-07-23T00:00:00Z'),
  ('a7d30000-0000-4000-8000-000000000009', 'a7d00000-0000-4000-8000-000000000009', 'quote', '2026-07-21T00:00:00Z', '2026-07-26T00:00:00Z', '2026-07-20T00:00:00Z');

INSERT INTO public.quote_revisions (job_id, job_document_id, version, sent_at, released_via, totals_snapshot_json, internal_cost_snapshot_json) VALUES
  ('a7d00000-0000-4000-8000-000000000001', 'a7d30000-0000-4000-8000-000000000001', 1, '2026-07-20T00:00:00Z', 'send-quote/send', '{"total_inc_gst": 1320, "total_ex_gst": 1200}',
   '{"cost_estimates": {"labour_total": null, "material_total": null, "subcontract_commission_total": null, "costs_complete": false, "costs_to_confirm": ["CT post"]}}'),
  ('a7d00000-0000-4000-8000-000000000002', 'a7d30000-0000-4000-8000-000000000002', 1, '2026-07-20T00:00:00Z', 'send-quote/send', '{"total_inc_gst": 1320, "total_ex_gst": 1200}',
   '{"cost_estimates": {"labour_total": 400, "material_total": 500, "subcontract_commission_total": 0}}'),
  ('a7d00000-0000-4000-8000-000000000004', 'a7d30000-0000-4000-8000-000000000004', 1, '2026-07-20T00:00:00Z', 'send-quote/send', '{"total_inc_gst": 1320, "total_ex_gst": 1200}',
   '{"cost_estimates": {"labour_total": 250, "material_total": 350, "subcontract_commission_total": 0}}'),
  ('a7d00000-0000-4000-8000-000000000004', 'a7d30000-0000-4000-8000-000000000041', 2, '2026-07-25T00:00:00Z', 'send-quote/send', '{"total_inc_gst": 1650, "total_ex_gst": 1500}',
   '{"cost_estimates": {"labour_total": null, "material_total": null, "subcontract_commission_total": null, "costs_complete": false}}'),
  ('a7d00000-0000-4000-8000-000000000005', 'a7d30000-0000-4000-8000-000000000005', 1, '2026-07-25T00:00:00Z', 'send-quote/send', '{"total_inc_gst": 1650, "total_ex_gst": 1500}',
   '{"cost_estimates": {"labour_total": null, "material_total": null, "subcontract_commission_total": null, "costs_complete": false}}'),
  ('a7d00000-0000-4000-8000-000000000006', 'a7d30000-0000-4000-8000-000000000006', 1, '2026-07-18T00:00:00Z', 'send-quote/send', '{"total_inc_gst": 880, "total_ex_gst": 800}',
   '{"cost_estimates": {"labour_total": 200, "material_total": 150, "subcontract_commission_total": 0}}'),
  ('a7d00000-0000-4000-8000-000000000006', 'a7d30000-0000-4000-8000-000000000061', 2, '2026-07-20T00:00:00Z', 'send-quote/send', '{"total_inc_gst": 990, "total_ex_gst": 900}',
   '{"cost_estimates": {"labour_total": null, "material_total": null, "subcontract_commission_total": null, "costs_complete": false}}'),
  ('a7d00000-0000-4000-8000-000000000007', 'a7d30000-0000-4000-8000-000000000007', 1, '2026-07-18T00:00:00Z', 'send-quote/send', '{"total_inc_gst": 440, "total_ex_gst": 400}',
   '{"cost_estimates": {"labour_total": 100, "material_total": 100, "subcontract_commission_total": 0}}'),
  ('a7d00000-0000-4000-8000-000000000007', 'a7d30000-0000-4000-8000-000000000071', 2, NULL, 'send-quote/send', '{"total_inc_gst": 550, "total_ex_gst": 500}',
   '{"cost_estimates": {"labour_total": null, "material_total": null, "subcontract_commission_total": null, "costs_complete": false}}'),
  ('a7d00000-0000-4000-8000-000000000008', 'a7d30000-0000-4000-8000-000000000008', 1, NULL, 'send-quote/send', '{"total_inc_gst": 440, "total_ex_gst": 400}',
   '{"cost_estimates": {"labour_total": 150, "material_total": 150, "subcontract_commission_total": 0}}'),
  ('a7d00000-0000-4000-8000-000000000008', 'a7d30000-0000-4000-8000-000000000081', 2, NULL, 'send-quote/send', '{"total_inc_gst": 550, "total_ex_gst": 500}',
   '{"cost_estimates": {"labour_total": null, "material_total": null, "subcontract_commission_total": null, "costs_complete": false}}'),
  ('a7d00000-0000-4000-8000-000000000009', 'a7d30000-0000-4000-8000-000000000009', 2, '2026-07-21T00:00:00Z', 'send-quote/send', '{"total_inc_gst": 550, "total_ex_gst": 500}',
   '{"cost_estimates": {"labour_total": null, "material_total": null, "subcontract_commission_total": null, "costs_complete": false}}'),
  ('a7d00000-0000-4000-8000-000000000009', 'a7d30000-0000-4000-8000-000000000009', 1, '2026-07-25T00:00:00Z', 'send-quote/send', '{"total_inc_gst": 440, "total_ex_gst": 400}',
   '{"cost_estimates": {"labour_total": 0, "material_total": 0, "subcontract_commission_total": 0}}');

DO $$
DECLARE
  r record;
  last_col text;
BEGIN
  SELECT column_name INTO last_col FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'v_job_profit'
   ORDER BY ordinal_position DESC LIMIT 1;
  -- This migration alone ends on quote_costs_incomplete. 20261021180000
  -- appends four columns after it and does not rewrite this view.
  IF last_col = 'quote_costs_incomplete' THEN
    NULL;
  ELSIF last_col = 'work_order_agreed_labour_ex' THEN
    IF (
      SELECT string_agg(column_name, ',' ORDER BY ordinal_position)
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'v_job_profit'
         AND ordinal_position > (
           SELECT ordinal_position FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'v_job_profit'
              AND column_name = 'quote_costs_incomplete'
         )
    ) IS DISTINCT FROM 'margin_source,margin_cost_ex,expected_labour_quote_ex,work_order_agreed_labour_ex' THEN
      RAISE EXCEPTION 'columns after quote_costs_incomplete are not the four appended job-profit columns';
    END IF;
  ELSE
    RAISE EXCEPTION 'quote_costs_incomplete is not the appended last column (last is %)', last_col;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                  AND table_name = 'v_job_profit' AND column_name = 'invoice_emailed_ex') THEN
    RAISE EXCEPTION 'a CFO-12 column was lost';
  END IF;

  FOR r IN
    SELECT job_number, quote_costs_incomplete AS inc, expected_source AS src, expected_cost_ex AS exp,
           ('quote_costs_incomplete' = ANY(completeness)) AS flagged
      FROM public.v_job_profit
     WHERE job_number IN ('QC-A', 'QC-B', 'QC-C', 'QC-D', 'QC-E', 'QC-F', 'QC-G', 'QC-H', 'QC-I')
  LOOP
    IF r.job_number IN ('QC-A', 'QC-F', 'QC-H', 'QC-I') THEN
      IF r.inc IS NOT TRUE OR NOT r.flagged OR r.src IS NOT NULL OR r.exp IS NOT NULL THEN
        RAISE EXCEPTION '%: expected incomplete with no expected cost, got inc=% flagged=% src=% exp=%',
          r.job_number, r.inc, r.flagged, r.src, r.exp;
      END IF;
    ELSE
      IF r.inc IS NOT FALSE OR r.flagged THEN
        RAISE EXCEPTION '%: must not be named incomplete (inc=% flagged=%)', r.job_number, r.inc, r.flagged;
      END IF;
    END IF;
    IF r.job_number = 'QC-B' AND (r.src IS DISTINCT FROM 'sent_quote_revision' OR r.exp IS DISTINCT FROM 900) THEN
      RAISE EXCEPTION 'QC-B expected cost changed: % %', r.src, r.exp;
    END IF;
    IF r.job_number = 'QC-C' AND r.src IS NOT NULL THEN
      RAISE EXCEPTION 'QC-C has an expected source: %', r.src;
    END IF;
    IF r.job_number = 'QC-D' AND (r.src IS DISTINCT FROM 'accepted_quote_revision' OR r.exp IS DISTINCT FROM 600) THEN
      RAISE EXCEPTION 'QC-D must read the accepted revision: % %', r.src, r.exp;
    END IF;
    IF r.job_number = 'QC-G' AND (r.src IS DISTINCT FROM 'sent_quote_revision' OR r.exp IS DISTINCT FROM 200) THEN
      RAISE EXCEPTION 'QC-G must read the sent revision: % %', r.src, r.exp;
    END IF;
    IF r.job_number = 'QC-E' AND (r.src IS DISTINCT FROM 'frozen_at_acceptance' OR r.exp IS DISTINCT FROM 700) THEN
      RAISE EXCEPTION 'QC-E must read the frozen costs: % %', r.src, r.exp;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.v_job_profit WHERE job_number LIKE 'QC-_') <> 9 THEN
    RAISE EXCEPTION 'not every QC job has a row';
  END IF;
  IF has_table_privilege('anon', 'public.v_job_profit', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.v_job_profit', 'SELECT') THEN
    RAISE EXCEPTION 'v_job_profit grants changed';
  END IF;
  PERFORM 1 FROM public.job_profit('a7d00000-0000-4000-8000-000000000001'::uuid);
END $$;

ROLLBACK;
