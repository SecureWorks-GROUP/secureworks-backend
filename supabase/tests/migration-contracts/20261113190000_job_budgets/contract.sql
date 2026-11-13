-- Contract for 20261113190000_job_budgets.sql. Every fixture write is inside a
-- transaction that rolls back.

-- 1. Row-level security, one service-role policy per table, no browser role can
-- read or write a budget, the view or the writer.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['job_budgets', 'job_budget_lines'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION 'job budget contract: row-level security is off on %', t;
    END IF;
    IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = t) <> 1
       OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t
                   AND NOT (roles = ARRAY['service_role']::name[])) THEN
      RAISE EXCEPTION 'job budget contract: % must carry exactly one service-role policy', t;
    END IF;
    IF has_table_privilege('anon', 'public.' || t, 'SELECT') OR has_table_privilege('authenticated', 'public.' || t, 'SELECT')
       OR has_table_privilege('anon', 'public.' || t, 'INSERT') OR has_table_privilege('authenticated', 'public.' || t, 'INSERT') THEN
      RAISE EXCEPTION 'job budget contract: a browser role can read or write %', t;
    END IF;
  END LOOP;
  IF has_table_privilege('anon', 'public.v_job_budget', 'SELECT')
     OR has_table_privilege('authenticated', 'public.v_job_budget', 'SELECT') THEN
    RAISE EXCEPTION 'job budget contract: a browser role can read v_job_budget';
  END IF;
  IF has_function_privilege('anon', 'public.record_job_budget(uuid, uuid, text, text[], jsonb, jsonb, jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.record_job_budget(uuid, uuid, text, text[], jsonb, jsonb, jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.record_job_budget(uuid, uuid, text, text[], jsonb, jsonb, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'job budget contract: the writer must be service-role only';
  END IF;
END $$;

-- 2. The writer stores the header and every line, replays, refuses a conflict, a
-- wrong revision and a third decimal; the record is write-once; the view shows the
-- current version, or the refusal code for a job that has none.
BEGIN;
INSERT INTO public.jobs (id, org_id, status, type, job_number)
VALUES ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-000000000001', 'accepted', 'patio', 'ZZTEST-B001'),
       ('00000000-0000-0000-0000-00000000b002', '00000000-0000-0000-0000-000000000001', 'accepted', 'patio', 'ZZTEST-B002');
INSERT INTO public.scope_revisions (id, job_id, revision_number, status, scope_canonical_text, pricing_canonical_text, scope_hash, pricing_hash)
VALUES ('00000000-0000-0000-0000-00000000b101', '00000000-0000-0000-0000-00000000b001', 1, 'frozen', '{}', '{"p":1}',
        encode(sha256(convert_to('{}', 'UTF8')), 'hex'), encode(sha256(convert_to('{"p":1}', 'UTF8')), 'hex')),
       ('00000000-0000-0000-0000-00000000b102', '00000000-0000-0000-0000-00000000b001', 2, 'frozen', '{}', '{"p":2}',
        encode(sha256(convert_to('{}', 'UTF8')), 'hex'), encode(sha256(convert_to('{"p":2}', 'UTF8')), 'hex'));
INSERT INTO public.job_events (id, job_id, event_type, detail_json, created_at)
VALUES (gen_random_uuid(), '00000000-0000-0000-0000-00000000b002', 'job_budget_refused',
        '{"code":"gst_mismatch","scope_revision_id":"00000000-0000-0000-0000-00000000b109"}'::jsonb, now());
DO $$
DECLARE
  job  uuid := '00000000-0000-0000-0000-00000000b001';
  rev1 uuid := '00000000-0000-0000-0000-00000000b101';
  rev2 uuid := '00000000-0000-0000-0000-00000000b102';
  h1 text := encode(sha256(convert_to('{"p":1}', 'UTF8')), 'hex');
  h2 text := encode(sha256(convert_to('{"p":2}', 'UTF8')), 'hex');
  budget jsonb := '{"version":"budget.v1","trade":"patio","gaps":[],"materials":{"by_supplier":[{"key":"sup-a","total_ex_gst":3165}]},"other":[{"lane":"buffer","total_ex_gst":200}]}'::jsonb;
  summary jsonb := '{"trade":"patio","complete":true,"gap_count":0,"sell_ex_gst":10000,"gst":1000,"total_inc_gst":11000,
    "materials_ex_gst":3165,"labour_ex_gst":2800,"work_order_ex_gst":2800,"other_ex_gst":550,
    "cost_before_commission_ex_gst":6515,"gross_profit_ex_gst":3485,"gross_profit_pct":34.85,
    "commission_rule_id":"patio_commission_rate","commission_pct":8,"commission_ex_gst":278.8,
    "profit_after_commission_ex_gst":3206.2,"profit_after_commission_pct":32.06,
    "scoped_by_staff_id":"22222222-2222-4222-8222-222222222222","salesperson_staff_id":"22222222-2222-4222-8222-222222222222"}'::jsonb;
  lines jsonb := '[{"lane":"materials","key":"m1","line_id":"sl-1","supplier_key":"sup-a","kind":"item","supplier_id":"sup-a","supplier_name":"Supplier A","description":"Roof sheets","quantity":10,"unit":"each","unit_cost_ex_gst":200,"cost_ex_gst":2000,"in_total":true,"cost_from":"supplier_price"},
                   {"lane":"labour","key":"l1","description":"Build","cost_ex_gst":2800,"in_total":true,"paid_to":"crew"},
                   {"lane":"buffer","key":"b1","description":"Job buffer","cost_ex_gst":200,"in_total":true,"paid_to":"office"}]'::jsonb;
  r jsonb;
  v record;
  refused boolean;
BEGIN
  r := public.record_job_budget(job, rev1, h1, ARRAY[]::text[], budget, summary, lines);
  IF (r->>'recorded')::boolean IS NOT TRUE OR (r->>'version')::int <> 1 THEN
    RAISE EXCEPTION 'job budget contract: the first budget was not recorded as version 1: %', r;
  END IF;
  IF (SELECT count(*) FROM public.job_budget_lines WHERE budget_id = (r->>'budget_id')::uuid) <> 3 THEN
    RAISE EXCEPTION 'job budget contract: the lines were not all stored';
  END IF;

  -- The same budget again is a replay, not a second row.
  r := public.record_job_budget(job, rev1, h1, ARRAY[]::text[], budget, summary, lines);
  IF (r->>'replayed')::boolean IS NOT TRUE OR (SELECT count(*) FROM public.job_budgets WHERE job_id = job) <> 1 THEN
    RAISE EXCEPTION 'job budget contract: a replay was not idempotent: %', r;
  END IF;

  -- A different budget for the same revision is a conflict.
  refused := false;
  BEGIN
    PERFORM public.record_job_budget(job, rev1, h1, ARRAY['o1'], budget, summary, lines);
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM = 'job_budget_conflict';
  END;
  IF NOT refused THEN RAISE EXCEPTION 'job budget contract: a conflicting budget was not refused'; END IF;

  -- A hash that is not the revision's is refused.
  refused := false;
  BEGIN
    PERFORM public.record_job_budget(job, rev2, h1, ARRAY[]::text[], budget, summary, lines);
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM = 'job_budget_revision_mismatch';
  END;
  IF NOT refused THEN RAISE EXCEPTION 'job budget contract: a wrong pricing hash was not refused'; END IF;

  -- A third decimal place is refused, never rounded.
  refused := false;
  BEGIN
    PERFORM public.record_job_budget(job, rev2, h2, ARRAY[]::text[], budget,
      jsonb_set(summary, '{commission_ex_gst}', '278.805'), lines);
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM = 'job_budget_money_not_two_decimals';
  END;
  IF NOT refused THEN RAISE EXCEPTION 'job budget contract: a third decimal was not refused'; END IF;
  refused := false;
  BEGIN
    PERFORM public.record_job_budget(job, rev2, h2, ARRAY[]::text[], budget, summary,
      jsonb_set(lines, '{0,cost_ex_gst}', '2000.001'));
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM = 'job_budget_money_not_two_decimals';
  END;
  IF NOT refused THEN RAISE EXCEPTION 'job budget contract: a third decimal on a line was not refused'; END IF;

  -- Sums that do not add up are refused by the table itself.
  refused := false;
  BEGIN
    PERFORM public.record_job_budget(job, rev2, h2, ARRAY[]::text[], budget,
      jsonb_set(summary, '{total_inc_gst}', '11001'), lines);
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'job budget contract: a total that is not sell plus GST was stored'; END IF;
  refused := false;
  BEGIN
    PERFORM public.record_job_budget(job, rev2, h2, ARRAY[]::text[], budget,
      summary || '{"gross_profit_ex_gst":-100,"cost_before_commission_ex_gst":10100,"profit_after_commission_ex_gst":-378.8}'::jsonb, lines);
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'job budget contract: commission on a loss was stored'; END IF;
  refused := false;
  BEGIN
    PERFORM public.record_job_budget(job, rev2, h2, ARRAY[]::text[], budget, summary,
      lines || '[{"lane":"labour","key":"m1","cost_ex_gst":1,"in_total":true}]'::jsonb);
  EXCEPTION WHEN unique_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'job budget contract: two lines with one key were stored'; END IF;
  refused := false;
  BEGIN
    PERFORM public.record_job_budget(job, rev2, h2, ARRAY[]::text[], budget, summary,
      lines || '[{"lane":"materials","key":"m9","supplier_key":"sup-a","kind":"freight","cost_ex_gst":1,"in_total":true}]'::jsonb);
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'job budget contract: a materials line of an unknown kind was stored'; END IF;
  refused := false;
  BEGIN
    PERFORM public.record_job_budget(job, rev2, h2, ARRAY[]::text[], budget, summary,
      lines || '[{"lane":"materials","key":"m9","supplier_key":"sup-a","cost_ex_gst":1,"in_total":true}]'::jsonb);
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'job budget contract: a materials line with no kind was stored'; END IF;

  -- A later accepted revision is version 2 and becomes the current one.
  r := public.record_job_budget(job, rev2, h2, ARRAY['o1'], budget, summary, lines);
  IF (r->>'version')::int <> 2 THEN
    RAISE EXCEPTION 'job budget contract: the second budget was not version 2: %', r;
  END IF;
  SELECT * INTO v FROM public.v_job_budget WHERE job_id = job;
  IF v.state <> 'budget' OR v.version <> 2 OR v.taken_option_ids <> ARRAY['o1']
     OR v.sell_ex_gst <> 10000 OR v.commission_ex_gst <> 278.8
     OR (v.lane_totals->>'buffer')::numeric <> 200 OR (v.lane_totals->>'materials')::numeric <> 3165
     OR jsonb_array_length(v.by_supplier) <> 1 THEN
    RAISE EXCEPTION 'job budget contract: v_job_budget does not show the current version';
  END IF;
  IF (SELECT count(*) FROM public.v_job_budget WHERE job_id = job) <> 1 THEN
    RAISE EXCEPTION 'job budget contract: v_job_budget shows more than one row for a job';
  END IF;

  -- A job whose budget was refused shows the code, never "no budget".
  SELECT * INTO v FROM public.v_job_budget WHERE job_id = '00000000-0000-0000-0000-00000000b002';
  IF v.state IS DISTINCT FROM 'refused' OR v.refused_code IS DISTINCT FROM 'gst_mismatch'
     OR v.state_label IS DISTINCT FROM 'budget refused: gst_mismatch' THEN
    RAISE EXCEPTION 'job budget contract: a refused budget does not show its code';
  END IF;

  -- Write-once: no edit, no delete, on either table.
  refused := false;
  BEGIN
    UPDATE public.job_budgets SET commission_rule_id = 'changed' WHERE job_id = job;
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'job budget contract: a stored budget was changed'; END IF;
  refused := false;
  BEGIN
    DELETE FROM public.job_budget_lines WHERE job_id = job;
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'job budget contract: a stored budget line was removed'; END IF;
END $$;
ROLLBACK;
