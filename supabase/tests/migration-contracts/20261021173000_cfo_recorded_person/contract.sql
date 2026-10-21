-- Contract for 20261021173000_cfo_recorded_person (JP-12 recorded-person boundary).
--
-- Synthetic people, jobs and bills, no customer data. Everything rolls back.
--
--   RP person  public.users ce..a1, email rp-person@test; RP nomail has no email;
--   RP mixed ce..a3 stores its email in mixed case with spaces.
--   RP-J1, RP-J2  finished fencing jobs.
--   RP-B1    installer bill (306) 1,000 ex in Bills to place: a split by any
--            actor that is not a recorded person is refused and writes nothing;
--            the person's split writes one row.
--   RP-L1    installer bill on RP-J1 by Xero, a manual_queue row with
--            actor_missing (an older row): not actual, J1 flagged, never settled.
--   RP-L2    the same with user:<the person>: actual, settled, decided by them.
--   RP-NJR   installer bill on RP-J2 by Xero, marked not job related by
--            'ops_dashboard': unconfirmed on J2, not a person's mark.
--   RP-OH    installer bill 1,000: the person's 700 on RP-J1 plus 300 overhead,
--            queue actor actor_missing: the 700 counts, the bill never settles
--            (its overhead part was decided by nobody recorded).
--   RP-M     installer row by the reference path (machine) carrying the
--            person's actor forward: not actual.
\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.users (id, org_id, name, email) VALUES
  ('ce000000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'RP person', 'rp-person@test'),
  ('ce000000-0000-4000-8000-0000000000a2', '00000000-0000-0000-0000-000000000001', 'RP nomail', NULL),
  -- an email stored in mixed case with spaces: lower(btrim()) on both sides
  ('ce000000-0000-4000-8000-0000000000a3', '00000000-0000-0000-0000-000000000001', 'RP mixed', ' RP.Mixed@Case.Test ');

INSERT INTO public.jobs (id, org_id, status, type, job_number, legacy, metadata, pricing_json, expected_costs, created_at) VALUES
  ('ce000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'RP-J1', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z'),
  ('ce000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'RP-J2', false, '{}', '{}', NULL, '2026-07-01T00:00:00Z');

INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, line_items, raw_json, job_id) VALUES
  ('00000000-0000-0000-0000-000000000001', 'RP-B1', 'RP-1', 'ACCPAY', 'AUTHORISED', 'RP Installer', 1000, 1100, '2026-08-27',
   '[{"Description": "Installs", "AccountCode": "306", "LineAmount": 1000, "TaxAmount": 100}]', '{"LineAmountTypes": "Exclusive"}', NULL),
  ('00000000-0000-0000-0000-000000000001', 'RP-L1', 'RP-2', 'ACCPAY', 'AUTHORISED', 'RP Installer', 100, 110, '2026-08-27',
   '[{"Description": "Install", "AccountCode": "306", "LineAmount": 100, "TaxAmount": 10}]', '{"LineAmountTypes": "Exclusive"}', 'ce000000-0000-4000-8000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'RP-L2', 'RP-3', 'ACCPAY', 'AUTHORISED', 'RP Installer', 200, 220, '2026-08-27',
   '[{"Description": "Install", "AccountCode": "306", "LineAmount": 200, "TaxAmount": 20}]', '{"LineAmountTypes": "Exclusive"}', 'ce000000-0000-4000-8000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'RP-NJR', 'RP-4', 'ACCPAY', 'AUTHORISED', 'RP Installer', 300, 330, '2026-08-27',
   '[{"Description": "Yard", "AccountCode": "306", "LineAmount": 300, "TaxAmount": 30}]', '{"LineAmountTypes": "Exclusive"}', 'ce000000-0000-4000-8000-000000000002'),
  ('00000000-0000-0000-0000-000000000001', 'RP-OH', 'RP-5', 'ACCPAY', 'AUTHORISED', 'RP Installer', 1000, 1100, '2026-08-27',
   '[{"Description": "Installs", "AccountCode": "306", "LineAmount": 1000, "TaxAmount": 100}]', '{"LineAmountTypes": "Exclusive"}', NULL),
  ('00000000-0000-0000-0000-000000000001', 'RP-M', 'RP-6', 'ACCPAY', 'AUTHORISED', 'RP Installer', 150, 165, '2026-08-27',
   '[{"Description": "Install", "AccountCode": "306", "LineAmount": 150, "TaxAmount": 15}]', '{"LineAmountTypes": "Exclusive"}', NULL);

INSERT INTO public.materials_reconciliation_queue (xero_invoice_id, invoice_number, contact_name, sub_total, total, invoice_date, status, assigned_by, assigned_at, overhead_ex) VALUES
  ('RP-B1', 'RP-1', 'RP Installer', 1000, 1100, '2026-08-27', 'open', NULL, NULL, NULL),
  ('RP-L1', 'RP-2', 'RP Installer', 100, 110, '2026-08-27', 'assigned', 'actor_missing', '2026-09-01T00:00:00Z', NULL),
  ('RP-L2', 'RP-3', 'RP Installer', 200, 220, '2026-08-27', 'assigned', 'user:ce000000-0000-4000-8000-0000000000a1', '2026-09-01T00:00:00Z', NULL),
  ('RP-NJR', 'RP-4', 'RP Installer', 300, 330, '2026-08-27', 'not_job_related', 'ops_dashboard', '2026-09-01T00:00:00Z', NULL),
  ('RP-OH', 'RP-5', 'RP Installer', 1000, 1100, '2026-08-27', 'split', 'actor_missing', '2026-09-01T00:00:00Z', 300),
  ('RP-M', 'RP-6', 'RP Installer', 150, 165, '2026-08-27', 'assigned', 'user:ce000000-0000-4000-8000-0000000000a1', '2026-09-01T00:00:00Z', NULL);

INSERT INTO public.job_materials_facts (xero_invoice_id, job_id, job_number, lane, kind, amount_ex_gst, confidence, automation_source, fact_date, assigned_by) VALUES
  ('RP-L1', 'ce000000-0000-4000-8000-000000000001', 'RP-J1', 'labour', 'actual', 100, 'high_manual', 'manual_queue', '2026-08-27', 'actor_missing'),
  ('RP-L2', 'ce000000-0000-4000-8000-000000000001', 'RP-J1', 'labour', 'actual', 200, 'high_manual', 'manual_queue', '2026-08-27', 'user:ce000000-0000-4000-8000-0000000000a1'),
  ('RP-OH', 'ce000000-0000-4000-8000-000000000001', 'RP-J1', 'labour', 'actual', 700, 'high_manual', 'manual_split', '2026-08-27', 'user:ce000000-0000-4000-8000-0000000000a1'),
  ('RP-M', 'ce000000-0000-4000-8000-000000000002', 'RP-J2', 'labour', 'actual', 150, 'high', 'xero_ref_link', '2026-08-27', 'user:ce000000-0000-4000-8000-0000000000a1');

-- ── The rule ────────────────────────────────────────────────────────────────
DO $$
DECLARE c record; got boolean;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    (1, 'manual_queue', 'user:ce000000-0000-4000-8000-0000000000a1', true),
    (2, 'manual_split', 'user:CE000000-0000-4000-8000-0000000000A1', true),
    (3, 'manual_split', 'rp-person@test', true),
    (4, 'manual_queue', ' RP-Person@Test ', true),
    (5, 'manual_queue', 'actor_missing', false),
    (6, 'manual_queue', 'ops_dashboard', false),
    (7, 'manual_queue', 'makesafe-reporting-routine', false),
    (8, 'manual_queue', 'xero-sync', false),
    (9, 'manual_queue', 'cfo_agent', false),
    (10, 'manual_queue', 'Marnin', false),
    (11, 'manual_queue', 'person:ce000000-0000-4000-8000-0000000000a1', false),
    (12, 'manual_queue', 'ce000000-0000-4000-8000-0000000000a1', false),
    (13, 'manual_queue', 'user:ce000000-0000-4000-8000-0000000000ff', false),
    (14, 'manual_queue', 'user:', false),
    (15, 'manual_queue', 'user:not-a-uuid', false),
    (16, 'manual_queue', 'nobody@test', false),
    (17, 'manual_queue', '@test', false),
    (18, 'manual_queue', '', false),
    (19, 'manual_split', '   ', false),
    (20, 'manual_queue', NULL, false),
    (21, 'xero_ref_link', 'user:ce000000-0000-4000-8000-0000000000a1', false),
    (22, 'po_deterministic', 'rp-person@test', false),
    (23, 'agent_prematch', 'user:ce000000-0000-4000-8000-0000000000a1', false),
    (24, NULL, 'user:ce000000-0000-4000-8000-0000000000a1', false),
    (25, 'manual_queue', 'rp.mixed@case.test', true),
    (26, 'manual_split', 'RP.MIXED@CASE.TEST', true)
  ) AS t(n, src, act, want) ORDER BY n LOOP
    got := public.cfo_recorded_person(c.src, c.act);
    IF got IS DISTINCT FROM c.want THEN
      RAISE EXCEPTION 'recorded person: % / % read as %, expected %', c.src, c.act, got, c.want;
    END IF;
  END LOOP;
END $$;

-- ── allocate_bill_split refuses anyone who is not a recorded person ─────────
DO $$
DECLARE a text; v_msg text; v jsonb;
BEGIN
  FOREACH a IN ARRAY ARRAY['actor_missing', 'ops_dashboard', 'makesafe-reporting-routine', 'xero-sync', 'cfo_agent',
                           'person:ce000000-0000-4000-8000-0000000000a1', 'ce000000-0000-4000-8000-0000000000a1',
                           'user:ce000000-0000-4000-8000-0000000000ff', 'nobody@test', '   '] LOOP
    v_msg := NULL;
    BEGIN
      PERFORM public.allocate_bill_split('RP-B1', '[{"job_id": "ce000000-0000-4000-8000-000000000001", "amount_ex": 1000, "lane": "labour"}]', 0, NULL, a);
    EXCEPTION WHEN OTHERS THEN
      v_msg := SQLERRM;
    END;
    IF v_msg IS NULL OR position('recorded person is required' IN v_msg) = 0 THEN
      RAISE EXCEPTION 'recorded person split: actor % was not refused (%)', a, COALESCE(v_msg, 'accepted');
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.job_materials_facts WHERE xero_invoice_id = 'RP-B1')
     OR (SELECT status FROM public.materials_reconciliation_queue WHERE xero_invoice_id = 'RP-B1') <> 'open' THEN
    RAISE EXCEPTION 'recorded person split: a refused split wrote something';
  END IF;
  v := public.allocate_bill_split('RP-B1', '[{"job_id": "ce000000-0000-4000-8000-000000000001", "amount_ex": 1000, "lane": "labour"}]', 0, NULL,
                                  'user:ce000000-0000-4000-8000-0000000000a1');
  IF NOT (v ->> 'ok')::boolean
     OR (SELECT count(*) FROM public.job_materials_facts WHERE xero_invoice_id = 'RP-B1'
          AND assigned_by = 'user:ce000000-0000-4000-8000-0000000000a1') <> 1 THEN
    RAISE EXCEPTION 'recorded person split: the person''s split did not write its row (%)', v;
  END IF;
END $$;

-- ── Older rows read by the rule, unchanged ──────────────────────────────────
DO $$
DECLARE r record;
BEGIN
  SELECT bool_or(is_actual) AS act, bool_or(source = 'installer_bill_unconfirmed') AS held
    INTO r FROM public.v_job_cost_events WHERE document_id = 'RP-L1';
  IF r.act OR NOT r.held THEN
    RAISE EXCEPTION 'recorded person L1: an actor_missing row counts (actual %, held %)', r.act, r.held;
  END IF;
  SELECT * INTO r FROM public.v_bill_allocation_balance WHERE xero_invoice_id = 'RP-L1';
  IF r.installer_unconfirmed IS DISTINCT FROM true OR r.balanced THEN
    RAISE EXCEPTION 'recorded person L1 balance: installer_unconfirmed %, balanced %', r.installer_unconfirmed, r.balanced;
  END IF;
  SELECT * INTO r FROM public.cfo_bill_reconciliation_outcomes WHERE xero_invoice_id = 'RP-L1';
  IF r.state <> 'installer_unconfirmed' OR r.confirmed OR r.decided_by IS NOT NULL THEN
    RAISE EXCEPTION 'recorded person L1 H7: %, decided_by %', r.state, r.decided_by;
  END IF;
  IF (SELECT assigned_by FROM public.job_materials_facts WHERE xero_invoice_id = 'RP-L1') <> 'actor_missing' THEN
    RAISE EXCEPTION 'recorded person L1: the stored actor was rewritten';
  END IF;

  SELECT sum(amount_ex) FILTER (WHERE is_actual AND lane = 'labour') AS l INTO r
    FROM public.v_job_cost_events WHERE document_id = 'RP-L2';
  IF r.l IS DISTINCT FROM 200::numeric THEN
    RAISE EXCEPTION 'recorded person L2: the person''s row counts %', r.l;
  END IF;
  SELECT * INTO r FROM public.cfo_bill_reconciliation_outcomes WHERE xero_invoice_id = 'RP-L2';
  IF r.state <> 'confirmed' OR r.decided_by IS DISTINCT FROM 'user:ce000000-0000-4000-8000-0000000000a1' THEN
    RAISE EXCEPTION 'recorded person L2 H7: %, decided_by %', r.state, r.decided_by;
  END IF;

  -- Not job related by nobody recorded: unconfirmed, never a person's mark.
  SELECT bool_or(is_actual) AS act, bool_or(source = 'installer_bill_unconfirmed') AS held,
         bool_or(source = 'installer_bill_not_job_related') AS njr
    INTO r FROM public.v_job_cost_events WHERE document_id = 'RP-NJR';
  IF r.act OR NOT r.held OR r.njr THEN
    RAISE EXCEPTION 'recorded person NJR: actual %, held %, read as a person''s not-job-related mark %', r.act, r.held, r.njr;
  END IF;
  SELECT * INTO r FROM public.cfo_bill_reconciliation_outcomes WHERE xero_invoice_id = 'RP-NJR';
  IF r.confirmed OR r.decided_by IS NOT NULL THEN
    RAISE EXCEPTION 'recorded person NJR H7: settled as % by %', r.state, r.decided_by;
  END IF;

  -- The person's part counts; the overhead nobody recorded keeps the bill open.
  SELECT sum(amount_ex) FILTER (WHERE is_actual AND lane = 'labour') AS l INTO r
    FROM public.v_job_cost_events WHERE document_id = 'RP-OH';
  IF r.l IS DISTINCT FROM 700::numeric THEN
    RAISE EXCEPTION 'recorded person OH: the person''s 700 counts %', r.l;
  END IF;
  SELECT * INTO r FROM public.cfo_bill_reconciliation_outcomes WHERE xero_invoice_id = 'RP-OH';
  IF r.confirmed OR r.decided_by IS NOT NULL OR r.state <> 'placed_unconfirmed' THEN
    RAISE EXCEPTION 'recorded person OH H7: % decided by % (the overhead was decided by nobody recorded)', r.state, r.decided_by;
  END IF;
  SELECT * INTO r FROM public.v_bill_allocation_balance WHERE xero_invoice_id = 'RP-OH';
  IF r.installer_unconfirmed IS DISTINCT FROM true OR r.balanced THEN
    RAISE EXCEPTION 'recorded person OH balance: installer_unconfirmed %, balanced %', r.installer_unconfirmed, r.balanced;
  END IF;

  -- A machine row carrying a person's actor forward is still a machine's.
  IF EXISTS (SELECT 1 FROM public.v_job_cost_events WHERE document_id = 'RP-M' AND is_actual) THEN
    RAISE EXCEPTION 'recorded person M: a machine row counts because it carries a person''s actor';
  END IF;
  SELECT * INTO r FROM public.cfo_bill_reconciliation_outcomes WHERE xero_invoice_id = 'RP-M';
  IF r.confirmed THEN
    RAISE EXCEPTION 'recorded person M H7: settled as %', r.state;
  END IF;
END $$;

-- ── Grants ──────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.cfo_recorded_person(text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.cfo_recorded_person(text, text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.cfo_recorded_person(text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'recorded person grants: service role only';
  END IF;
END $$;

ROLLBACK;
