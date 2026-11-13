-- Contract for 20261114030000_job_labour_cap.sql. Every fixture write is inside
-- a transaction that rolls back.

-- 1. The switch is seeded off; the raises are service-only and append-only;
-- the read and the writer are service-role only; the guards are deferred.
DO $$
BEGIN
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'job_labour_budget_v1') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'labour cap contract: the switch must be seeded off';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.job_labour_cap_raises'::regclass) THEN
    RAISE EXCEPTION 'labour cap contract: row-level security is off on the raises';
  END IF;
  IF has_table_privilege('anon', 'public.job_labour_cap_raises', 'SELECT')
     OR has_table_privilege('authenticated', 'public.job_labour_cap_raises', 'SELECT')
     OR has_table_privilege('authenticated', 'public.job_labour_cap_raises', 'INSERT')
     OR has_table_privilege('service_role', 'public.job_labour_cap_raises', 'INSERT') THEN
    RAISE EXCEPTION 'labour cap contract: the raises are written only by raise_job_labour_cap';
  END IF;
  IF has_function_privilege('authenticated', 'public.job_labour_cap_state(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.job_labour_cap_state(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.job_labour_cap_state(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.raise_job_labour_cap(uuid, uuid, uuid, text, uuid, numeric, text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.raise_job_labour_cap(uuid, uuid, uuid, text, uuid, numeric, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.job_labour_cap_check_invoice(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'labour cap contract: the read and the writer must be service-role only';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgname IN ('job_labour_cap_guard_line', 'job_labour_cap_guard_invoice')
         AND tgdeferrable AND tginitdeferred) <> 2 THEN
    RAISE EXCEPTION 'labour cap contract: both guards must be deferred constraint triggers';
  END IF;
END $$;

-- 2. The cap, its raises and the guard.
BEGIN;
INSERT INTO public.jobs (id, org_id, status, type, job_number)
VALUES ('00000000-0000-0000-0000-00000000c401', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'ZZTEST-C401'),
       ('00000000-0000-0000-0000-00000000c402', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'ZZTEST-C402');
INSERT INTO public.users (id, org_id, name)
VALUES ('00000000-0000-0000-0000-00000000c4a1', '00000000-0000-0000-0000-000000000001', 'ZZTEST trade'),
       ('00000000-0000-0000-0000-00000000c4b1', '00000000-0000-0000-0000-000000000001', 'ZZTEST approver'),
       ('00000000-0000-0000-0000-00000000c4b2', '00000000-0000-0000-0000-000000000001', 'ZZTEST office');
UPDATE public.work_order_settings
   SET approver_user_ids = COALESCE(approver_user_ids, '{}'::uuid[]) || '00000000-0000-0000-0000-00000000c4b1'::uuid
 WHERE id = 1;
INSERT INTO public.scope_revisions (id, job_id, revision_number, status, scope_canonical_text, pricing_canonical_text, scope_hash, pricing_hash)
SELECT v.id::uuid, v.job::uuid, v.n, 'frozen', '{}', v.p,
       encode(sha256(convert_to('{}', 'UTF8')), 'hex'), encode(sha256(convert_to(v.p, 'UTF8')), 'hex')
  FROM (VALUES ('00000000-0000-0000-0000-00000000c411', '00000000-0000-0000-0000-00000000c401', 1, '{"p":1}'),
               ('00000000-0000-0000-0000-00000000c412', '00000000-0000-0000-0000-00000000c401', 2, '{"p":2}'),
               ('00000000-0000-0000-0000-00000000c421', '00000000-0000-0000-0000-00000000c402', 1, '{"p":3}')) AS v(id, job, n, p);
-- Hourly up to a maximum: 10 hours at 80 = 800. The other job is group pay.
INSERT INTO public.job_budgets (id, job_id, scope_revision_id, version, pricing_hash, trade, complete, gap_count, budget)
VALUES ('00000000-0000-0000-0000-00000000c431', '00000000-0000-0000-0000-00000000c401', '00000000-0000-0000-0000-00000000c411', 1,
        repeat('a', 64), 'fence', true, 0,
        '{"version":"budget.v1","labour":{"pay":"hourly_capped","amount_ex_gst":800,"hourly":{"rate_ex_gst":80,"max_hours":10,"max_ex_gst":800},"work_order_amount_ex_gst":800}}'::jsonb),
       ('00000000-0000-0000-0000-00000000c441', '00000000-0000-0000-0000-00000000c402', '00000000-0000-0000-0000-00000000c421', 1,
        repeat('b', 64), 'fence', true, 0,
        '{"version":"budget.v1","labour":{"pay":"group_work_order","amount_ex_gst":100,"hourly":null,"work_order_amount_ex_gst":100}}'::jsonb);
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_labour_budget_v1';
SET CONSTRAINTS job_labour_cap_guard_line, job_labour_cap_guard_invoice IMMEDIATE;

DO $$
DECLARE
  job    uuid := '00000000-0000-0000-0000-00000000c401';
  grp    uuid := '00000000-0000-0000-0000-00000000c402';
  trade  uuid := '00000000-0000-0000-0000-00000000c4a1';
  b1     uuid := '00000000-0000-0000-0000-00000000c431';
  st     jsonb;
  r      jsonb;
  refused boolean;
BEGIN
  st := public.job_labour_cap_state(job);
  IF st->>'state' <> 'capped' OR (st->>'cap_ex_gst')::numeric <> 800 OR (st->>'billed_ex_gst')::numeric <> 0 THEN
    RAISE EXCEPTION 'labour cap contract: the cap was not read from the budget: %', st;
  END IF;
  IF public.job_labour_cap_state(grp)->>'state' <> 'not_capped' THEN
    RAISE EXCEPTION 'labour cap contract: a group-pay job read as capped';
  END IF;

  -- A submitted invoice within the maximum is accepted.
  INSERT INTO public.trade_invoices (id, org_id, user_id, week_start, status, subtotal_ex, gst_on, gst, total_inc, super_rate, super_amount, gross_earned, net_pay)
  VALUES ('00000000-0000-0000-0000-00000000c451', '00000000-0000-0000-0000-000000000001', trade, '2026-11-09', 'pending_acknowledgment',
          600, false, 0, 600, 0.12, 72, 600, 564);
  INSERT INTO public.trade_invoice_lines (id, trade_invoice_id, job_id, line_type, description, line_total_ex, line_date)
  VALUES ('00000000-0000-0000-0000-00000000c461', '00000000-0000-0000-0000-00000000c451', job, 'labour', 'Fence build', 600, '2026-11-10');
  IF (public.job_labour_cap_state(job)->>'billed_ex_gst')::numeric <> 600 THEN
    RAISE EXCEPTION 'labour cap contract: billed labour was not counted';
  END IF;

  -- A draft that would take the job past it is refused, from any trade.
  INSERT INTO public.trade_invoices (id, org_id, user_id, week_start, status, subtotal_ex, gst_on, gst, total_inc, super_rate, super_amount, gross_earned, net_pay)
  VALUES ('00000000-0000-0000-0000-00000000c452', '00000000-0000-0000-0000-000000000001', trade, '2026-11-16', 'draft',
          300, false, 0, 300, 0.12, 36, 300, 282);
  refused := false;
  BEGIN
    INSERT INTO public.trade_invoice_lines (id, trade_invoice_id, job_id, line_type, description, line_total_ex, line_date)
    VALUES ('00000000-0000-0000-0000-00000000c462', '00000000-0000-0000-0000-00000000c452', job, 'labour', 'More hours', 300, '2026-11-17');
  EXCEPTION WHEN check_violation THEN
    refused := SQLERRM = 'job_labour_cap_exceeded';
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'labour cap contract: labour past the maximum was not refused';
  END IF;

  -- Someone who is not an approver cannot raise it.
  BEGIN
    PERFORM public.raise_job_labour_cap(job, b1, '00000000-0000-0000-0000-00000000c4b2', NULL,
                                        '00000000-0000-0000-0000-000000000001', 100, 'Rock in the post holes');
    RAISE EXCEPTION 'labour cap contract: a non-approver raised the maximum';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- Nor raise a budget that is not the job's current one.
  BEGIN
    PERFORM public.raise_job_labour_cap(job, '00000000-0000-0000-0000-00000000c441', '00000000-0000-0000-0000-00000000c4b1', NULL,
                                        '00000000-0000-0000-0000-000000000001', 100, 'Rock in the post holes');
    RAISE EXCEPTION 'labour cap contract: a raise named another budget';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  -- A group-pay job has no maximum to raise.
  BEGIN
    PERFORM public.raise_job_labour_cap(grp, '00000000-0000-0000-0000-00000000c441', '00000000-0000-0000-0000-00000000c4b1', NULL,
                                        '00000000-0000-0000-0000-000000000001', 100, 'Rock in the post holes');
    RAISE EXCEPTION 'labour cap contract: a group-pay job took a raise';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- The approver raises it; who, when, why and how much are recorded.
  r := public.raise_job_labour_cap(job, b1, '00000000-0000-0000-0000-00000000c4b1', ' approver@example.test ',
                                   '00000000-0000-0000-0000-000000000001', 100, '  Rock in the post holes  ');
  IF r->>'authority' <> 'approver_list' OR (r->'cap'->>'cap_ex_gst')::numeric <> 900 THEN
    RAISE EXCEPTION 'labour cap contract: the raise did not lift the cap: %', r;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.job_labour_cap_raises
                  WHERE job_id = job AND budget_id = b1 AND amount_ex_gst = 100
                    AND reason = 'Rock in the post holes' AND raised_by = '00000000-0000-0000-0000-00000000c4b1'
                    AND raised_by_email = 'approver@example.test' AND raised_at IS NOT NULL) THEN
    RAISE EXCEPTION 'labour cap contract: the raise was not recorded in full';
  END IF;
  INSERT INTO public.trade_invoice_lines (id, trade_invoice_id, job_id, line_type, description, line_total_ex, line_date)
  VALUES ('00000000-0000-0000-0000-00000000c462', '00000000-0000-0000-0000-00000000c452', job, 'labour', 'More hours', 300, '2026-11-17');

  -- A raise is never changed or deleted.
  BEGIN
    UPDATE public.job_labour_cap_raises SET amount_ex_gst = 5000 WHERE job_id = job;
    RAISE EXCEPTION 'labour cap contract: a raise was changed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- Group pay is never capped by this rule.
  INSERT INTO public.trade_invoice_lines (id, trade_invoice_id, job_id, line_type, description, line_total_ex, line_date)
  VALUES ('00000000-0000-0000-0000-00000000c463', '00000000-0000-0000-0000-00000000c451', grp, 'labour', 'Group job', 5000, '2026-11-10');
  DELETE FROM public.trade_invoice_lines WHERE id = '00000000-0000-0000-0000-00000000c463';

  -- A newer budget version starts again from its own maximum (100, no raise).
  INSERT INTO public.job_budgets (id, job_id, scope_revision_id, version, pricing_hash, trade, complete, gap_count, budget)
  VALUES ('00000000-0000-0000-0000-00000000c432', job, '00000000-0000-0000-0000-00000000c412', 2, repeat('c', 64), 'fence', true, 0,
          '{"version":"budget.v1","labour":{"pay":"hourly_capped","amount_ex_gst":100,"hourly":{"rate_ex_gst":50,"max_hours":2,"max_ex_gst":100},"work_order_amount_ex_gst":100}}'::jsonb);
  IF (public.job_labour_cap_state(job)->>'cap_ex_gst')::numeric <> 100 THEN
    RAISE EXCEPTION 'labour cap contract: a raise on an older budget carried to the newer one';
  END IF;

  -- Already-billed work moving on, or a line only lowered, is never refused.
  UPDATE public.trade_invoices SET status = 'approved' WHERE id = '00000000-0000-0000-0000-00000000c451';
  UPDATE public.trade_invoice_lines SET line_total_ex = 550 WHERE id = '00000000-0000-0000-0000-00000000c461';

  -- But a draft moving into billing past the cap is.
  refused := false;
  BEGIN
    UPDATE public.trade_invoices SET status = 'pending_acknowledgment' WHERE id = '00000000-0000-0000-0000-00000000c452';
  EXCEPTION WHEN check_violation THEN
    refused := SQLERRM = 'job_labour_cap_exceeded';
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'labour cap contract: a draft entered billing past the cap';
  END IF;

  -- With the switch off nothing is refused.
  UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'job_labour_budget_v1';
  UPDATE public.trade_invoices SET status = 'pending_acknowledgment' WHERE id = '00000000-0000-0000-0000-00000000c452';
  UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_labour_budget_v1';
END $$;

-- A line that is gone again before commit (a replaced draft) is not checked.
SET CONSTRAINTS job_labour_cap_guard_line, job_labour_cap_guard_invoice DEFERRED;
INSERT INTO public.trade_invoices (id, org_id, user_id, week_start, status, subtotal_ex, gst_on, gst, total_inc, super_rate, super_amount, gross_earned, net_pay)
VALUES ('00000000-0000-0000-0000-00000000c453', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000c4a1',
        '2026-11-23', 'draft', 50, false, 0, 50, 0.12, 6, 50, 47);
INSERT INTO public.trade_invoice_lines (id, trade_invoice_id, job_id, line_type, description, line_total_ex, line_date)
VALUES ('00000000-0000-0000-0000-00000000c464', '00000000-0000-0000-0000-00000000c453', '00000000-0000-0000-0000-00000000c401',
        'labour', 'Replaced', 50, '2026-11-24');
DELETE FROM public.trade_invoice_lines WHERE id = '00000000-0000-0000-0000-00000000c464';
SET CONSTRAINTS job_labour_cap_guard_line, job_labour_cap_guard_invoice IMMEDIATE;
ROLLBACK;

-- 3. Crew options the customer took are labour on top of the hourly maximum,
-- and a cap that cannot be read lets no labour through (absent hourly, {},
-- each absent property, an absent labour amount, an amount under the maximum).
BEGIN;
INSERT INTO public.users (id, org_id, name)
VALUES ('00000000-0000-0000-0000-00000000c5a1', '00000000-0000-0000-0000-000000000001', 'ZZTEST trade');
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_labour_budget_v1';
SET CONSTRAINTS job_labour_cap_guard_line, job_labour_cap_guard_invoice IMMEDIATE;

DO $$
DECLARE
  cases  text[][] := ARRAY[
    -- name, labour json
    ['options',      '{"pay":"hourly_capped","amount_ex_gst":3050,"hourly":{"rate_ex_gst":70,"max_hours":40,"max_ex_gst":2800},"work_order_amount_ex_gst":3050}'],
    ['no_hourly',    '{"pay":"hourly_capped","amount_ex_gst":800,"work_order_amount_ex_gst":800}'],
    ['null_hourly',  '{"pay":"hourly_capped","amount_ex_gst":800,"hourly":null,"work_order_amount_ex_gst":800}'],
    ['empty_hourly', '{"pay":"hourly_capped","amount_ex_gst":800,"hourly":{},"work_order_amount_ex_gst":800}'],
    ['no_rate',      '{"pay":"hourly_capped","amount_ex_gst":800,"hourly":{"max_hours":10,"max_ex_gst":800},"work_order_amount_ex_gst":800}'],
    ['no_hours',     '{"pay":"hourly_capped","amount_ex_gst":800,"hourly":{"rate_ex_gst":80,"max_ex_gst":800},"work_order_amount_ex_gst":800}'],
    ['no_max',       '{"pay":"hourly_capped","amount_ex_gst":800,"hourly":{"rate_ex_gst":80,"max_hours":10},"work_order_amount_ex_gst":800}'],
    ['text_max',     '{"pay":"hourly_capped","amount_ex_gst":800,"hourly":{"rate_ex_gst":80,"max_hours":10,"max_ex_gst":"800"},"work_order_amount_ex_gst":800}'],
    ['no_amount',    '{"pay":"hourly_capped","hourly":{"rate_ex_gst":80,"max_hours":10,"max_ex_gst":800},"work_order_amount_ex_gst":800}'],
    ['under_max',    '{"pay":"hourly_capped","amount_ex_gst":700,"hourly":{"rate_ex_gst":80,"max_hours":10,"max_ex_gst":800},"work_order_amount_ex_gst":700}']
  ];
  i      int;
  job    uuid;
  rev    uuid;
  inv    uuid;
  st     jsonb;
  refused boolean;
  code   text;
BEGIN
  FOR i IN 1 .. array_length(cases, 1) LOOP
    job := ('00000000-0000-0000-0000-00000000c9' || lpad(to_hex(i), 2, '0'))::uuid;
    rev := ('00000000-0000-0000-0000-00000000ca' || lpad(to_hex(i), 2, '0'))::uuid;
    inv := ('00000000-0000-0000-0000-00000000cb' || lpad(to_hex(i), 2, '0'))::uuid;
    INSERT INTO public.jobs (id, org_id, status, type, job_number)
    VALUES (job, '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'ZZTEST-C5' || i);
    INSERT INTO public.scope_revisions (id, job_id, revision_number, status, scope_canonical_text, pricing_canonical_text, scope_hash, pricing_hash)
    VALUES (rev, job, 1, 'frozen', '{}', '{"p":' || i || '}',
            encode(sha256(convert_to('{}', 'UTF8')), 'hex'), encode(sha256(convert_to('{"p":' || i || '}', 'UTF8')), 'hex'));
    INSERT INTO public.job_budgets (id, job_id, scope_revision_id, version, pricing_hash, trade, complete, gap_count, budget)
    VALUES (gen_random_uuid(), job, rev, 1, repeat('d', 64), 'fence', true, 0,
            jsonb_build_object('version', 'budget.v1', 'labour', cases[i][2]::jsonb));
    st := public.job_labour_cap_state(job);
    INSERT INTO public.trade_invoices (id, org_id, user_id, week_start, status, subtotal_ex, gst_on, gst, total_inc, super_rate, super_amount, gross_earned, net_pay)
    VALUES (inv, '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000c5a1', '2026-11-09', 'pending_acknowledgment',
            3000, false, 0, 3000, 0.12, 360, 3000, 2820);

    IF cases[i][1] = 'options' THEN
      -- 70 x 40 = 2800, plus a 250 crew option: the crew may bill 3050.
      IF st->>'state' <> 'capped' OR (st->>'max_ex_gst')::numeric <> 2800
         OR (st->>'crew_options_ex_gst')::numeric <> 250 OR (st->>'cap_ex_gst')::numeric <> 3050 THEN
        RAISE EXCEPTION 'labour cap contract: a taken crew option is not inside the cap: %', st;
      END IF;
      INSERT INTO public.trade_invoice_lines (id, trade_invoice_id, job_id, line_type, description, line_total_ex, line_date)
      VALUES (gen_random_uuid(), inv, job, 'labour', 'Build and the crew option', 3050, '2026-11-10');
      refused := false;
      BEGIN
        INSERT INTO public.trade_invoice_lines (id, trade_invoice_id, job_id, line_type, description, line_total_ex, line_date)
        VALUES (gen_random_uuid(), inv, job, 'labour', 'One more', 0.01, '2026-11-11');
      EXCEPTION WHEN check_violation THEN
        refused := SQLERRM = 'job_labour_cap_exceeded';
      END;
      IF NOT refused THEN
        RAISE EXCEPTION 'labour cap contract: labour past the maximum plus options was not refused';
      END IF;
    ELSE
      IF st->>'state' <> 'capped_unreadable' OR jsonb_typeof(st->'cap_ex_gst') <> 'number'
         OR (st->>'cap_ex_gst')::numeric <> 0 OR (st->>'remaining_ex_gst')::numeric <> 0 THEN
        RAISE EXCEPTION 'labour cap contract: % did not read as unreadable with a zero cap: %', cases[i][1], st;
      END IF;
      refused := false;
      BEGIN
        INSERT INTO public.trade_invoice_lines (id, trade_invoice_id, job_id, line_type, description, line_total_ex, line_date)
        VALUES (gen_random_uuid(), inv, job, 'labour', 'Any labour', 1, '2026-11-10');
      EXCEPTION WHEN check_violation THEN
        code := SQLERRM;
        refused := code IN ('job_labour_cap_exceeded', 'job_labour_cap_unreadable');
      END;
      IF NOT refused THEN
        RAISE EXCEPTION 'labour cap contract: % let labour through on an unreadable cap', cases[i][1];
      END IF;
    END IF;
  END LOOP;
END $$;
ROLLBACK;
