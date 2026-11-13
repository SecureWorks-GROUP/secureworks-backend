-- Contract for 20261114020000_dispatch_line_budget_cost.sql. Every fixture write is
-- inside a transaction that rolls back.

-- 1. The reasons table: row-level security on, no browser role, the service role may
-- only read and add; the switch is seeded off.
DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.dispatch_line_cost_reasons'::regclass) THEN
    RAISE EXCEPTION 'dispatch cost contract: row-level security is off on the reasons';
  END IF;
  IF has_table_privilege('anon', 'public.dispatch_line_cost_reasons', 'SELECT')
     OR has_table_privilege('authenticated', 'public.dispatch_line_cost_reasons', 'SELECT')
     OR has_table_privilege('anon', 'public.dispatch_line_cost_reasons', 'INSERT')
     OR has_table_privilege('authenticated', 'public.dispatch_line_cost_reasons', 'INSERT') THEN
    RAISE EXCEPTION 'dispatch cost contract: a browser role can read or write the reasons';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.dispatch_line_cost_reasons', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.dispatch_line_cost_reasons', 'INSERT')
     OR has_table_privilege('service_role', 'public.dispatch_line_cost_reasons', 'UPDATE')
     OR has_table_privilege('service_role', 'public.dispatch_line_cost_reasons', 'DELETE') THEN
    RAISE EXCEPTION 'dispatch cost contract: the service role must only read and add reasons';
  END IF;
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'dispatch_budget_cost_v1') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'dispatch cost contract: dispatch_budget_cost_v1 must be seeded off';
  END IF;
END $$;

-- 2. Fixtures: a job, a supplier on it, a stored budget, a second job.
BEGIN;
INSERT INTO public.jobs (id, org_id, status, type, job_number)
VALUES ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-000000000001', 'accepted', 'patio', 'ZZTEST-D001'),
       ('00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-000000000001', 'accepted', 'patio', 'ZZTEST-D002');
INSERT INTO public.suppliers (id, name) VALUES ('00000000-0000-0000-0000-00000000d301', 'ZZTEST supplier');
INSERT INTO public.job_material_suppliers (org_id, job_id, supplier_id, supplier_name, position)
VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000d301', 'ZZTEST supplier', 0),
       ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-00000000d301', 'ZZTEST supplier', 0);
INSERT INTO public.scope_revisions (id, job_id, revision_number, status, scope_canonical_text, pricing_canonical_text, scope_hash, pricing_hash)
VALUES ('00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000d001', 1, 'frozen', '{}', '{"p":1}',
        encode(sha256(convert_to('{}', 'UTF8')), 'hex'), encode(sha256(convert_to('{"p":1}', 'UTF8')), 'hex'));
INSERT INTO public.job_budgets (id, job_id, scope_revision_id, version, pricing_hash, trade, complete, gap_count, budget)
VALUES ('00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000d101',
        1, encode(sha256(convert_to('{"p":1}', 'UTF8')), 'hex'), 'patio', true, 0,
        '{"version":"budget.v1","trade":"patio","gaps":[],"materials":{"lines":[]}}'::jsonb);
INSERT INTO public.job_material_lines (id, org_id, job_id, supplier_id, description, quantity, unit, position)
VALUES ('00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000d001',
        '00000000-0000-0000-0000-00000000d301', 'Roof sheet', 10, 'each', 0),
       ('00000000-0000-0000-0000-00000000d402', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000d002',
        '00000000-0000-0000-0000-00000000d301', 'Roof sheet', 10, 'each', 0);

DO $$
DECLARE
  job1 uuid := '00000000-0000-0000-0000-00000000d001';
  job2 uuid := '00000000-0000-0000-0000-00000000d002';
  bud  uuid := '00000000-0000-0000-0000-00000000d201';
  line1 uuid := '00000000-0000-0000-0000-00000000d401';
  line2 uuid := '00000000-0000-0000-0000-00000000d402';
  r1 uuid;
  r2 uuid;
  ok boolean;
BEGIN
  -- 3. A line links to a budget line only with both the budget and the key.
  UPDATE public.job_material_lines SET budget_id = bud, budget_line_key = 'patio:SL-1' WHERE id = line1;
  BEGIN
    UPDATE public.job_material_lines SET budget_id = bud, budget_line_key = NULL WHERE id = line2;
    RAISE EXCEPTION 'dispatch cost contract: a budget link without its key was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.job_material_lines SET budget_id = NULL, budget_line_key = 'patio:SL-1' WHERE id = line2;
    RAISE EXCEPTION 'dispatch cost contract: a budget key without its budget was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.job_material_lines SET budget_id = gen_random_uuid(), budget_line_key = 'patio:SL-1' WHERE id = line2;
    RAISE EXCEPTION 'dispatch cost contract: a link to a budget that does not exist was stored';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  -- 4. A reason is given by a person, for a known basis, with real words.
  INSERT INTO public.dispatch_line_cost_reasons (org_id, job_id, line_id, budget_id, budget_line_key, basis, reason, quantity, unit, given_by)
  VALUES ('00000000-0000-0000-0000-000000000001', job1, line1, bud, 'patio:SL-1', 'over_budget', 'Site needs two more', 12, 'each', gen_random_uuid())
  RETURNING id INTO r1;
  BEGIN
    INSERT INTO public.dispatch_line_cost_reasons (org_id, job_id, line_id, budget_id, basis, reason, quantity, given_by)
    VALUES ('00000000-0000-0000-0000-000000000001', job1, line1, bud, 'over_budget', 'Site needs two more', 12, NULL);
    RAISE EXCEPTION 'dispatch cost contract: a reason with nobody named was stored';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.dispatch_line_cost_reasons (org_id, job_id, line_id, budget_id, basis, reason, quantity, given_by)
    VALUES ('00000000-0000-0000-0000-000000000001', job1, line1, bud, 'because', 'Site needs two more', 12, gen_random_uuid());
    RAISE EXCEPTION 'dispatch cost contract: a reason with an unknown basis was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.dispatch_line_cost_reasons (org_id, job_id, line_id, budget_id, basis, reason, quantity, given_by)
    VALUES ('00000000-0000-0000-0000-000000000001', job1, line1, bud, 'over_budget', '  ', 12, gen_random_uuid());
    RAISE EXCEPTION 'dispatch cost contract: an empty reason was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 5. A reason is never changed or deleted.
  BEGIN
    UPDATE public.dispatch_line_cost_reasons SET reason = 'Something else' WHERE id = r1;
    RAISE EXCEPTION 'dispatch cost contract: a reason was changed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.dispatch_line_cost_reasons WHERE id = r1;
    RAISE EXCEPTION 'dispatch cost contract: a reason was deleted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF (SELECT reason FROM public.dispatch_line_cost_reasons WHERE id = r1) IS DISTINCT FROM 'Site needs two more' THEN
    RAISE EXCEPTION 'dispatch cost contract: a stored reason moved';
  END IF;

  -- 6. A line names only a reason given for itself, on its own job.
  UPDATE public.job_material_lines SET cost_reason_id = r1 WHERE id = line1;
  BEGIN
    UPDATE public.job_material_lines SET cost_reason_id = r1 WHERE id = line2;
    RAISE EXCEPTION 'dispatch cost contract: a line took another line''s reason';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'dispatch_line_cost_reason_not_this_line' THEN RAISE; END IF;
  END;
  INSERT INTO public.dispatch_line_cost_reasons (org_id, job_id, line_id, budget_id, basis, reason, quantity, given_by)
  VALUES ('00000000-0000-0000-0000-000000000001', job1, line2, bud, 'not_in_budget', 'Typed in by hand', 10, gen_random_uuid())
  RETURNING id INTO r2;
  BEGIN
    UPDATE public.job_material_lines SET cost_reason_id = r2 WHERE id = line2;
    RAISE EXCEPTION 'dispatch cost contract: a line took a reason given on another job';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  SELECT cost_reason_id = r1 INTO ok FROM public.job_material_lines WHERE id = line1;
  IF ok IS NOT TRUE THEN
    RAISE EXCEPTION 'dispatch cost contract: a line lost its own reason';
  END IF;

  -- 7. An order's cost is the versioned record, or nothing.
  INSERT INTO public.dispatch_supplier_order_emails (org_id, job_id, supplier_id, supplier_name, subject, order_cost)
  VALUES ('00000000-0000-0000-0000-000000000001', job1, '00000000-0000-0000-0000-00000000d301', 'ZZTEST supplier', 'Order',
          '{"version":"dispatch-order-cost.v1","lines":[]}'::jsonb);
  INSERT INTO public.dispatch_supplier_order_emails (org_id, job_id, supplier_id, supplier_name, subject)
  VALUES ('00000000-0000-0000-0000-000000000001', job1, '00000000-0000-0000-0000-00000000d301', 'ZZTEST supplier', 'Order');
  BEGIN
    INSERT INTO public.dispatch_supplier_order_emails (org_id, job_id, supplier_id, supplier_name, subject, order_cost)
    VALUES ('00000000-0000-0000-0000-000000000001', job1, '00000000-0000-0000-0000-00000000d301', 'ZZTEST supplier', 'Order',
            '{"lines":[]}'::jsonb);
    RAISE EXCEPTION 'dispatch cost contract: an order cost without its version was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

END $$;
ROLLBACK;
