-- Contract for 20261114040000_job_profit_expected_from_budget.sql. Every fixture write is inside a transaction
-- that rolls back.

-- 1. The switch is seeded off, the view is exactly the replaced text, and it stays service role only.
DO $$
BEGIN
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'job_profit_expected_from_job_budget') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'job budget contract: the switch must be seeded off';
  END IF;
  IF md5(pg_get_viewdef('public.v_job_profit'::regclass, true)) <> '578270db501761330fad0b46412aac95' THEN
    RAISE EXCEPTION 'job budget contract: v_job_profit is not the 20261114040000 definition (md5 %)',
      md5(pg_get_viewdef('public.v_job_profit'::regclass, true));
  END IF;
  IF has_table_privilege('anon', 'public.v_job_profit', 'SELECT')
     OR has_table_privilege('authenticated', 'public.v_job_profit', 'SELECT') THEN
    RAISE EXCEPTION 'job budget contract: v_job_profit must stay service role only (the budget carries commission)';
  END IF;
END $$;

BEGIN;
-- J1 budget, every lane known. J2 two versions (the newest is read). J3 a budget with no labour cost.
-- J4 a budget whose skip line has no cost (materials, the work order and commission known). J5 no budget.
-- Every job also has a cost fixed at acceptance, the source each read before this migration.
INSERT INTO public.jobs (id, org_id, status, type, job_number, expected_costs)
SELECT v.id::uuid, '00000000-0000-0000-0000-000000000001'::uuid, 'accepted', 'fencing', v.num,
       '{"lanes":{"labour":{"amount_ex_gst":1000},"materials":{"amount_ex_gst":1100},"commission":{"amount_ex_gst":120}}}'::jsonb
  FROM (VALUES ('00000000-0000-0000-0000-00000000c501', 'ZZTEST-C501'),
               ('00000000-0000-0000-0000-00000000c502', 'ZZTEST-C502'),
               ('00000000-0000-0000-0000-00000000c503', 'ZZTEST-C503'),
               ('00000000-0000-0000-0000-00000000c504', 'ZZTEST-C504'),
               ('00000000-0000-0000-0000-00000000c505', 'ZZTEST-C505')) AS v(id, num);
INSERT INTO public.scope_revisions (id, job_id, revision_number, status, scope_canonical_text, pricing_canonical_text, scope_hash, pricing_hash)
SELECT v.id::uuid, v.job::uuid, v.n, 'frozen', '{}', v.p,
       encode(sha256(convert_to('{}', 'UTF8')), 'hex'), encode(sha256(convert_to(v.p, 'UTF8')), 'hex')
  FROM (VALUES ('00000000-0000-0000-0000-00000000c511', '00000000-0000-0000-0000-00000000c501', 1, '{"p":51}'),
               ('00000000-0000-0000-0000-00000000c521', '00000000-0000-0000-0000-00000000c502', 1, '{"p":52}'),
               ('00000000-0000-0000-0000-00000000c522', '00000000-0000-0000-0000-00000000c502', 2, '{"p":53}'),
               ('00000000-0000-0000-0000-00000000c531', '00000000-0000-0000-0000-00000000c503', 1, '{"p":54}'),
               ('00000000-0000-0000-0000-00000000c541', '00000000-0000-0000-0000-00000000c504', 1, '{"p":55}')) AS v(id, job, n, p);
-- J1: sell 10000; materials 3000; labour 2000; removal 300 paid to the crew, skip 200 paid by the office:
-- work order 2300, other lanes 500, cost before commission 5500, gross profit 4500, commission 675.
INSERT INTO public.job_budgets (id, job_id, scope_revision_id, version, pricing_hash, trade, complete, gap_count,
       sell_ex_gst, gst, total_inc_gst, materials_ex_gst, labour_ex_gst, work_order_ex_gst, other_ex_gst,
       cost_before_commission_ex_gst, gross_profit_ex_gst, gross_profit_pct, commission_pct, commission_ex_gst,
       profit_after_commission_ex_gst, profit_after_commission_pct, budget)
VALUES ('00000000-0000-0000-0000-00000000c551', '00000000-0000-0000-0000-00000000c501', '00000000-0000-0000-0000-00000000c511', 1,
        repeat('a', 64), 'fence', true, 0, 10000, 1000, 11000, 3000, 2000, 2300, 500, 5500, 4500, 45, 15, 675, 3825, 38.25,
        '{"version":"budget.v1"}'::jsonb),
       ('00000000-0000-0000-0000-00000000c552', '00000000-0000-0000-0000-00000000c502', '00000000-0000-0000-0000-00000000c521', 1,
        repeat('b', 64), 'fence', true, 0, 8000, 800, 8800, 2000, 1500, 1500, 0, 3500, 4500, 56.25, 15, 675, 3825, 47.81,
        '{"version":"budget.v1"}'::jsonb),
       ('00000000-0000-0000-0000-00000000c553', '00000000-0000-0000-0000-00000000c502', '00000000-0000-0000-0000-00000000c522', 2,
        repeat('c', 64), 'fence', true, 0, 9000, 900, 9900, 2500, 1800, 1800, 0, 4300, 4700, 52.22, 15, 705, 3995, 44.39,
        '{"version":"budget.v1"}'::jsonb),
       ('00000000-0000-0000-0000-00000000c554', '00000000-0000-0000-0000-00000000c503', '00000000-0000-0000-0000-00000000c531', 1,
        repeat('d', 64), 'fence', false, 1, 7000, 700, 7700, 2000, NULL, NULL, 0, NULL, NULL, NULL, 15, NULL, NULL, NULL,
        '{"version":"budget.v1"}'::jsonb),
       ('00000000-0000-0000-0000-00000000c555', '00000000-0000-0000-0000-00000000c504', '00000000-0000-0000-0000-00000000c541', 1,
        repeat('e', 64), 'fence', false, 1, 7000, 700, 7700, 2000, 1500, 1500, NULL, NULL, NULL, NULL, 15, 600, NULL, NULL,
        '{"version":"budget.v1"}'::jsonb);

-- 2. Switch off: every job reads exactly as before (the cost fixed at acceptance), nothing from the budget.
CREATE TEMP TABLE c5_off ON COMMIT DROP AS
SELECT p.job_id, to_jsonb(p) AS row FROM public.v_job_profit p WHERE p.job_number LIKE 'ZZTEST-C50%';
DO $$
DECLARE r record;
BEGIN
  IF (SELECT count(*) FROM c5_off) <> 5 THEN
    RAISE EXCEPTION 'job budget contract: the five jobs are not all in v_job_profit';
  END IF;
  FOR r IN SELECT row FROM c5_off LOOP
    IF r.row->>'expected_source' IS DISTINCT FROM 'frozen_at_acceptance'
       OR (r.row->>'expected_cost_ex')::numeric <> 2220
       OR r.row->>'expected_other_ex' IS NOT NULL OR r.row->>'expected_budget_id' IS NOT NULL
       OR r.row->>'budget_gross_profit_ex' IS NOT NULL THEN
      RAISE EXCEPTION 'job budget contract: with the switch off a budget was read: %', r.row;
    END IF;
  END LOOP;
END $$;

-- 3. Switch on: the budget is the first source.
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_profit_expected_from_job_budget';
DO $$
DECLARE p record;
BEGIN
  SELECT * INTO p FROM public.v_job_profit WHERE job_number = 'ZZTEST-C501';
  IF p.expected_source IS DISTINCT FROM 'job_budget'
     OR p.expected_labour_ex IS DISTINCT FROM 2300::numeric
     OR p.expected_materials_ex IS DISTINCT FROM 3000::numeric
     OR p.expected_commission_ex IS DISTINCT FROM 675::numeric
     OR p.expected_other_ex IS DISTINCT FROM 200::numeric
     OR p.expected_cost_ex IS DISTINCT FROM 6175::numeric
     OR p.expected_cost_with_variations_ex IS DISTINCT FROM 6175::numeric
     OR p.budget_gross_profit_ex IS DISTINCT FROM 4500::numeric
     OR p.expected_budget_id IS DISTINCT FROM '00000000-0000-0000-0000-00000000c551'::uuid
     OR 'expected_cost_lane_missing' = ANY (p.completeness) THEN
    RAISE EXCEPTION 'job budget contract: J1 did not read its budget: % % % % % % % %', p.expected_source, p.expected_labour_ex,
      p.expected_materials_ex, p.expected_commission_ex, p.expected_other_ex, p.expected_cost_ex, p.budget_gross_profit_ex,
      p.completeness;
  END IF;

  -- The newest version is read.
  SELECT * INTO p FROM public.v_job_profit WHERE job_number = 'ZZTEST-C502';
  IF p.expected_budget_id IS DISTINCT FROM '00000000-0000-0000-0000-00000000c553'::uuid
     OR p.expected_labour_ex IS DISTINCT FROM 1800::numeric OR p.expected_cost_ex IS DISTINCT FROM 5005::numeric
     OR p.budget_gross_profit_ex IS DISTINCT FROM 4700::numeric THEN
    RAISE EXCEPTION 'job budget contract: J2 did not read its newest budget: % % %', p.expected_budget_id, p.expected_cost_ex,
      p.budget_gross_profit_ex;
  END IF;

  -- A budget lane that is not known is named, never read as 0 or taken from an older source.
  SELECT * INTO p FROM public.v_job_profit WHERE job_number = 'ZZTEST-C503';
  IF p.expected_source IS DISTINCT FROM 'job_budget' OR p.expected_labour_ex IS NOT NULL
     OR NOT ('expected_cost_lane_missing' = ANY (p.completeness)) THEN
    RAISE EXCEPTION 'job budget contract: J3 (no labour cost) reads % % %', p.expected_source, p.expected_labour_ex, p.completeness;
  END IF;
  SELECT * INTO p FROM public.v_job_profit WHERE job_number = 'ZZTEST-C504';
  IF p.expected_source IS DISTINCT FROM 'job_budget' OR p.expected_other_ex IS NOT NULL
     OR p.expected_labour_ex IS DISTINCT FROM 1500::numeric OR p.expected_commission_ex IS DISTINCT FROM 600::numeric
     OR NOT ('expected_cost_lane_missing' = ANY (p.completeness)) THEN
    RAISE EXCEPTION 'job budget contract: J4 (a skip line with no cost) reads % % %', p.expected_source, p.expected_other_ex,
      p.completeness;
  END IF;

  -- A job with no budget reads exactly what it read with the switch off.
  IF (SELECT to_jsonb(v) FROM public.v_job_profit v WHERE v.job_number = 'ZZTEST-C505')
     IS DISTINCT FROM (SELECT row FROM c5_off o WHERE o.row->>'job_number' = 'ZZTEST-C505') THEN
    RAISE EXCEPTION 'job budget contract: a job with no budget changed with the switch on';
  END IF;
END $$;
ROLLBACK;
