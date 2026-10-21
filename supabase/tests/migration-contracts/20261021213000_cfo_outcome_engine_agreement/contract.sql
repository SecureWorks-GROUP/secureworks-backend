-- Contract for 20261021213000_cfo_outcome_engine_agreement (job profit H7):
-- the outcome never claims a placement v_job_cost_events does not count.
--
-- Synthetic people, jobs and bills, no customer data. Everything rolls back.
-- Every bill is an ordinary supplier bill (account 310) unless named.
--
--   OE person   public.users cf..a1 (a recorded person).
--   OE-J1, OE-J2  finished fencing jobs.
--   OE-F2     Xero job J1; one labour row on J2 by ops_dashboard. The engine
--             holds it: unknown, labour_part_unconfirmed.
--   OE-F2M    the same with a machine labour row (xero_ref_link): held.
--   OE-F2P    the same row by the person, queue assigned by the person:
--             confirmed, not held.
--   OE-MIX    split 600 materials on J1 by the person + 400 labour on J2 by
--             ops_dashboard: held (the engine counts only the 600).
--   OE-SAME   Xero job J1; a whole labour row on J1 by ops_dashboard. The
--             engine reads the Xero lines and counts it: placed_unconfirmed.
--   OE-MAT    Xero job J1; a materials row on J2 by ops_dashboard. Counted on
--             J2: placed_unconfirmed.
--   OE-OH     Xero job J1, no rows, queue overhead equal to the bill: held,
--             overhead_on_xero_linked_bill (the engine counts it nowhere).
--   OE-OH2    the same with overhead 300 of 1,000: held.
--   OE-XL     Xero job J1, no actual row, an expected-kind row on J2: held,
--             xero_link_not_counted.
--   OE-PLAIN  Xero job J1, no rows, no queue: placed_unconfirmed (machine).
--   OE-NJR    F1 (JP-21): Xero job J1, marked not job related by the person,
--             no rows: confirmed_overhead as before, never held.
--   OE-INST   installer bill (306), Xero job J1, overhead equal to the bill,
--             no rows: installer_unconfirmed as before, never held.
\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.users (id, org_id, name, email) VALUES
  ('cf000000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'OE person', 'oe-person@test');

INSERT INTO public.jobs (id, org_id, status, type, job_number, legacy, metadata, pricing_json, expected_costs, created_at) VALUES
  ('cf000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'OE-J1', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z'),
  ('cf000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'OE-J2', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z');

INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, line_items, raw_json, job_id)
SELECT '00000000-0000-0000-0000-000000000001', b.id, b.id, 'ACCPAY', 'AUTHORISED', 'OE Supplier', b.ex, b.ex * 1.1, '2026-08-27',
       jsonb_build_array(jsonb_build_object('Description', 'Supply', 'AccountCode', b.acct, 'LineAmount', b.ex, 'TaxAmount', b.ex * 0.1)),
       '{"LineAmountTypes": "Exclusive"}', 'cf000000-0000-4000-8000-000000000001'::uuid
FROM (VALUES
  ('OE-F2', 400, '310'), ('OE-F2M', 400, '310'), ('OE-F2P', 400, '310'), ('OE-MIX', 1000, '310'),
  ('OE-SAME', 500, '310'), ('OE-MAT', 400, '310'), ('OE-OH', 1000, '310'), ('OE-OH2', 1000, '310'),
  ('OE-XL', 400, '310'), ('OE-PLAIN', 400, '310'), ('OE-NJR', 400, '310'), ('OE-INST', 1000, '306')
) AS b(id, ex, acct);

INSERT INTO public.materials_reconciliation_queue (xero_invoice_id, invoice_number, contact_name, sub_total, total, invoice_date, status, assigned_by, assigned_at, overhead_ex) VALUES
  ('OE-F2P', 'OE-F2P', 'OE Supplier', 400, 440, '2026-08-27', 'assigned', 'user:cf000000-0000-4000-8000-0000000000a1', '2026-09-01T00:00:00Z', NULL),
  ('OE-MIX', 'OE-MIX', 'OE Supplier', 1000, 1100, '2026-08-27', 'split', 'user:cf000000-0000-4000-8000-0000000000a1', '2026-09-01T00:00:00Z', NULL),
  ('OE-OH', 'OE-OH', 'OE Supplier', 1000, 1100, '2026-08-27', 'split', 'user:cf000000-0000-4000-8000-0000000000a1', '2026-09-01T00:00:00Z', 1000),
  ('OE-OH2', 'OE-OH2', 'OE Supplier', 1000, 1100, '2026-08-27', 'split', 'user:cf000000-0000-4000-8000-0000000000a1', '2026-09-01T00:00:00Z', 300),
  ('OE-NJR', 'OE-NJR', 'OE Supplier', 400, 440, '2026-08-27', 'not_job_related', 'user:cf000000-0000-4000-8000-0000000000a1', '2026-09-01T00:00:00Z', NULL),
  ('OE-INST', 'OE-INST', 'OE Supplier', 1000, 1100, '2026-08-27', 'split', 'user:cf000000-0000-4000-8000-0000000000a1', '2026-09-01T00:00:00Z', 1000);

INSERT INTO public.job_materials_facts (xero_invoice_id, job_id, job_number, lane, kind, amount_ex_gst, confidence, automation_source, fact_date, assigned_by) VALUES
  ('OE-F2', 'cf000000-0000-4000-8000-000000000002', 'OE-J2', 'labour', 'actual', 400, 'high_manual', 'manual_queue', '2026-08-27', 'ops_dashboard'),
  ('OE-F2M', 'cf000000-0000-4000-8000-000000000002', 'OE-J2', 'labour', 'actual', 400, 'high', 'xero_ref_link', '2026-08-27', NULL),
  ('OE-F2P', 'cf000000-0000-4000-8000-000000000002', 'OE-J2', 'labour', 'actual', 400, 'high_manual', 'manual_queue', '2026-08-27', 'user:cf000000-0000-4000-8000-0000000000a1'),
  ('OE-MIX', 'cf000000-0000-4000-8000-000000000001', 'OE-J1', 'materials', 'actual', 600, 'high_manual', 'manual_split', '2026-08-27', 'user:cf000000-0000-4000-8000-0000000000a1'),
  ('OE-MIX', 'cf000000-0000-4000-8000-000000000002', 'OE-J2', 'labour', 'actual', 400, 'high_manual', 'manual_split', '2026-08-27', 'ops_dashboard'),
  ('OE-SAME', 'cf000000-0000-4000-8000-000000000001', 'OE-J1', 'labour', 'actual', 500, 'high_manual', 'manual_queue', '2026-08-27', 'ops_dashboard'),
  ('OE-MAT', 'cf000000-0000-4000-8000-000000000002', 'OE-J2', 'materials', 'actual', 400, 'high_manual', 'manual_queue', '2026-08-27', 'ops_dashboard'),
  ('OE-XL', 'cf000000-0000-4000-8000-000000000002', 'OE-J2', 'materials', 'expected', 400, 'high', 'xero_ref_link', '2026-08-27', NULL);

-- ── The outcome per bill ──────────────────────────────────────────────────
DO $$
DECLARE c record; o record;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    (1, 'OE-F2', 'unknown', 'labour_part_unconfirmed', 1),
    (2, 'OE-F2M', 'unknown', 'labour_part_unconfirmed', 1),
    (3, 'OE-F2P', 'confirmed', NULL, 1),
    (4, 'OE-MIX', 'unknown', 'labour_part_unconfirmed', 2),
    (5, 'OE-SAME', 'placed_unconfirmed', NULL, 1),
    (6, 'OE-MAT', 'placed_unconfirmed', NULL, 1),
    (7, 'OE-OH', 'unknown', 'overhead_on_xero_linked_bill', 1),
    (8, 'OE-OH2', 'unknown', 'overhead_on_xero_linked_bill', 1),
    (9, 'OE-XL', 'unknown', 'xero_link_not_counted', 1),
    (10, 'OE-PLAIN', 'placed_unconfirmed', NULL, 1),
    (11, 'OE-NJR', 'confirmed_overhead', NULL, 0),
    (12, 'OE-INST', 'installer_unconfirmed', NULL, 1)
  ) AS t(n, bill, want_state, want_reason, want_parts) ORDER BY n LOOP
    SELECT * INTO o FROM public.cfo_bill_reconciliation_outcomes WHERE xero_invoice_id = c.bill;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'engine agreement: % has no outcome row', c.bill;
    END IF;
    IF o.state IS DISTINCT FROM c.want_state OR o.held_reason IS DISTINCT FROM c.want_reason THEN
      RAISE EXCEPTION 'engine agreement: % read % / %, expected % / %',
        c.bill, o.state, o.held_reason, c.want_state, c.want_reason;
    END IF;
    -- A hold changes the judgment only: the recorded parts stay as they are.
    IF jsonb_array_length(o.parts) <> c.want_parts THEN
      RAISE EXCEPTION 'engine agreement: % lists % parts, expected %', c.bill, jsonb_array_length(o.parts), c.want_parts;
    END IF;
  END LOOP;
END $$;

-- ── A hold is never a confirmation, and only the hold sets held_reason ─────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.cfo_bill_reconciliation_outcomes
              WHERE held_reason IS NOT NULL
                AND (state <> 'unknown' OR confirmed OR decided_by IS NOT NULL OR decided_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'engine agreement: a held bill reads confirmed or decided';
  END IF;
  IF (SELECT array_agg(column_name::text ORDER BY ordinal_position DESC)
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'cfo_bill_reconciliation_outcomes')[1] <> 'held_reason' THEN
    RAISE EXCEPTION 'engine agreement: held_reason is not the last column';
  END IF;
END $$;

-- ── The engine is what the hold reads: it counts no held part ───────────────
DO $$
DECLARE r record;
BEGIN
  -- Held bills: the engine counts none of what their parts show on the held lane.
  SELECT count(*) FILTER (WHERE e.is_actual AND (e.document_id IN ('OE-F2', 'OE-F2M', 'OE-OH', 'OE-OH2', 'OE-XL')
                                                 OR (e.document_id = 'OE-MIX' AND e.lane = 'labour'))) AS held_actual,
         sum(e.amount_ex) FILTER (WHERE e.is_actual AND e.document_id = 'OE-MIX') AS mix_actual,
         count(*) FILTER (WHERE e.is_actual AND e.document_id IN ('OE-F2P', 'OE-SAME', 'OE-MAT', 'OE-PLAIN', 'OE-NJR')) AS counted
    INTO r
    FROM public.v_job_cost_events e
   WHERE e.document_id LIKE 'OE-%';
  IF r.held_actual <> 0 OR r.mix_actual IS DISTINCT FROM 600 OR r.counted <> 5 THEN
    RAISE EXCEPTION 'engine agreement: engine held_actual % mix % counted % (expected 0, 600, 5)',
      r.held_actual, r.mix_actual, r.counted;
  END IF;
END $$;

ROLLBACK;
