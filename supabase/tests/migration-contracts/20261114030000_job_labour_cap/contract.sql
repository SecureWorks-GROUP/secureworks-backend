-- Contract for 20261114030000_job_labour_cap.sql. Every fixture write is inside
-- a transaction that rolls back.

-- 1. The switch is seeded off; the raises are service-only and append-only;
-- the read and the writer are service-role only. Ruling 17c: the refusal is
-- ops-api's one work order cap guard, so this migration adds no labour guard
-- of its own on trade invoices.
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
     OR NOT has_function_privilege('service_role', 'public.raise_job_labour_cap(uuid, uuid, uuid, text, uuid, numeric, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'labour cap contract: the read and the writer must be service-role only';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger t
              WHERE t.tgrelid IN ('public.trade_invoice_lines'::regclass, 'public.trade_invoices'::regclass)
                AND t.tgname LIKE 'job_labour_cap%')
     OR to_regprocedure('public.job_labour_cap_check_invoice(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'labour cap contract: a second labour refusal path was added on trade invoices';
  END IF;
END $$;

-- 2. The limit and its raises. The database refuses no trade invoice line for
-- it (that is the ops-api guard's, counted its own way).
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

DO $$
DECLARE
  job    uuid := '00000000-0000-0000-0000-00000000c401';
  grp    uuid := '00000000-0000-0000-0000-00000000c402';
  trade  uuid := '00000000-0000-0000-0000-00000000c4a1';
  b1     uuid := '00000000-0000-0000-0000-00000000c431';
  st     jsonb;
  r      jsonb;
BEGIN
  st := public.job_labour_cap_state(job);
  IF st->>'state' <> 'capped' OR (st->>'cap_ex_gst')::numeric <> 800
     OR (st->>'rate_ex_gst')::numeric <> 80 OR (st->>'max_hours')::numeric <> 10
     OR st ? 'billed_ex_gst' OR st ? 'remaining_ex_gst' THEN
    RAISE EXCEPTION 'labour cap contract: the limit was not read from the budget alone: %', st;
  END IF;
  IF public.job_labour_cap_state(grp)->>'state' <> 'not_capped' THEN
    RAISE EXCEPTION 'labour cap contract: a group-pay job read as capped';
  END IF;

  -- No database refusal: a line past the limit is written (the ops-api
  -- guard refuses it before any write, at every door).
  INSERT INTO public.trade_invoices (id, org_id, user_id, week_start, status, subtotal_ex, gst_on, gst, total_inc, super_rate, super_amount, gross_earned, net_pay)
  VALUES ('00000000-0000-0000-0000-00000000c451', '00000000-0000-0000-0000-000000000001', trade, '2026-11-09', 'pending_acknowledgment',
          900, false, 0, 900, 0.12, 108, 900, 846);
  INSERT INTO public.trade_invoice_lines (id, trade_invoice_id, job_id, line_type, description, line_total_ex, line_date)
  VALUES ('00000000-0000-0000-0000-00000000c461', '00000000-0000-0000-0000-00000000c451', job, 'labour', 'Fence build', 900, '2026-11-10');
  IF (public.job_labour_cap_state(job)->>'cap_ex_gst')::numeric <> 800 THEN
    RAISE EXCEPTION 'labour cap contract: billed labour moved the limit';
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
  IF r->>'authority' <> 'approver_list' OR (r->'cap'->>'cap_ex_gst')::numeric <> 900
     OR (r->'cap'->>'raised_ex_gst')::numeric <> 100 THEN
    RAISE EXCEPTION 'labour cap contract: the raise did not lift the cap: %', r;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.job_labour_cap_raises
                  WHERE job_id = job AND budget_id = b1 AND amount_ex_gst = 100
                    AND reason = 'Rock in the post holes' AND raised_by = '00000000-0000-0000-0000-00000000c4b1'
                    AND raised_by_email = 'approver@example.test' AND raised_at IS NOT NULL) THEN
    RAISE EXCEPTION 'labour cap contract: the raise was not recorded in full';
  END IF;

  -- A raise is never changed or deleted.
  BEGIN
    UPDATE public.job_labour_cap_raises SET amount_ex_gst = 5000 WHERE job_id = job;
    RAISE EXCEPTION 'labour cap contract: a raise was changed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    DELETE FROM public.job_labour_cap_raises WHERE job_id = job;
    RAISE EXCEPTION 'labour cap contract: a raise was deleted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- A newer budget version starts again from its own maximum (100, no raise).
  INSERT INTO public.job_budgets (id, job_id, scope_revision_id, version, pricing_hash, trade, complete, gap_count, budget)
  VALUES ('00000000-0000-0000-0000-00000000c432', job, '00000000-0000-0000-0000-00000000c412', 2, repeat('c', 64), 'fence', true, 0,
          '{"version":"budget.v1","labour":{"pay":"hourly_capped","amount_ex_gst":100,"hourly":{"rate_ex_gst":50,"max_hours":2,"max_ex_gst":100},"work_order_amount_ex_gst":100}}'::jsonb);
  IF (public.job_labour_cap_state(job)->>'cap_ex_gst')::numeric <> 100 THEN
    RAISE EXCEPTION 'labour cap contract: a raise on an older budget carried to the newer one';
  END IF;

END $$;

ROLLBACK;

-- 3. Crew options the customer took are labour on top of the hourly maximum,
-- and a maximum that cannot be read is never a limit (absent hourly, {}, each
-- absent property, an absent labour amount, an amount under the maximum, a
-- maximum that is not rate x hours to the cent, a figure past the cent): the
-- state says capped_unreadable with a zero cap and names the budget check's
-- code, and the ops-api guard refuses such a job as unreadable (503), never
-- lets labour through and never picks one of two figures that disagree.
BEGIN;
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_labour_budget_v1';

DO $$
DECLARE
  cases  text[][] := ARRAY[
    -- name, expected unreadable_reason, labour json
    ['options', '',      '{"pay":"hourly_capped","amount_ex_gst":3050,"hourly":{"rate_ex_gst":70,"max_hours":40,"max_ex_gst":2800},"work_order_amount_ex_gst":3050}'],
    ['no_hourly', 'labour_hourly_invalid',    '{"pay":"hourly_capped","amount_ex_gst":800,"work_order_amount_ex_gst":800}'],
    ['null_hourly', 'labour_hourly_invalid',  '{"pay":"hourly_capped","amount_ex_gst":800,"hourly":null,"work_order_amount_ex_gst":800}'],
    ['empty_hourly', 'labour_hourly_invalid', '{"pay":"hourly_capped","amount_ex_gst":800,"hourly":{},"work_order_amount_ex_gst":800}'],
    ['no_rate', 'labour_hourly_invalid',      '{"pay":"hourly_capped","amount_ex_gst":800,"hourly":{"max_hours":10,"max_ex_gst":800},"work_order_amount_ex_gst":800}'],
    ['no_hours', 'labour_hourly_invalid',     '{"pay":"hourly_capped","amount_ex_gst":800,"hourly":{"rate_ex_gst":80,"max_ex_gst":800},"work_order_amount_ex_gst":800}'],
    ['no_max', 'labour_hourly_invalid',       '{"pay":"hourly_capped","amount_ex_gst":800,"hourly":{"rate_ex_gst":80,"max_hours":10},"work_order_amount_ex_gst":800}'],
    ['text_max', 'labour_hourly_invalid',     '{"pay":"hourly_capped","amount_ex_gst":800,"hourly":{"rate_ex_gst":80,"max_hours":10,"max_ex_gst":"800"},"work_order_amount_ex_gst":800}'],
    ['no_amount', 'labour_hourly_invalid',    '{"pay":"hourly_capped","hourly":{"rate_ex_gst":80,"max_hours":10,"max_ex_gst":800},"work_order_amount_ex_gst":800}'],
    ['under_max', 'labour_hourly_mismatch',    '{"pay":"hourly_capped","amount_ex_gst":700,"hourly":{"rate_ex_gst":80,"max_hours":10,"max_ex_gst":800},"work_order_amount_ex_gst":700}'],
    -- An older writer's record: 70 x 4 is 280, but the maximum says 2800.
    ['rate_x_hours', 'labour_hourly_mismatch', '{"pay":"hourly_capped","amount_ex_gst":2800,"hourly":{"rate_ex_gst":70,"max_hours":4,"max_ex_gst":2800},"work_order_amount_ex_gst":2800}'],
    ['one_cent_off', 'labour_hourly_mismatch', '{"pay":"hourly_capped","amount_ex_gst":800.01,"hourly":{"rate_ex_gst":80,"max_hours":10,"max_ex_gst":800.01},"work_order_amount_ex_gst":800.01}'],
    ['part_cent',    'labour_hourly_invalid',  '{"pay":"hourly_capped","amount_ex_gst":800.005,"hourly":{"rate_ex_gst":80.0005,"max_hours":10,"max_ex_gst":800.005},"work_order_amount_ex_gst":800.005}'],
    ['zero_rate',    'labour_hourly_invalid',  '{"pay":"hourly_capped","amount_ex_gst":0,"hourly":{"rate_ex_gst":0,"max_hours":10,"max_ex_gst":0},"work_order_amount_ex_gst":0}'],
    -- Rate and hours to the cent: 72.5 x 7.25 = 525.625, stored as 525.63.
    ['cents_ok',     '', '{"pay":"hourly_capped","amount_ex_gst":525.63,"hourly":{"rate_ex_gst":72.5,"max_hours":7.25,"max_ex_gst":525.63},"work_order_amount_ex_gst":525.63}']
  ];
  i      int;
  job    uuid;
  rev    uuid;
  st     jsonb;
BEGIN
  FOR i IN 1 .. array_length(cases, 1) LOOP
    job := ('00000000-0000-0000-0000-00000000c9' || lpad(to_hex(i), 2, '0'))::uuid;
    rev := ('00000000-0000-0000-0000-00000000ca' || lpad(to_hex(i), 2, '0'))::uuid;
    INSERT INTO public.jobs (id, org_id, status, type, job_number)
    VALUES (job, '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'ZZTEST-C5' || i);
    INSERT INTO public.scope_revisions (id, job_id, revision_number, status, scope_canonical_text, pricing_canonical_text, scope_hash, pricing_hash)
    VALUES (rev, job, 1, 'frozen', '{}', '{"p":' || i || '}',
            encode(sha256(convert_to('{}', 'UTF8')), 'hex'), encode(sha256(convert_to('{"p":' || i || '}', 'UTF8')), 'hex'));
    INSERT INTO public.job_budgets (id, job_id, scope_revision_id, version, pricing_hash, trade, complete, gap_count, budget)
    VALUES (gen_random_uuid(), job, rev, 1, repeat('d', 64), 'fence', true, 0,
            jsonb_build_object('version', 'budget.v1', 'labour', cases[i][3]::jsonb));
    st := public.job_labour_cap_state(job);

    IF cases[i][1] = 'options' THEN
      -- 70 x 40 = 2800, plus a 250 crew option: the crew may bill 3050.
      IF st->>'state' <> 'capped' OR (st->>'max_ex_gst')::numeric <> 2800
         OR (st->>'crew_options_ex_gst')::numeric <> 250 OR (st->>'cap_ex_gst')::numeric <> 3050
         OR jsonb_typeof(st->'unreadable_reason') <> 'null' THEN
        RAISE EXCEPTION 'labour cap contract: a taken crew option is not inside the cap: %', st;
      END IF;
    ELSIF cases[i][1] = 'cents_ok' THEN
      IF st->>'state' <> 'capped' OR (st->>'cap_ex_gst')::numeric <> 525.63
         OR jsonb_typeof(st->'unreadable_reason') <> 'null' THEN
        RAISE EXCEPTION 'labour cap contract: a maximum of rate x hours to the cent did not read as capped: %', st;
      END IF;
    ELSE
      IF st->>'state' <> 'capped_unreadable' OR jsonb_typeof(st->'cap_ex_gst') <> 'number'
         OR (st->>'cap_ex_gst')::numeric <> 0 OR (st->>'max_ex_gst')::numeric <> 0
         OR st->>'unreadable_reason' IS DISTINCT FROM cases[i][2] THEN
        RAISE EXCEPTION 'labour cap contract: % did not read as unreadable (%) with a zero cap: %', cases[i][1], cases[i][2], st;
      END IF;
    END IF;
  END LOOP;
END $$;
ROLLBACK;
