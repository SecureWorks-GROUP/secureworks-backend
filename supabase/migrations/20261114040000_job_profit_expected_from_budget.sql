-- Ruling 17 step 5: the job budget is Job Profit's first expected source.
--
-- A job whose accepted quote stored a budget (job_budgets, 20261113190000) takes its expected costs from
-- that budget's newest version, ahead of every older source (jobs.expected_costs, the accepted quote
-- revision, the sent quote revision, the sealed patio scope). A job with no budget reads exactly as before.
-- Change, read only views, no table and no row except one switch:
--   1. feature_flags.job_profit_expected_from_job_budget, seeded OFF. While it is off (or missing) no budget
--      is read and every v_job_profit row is what it was before this migration.
--   2. v_job_profit, with the switch on, for a job with a budget:
--        expected_source         'job_budget'
--        expected_labour_ex      the budget's work order amount (labour plus the other lines paid to the
--                                crew), because that is what the crew bills and what actual labour counts
--        expected_materials_ex   the budget's materials (every supplier, delivery and cutting included)
--        expected_commission_ex  the budget's commission
--      and appends three columns, NULL for a job with no budget (and for every job while the switch is off):
--        expected_other_ex       the budget's other lanes not paid to the crew (delivery, removal, skip and
--                                tip, hire, buffer, other): cost before commission less materials less the
--                                work order amount
--        expected_budget_id      the job_budgets row read
--        budget_gross_profit_ex  the budget's gross profit (sell less cost before commission), ex GST
--      expected_cost_ex and expected_cost_with_variations_ex add expected_other_ex, so a budget job's
--      expected cost is the budget's cost before commission plus its commission. A budget lane that is not
--      known (a line with no cost) names expected_cost_lane_missing, as for every other source.
-- Profit and margin are still invoiced less actual cost; these are expected figures only. No operator share
-- of gross profit is read or shown. The budget carries commission and the salesperson: v_job_profit stays
-- service role only, and no customer, trade or crew read reaches it.
--
-- Guard: v_job_profit must be 20261111100000's definition (pg_get_viewdef(..., true), UTC,
-- ef8c3682ff4da148ffe42635eb404abe in production and the contract stack). Each replaced fragment must be
-- there the stated number of times, and the view after the change must be exactly the replaced text
-- (so the rollback can put the fragments back). Re-running it is a no-op.
-- Rollback: supabase/rollbacks/20261114040000_job_profit_expected_from_budget_down.sql.

SET LOCAL lock_timeout = '5s';
SET LOCAL TimeZone = 'UTC';

INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES
  ('job_profit_expected_from_job_budget', false,
   'Ruling 17 step 5: Job Profit takes a job''s expected costs from its job budget first (labour = the work order amount, materials, commission, and the other lanes not paid to the crew). Off until the owner says.')
ON CONFLICT (flag_name) DO NOTHING;

DO $mig$
DECLARE
  v_def text;
  v_new text;
  v_before constant text := 'ef8c3682ff4da148ffe42635eb404abe';
  o1 constant text := $o1$        ), quote_docs AS ($o1$;
  n1 constant text := $n1$        ), budget_rev AS (
         SELECT DISTINCT ON (b.job_id) b.job_id,
            b.id AS budget_id,
            b.work_order_ex_gst,
            b.materials_ex_gst,
            b.commission_ex_gst,
            b.cost_before_commission_ex_gst - b.materials_ex_gst - b.work_order_ex_gst AS other_ex,
            b.gross_profit_ex_gst
           FROM job_budgets b
          WHERE (EXISTS ( SELECT 1
                   FROM feature_flags ff
                  WHERE ff.flag_name = 'job_profit_expected_from_job_budget'::text AND ff.enabled))
          ORDER BY b.job_id, b.version DESC
        ), quote_docs AS ($n1$;
  o2 constant text := $o2$                    WHEN jsonb_typeof(j.expected_costs -> 'lanes'::text) = 'object'::text THEN 'frozen_at_acceptance'::text$o2$;
  n2 constant text := $n2$                    WHEN bg.job_id IS NOT NULL THEN 'job_budget'::text
                    WHEN jsonb_typeof(j.expected_costs -> 'lanes'::text) = 'object'::text THEN 'frozen_at_acceptance'::text$n2$;
  o3 constant text := $o3$                    WHEN jsonb_typeof(j.expected_costs -> 'lanes'::text) = 'object'::text THEN job_profit_num(j.expected_costs #> '{lanes,labour,amount_ex_gst}'::text[])$o3$;
  n3 constant text := $n3$                    WHEN bg.job_id IS NOT NULL THEN bg.work_order_ex_gst
                    WHEN jsonb_typeof(j.expected_costs -> 'lanes'::text) = 'object'::text THEN job_profit_num(j.expected_costs #> '{lanes,labour,amount_ex_gst}'::text[])$n3$;
  o4 constant text := $o4$                    WHEN jsonb_typeof(j.expected_costs -> 'lanes'::text) = 'object'::text THEN job_profit_num(j.expected_costs #> '{lanes,materials,amount_ex_gst}'::text[])$o4$;
  n4 constant text := $n4$                    WHEN bg.job_id IS NOT NULL THEN bg.materials_ex_gst
                    WHEN jsonb_typeof(j.expected_costs -> 'lanes'::text) = 'object'::text THEN job_profit_num(j.expected_costs #> '{lanes,materials,amount_ex_gst}'::text[])$n4$;
  o5 constant text := $o5$                    WHEN jsonb_typeof(j.expected_costs -> 'lanes'::text) = 'object'::text THEN job_profit_num(j.expected_costs #> '{lanes,commission,amount_ex_gst}'::text[])$o5$;
  n5 constant text := $n5$                    WHEN bg.job_id IS NOT NULL THEN bg.commission_ex_gst
                    WHEN jsonb_typeof(j.expected_costs -> 'lanes'::text) = 'object'::text THEN job_profit_num(j.expected_costs #> '{lanes,commission,amount_ex_gst}'::text[])$n5$;
  o6 constant text := $o6$                END AS expected_commission_ex,
            job_profit_num(j.pricing_json -> 'materialCostEstimate'::text) AS live_materials_estimate_ex,$o6$;
  n6 constant text := $n6$                END AS expected_commission_ex,
            bg.other_ex AS expected_other_ex,
            bg.budget_id AS expected_budget_id,
            bg.gross_profit_ex_gst AS budget_gross_profit_ex,
            job_profit_num(j.pricing_json -> 'materialCostEstimate'::text) AS live_materials_estimate_ex,$n6$;
  o7 constant text := $o7$             LEFT JOIN frozen_scope_rev fz ON fz.job_id = j.id$o7$;
  n7 constant text := $n7$             LEFT JOIN frozen_scope_rev fz ON fz.job_id = j.id
             LEFT JOIN budget_rev bg ON bg.job_id = j.id$n7$;
  o8 constant text := $o8$            b.expected_commission_ex,$o8$;
  n8 constant text := $n8$            b.expected_commission_ex,
            b.expected_other_ex,
            b.expected_budget_id,
            b.budget_gross_profit_ex,$n8$;
  o9 constant text := $o9$            s.expected_commission_ex,$o9$;
  n9 constant text := $n9$            s.expected_commission_ex,
            s.expected_other_ex,
            s.expected_budget_id,
            s.budget_gross_profit_ex,$n9$;
  -- held and flagged both list c.expected_commission_ex: two occurrences, the same change.
  o10 constant text := $o10$            c.expected_commission_ex,$o10$;
  n10 constant text := $n10$            c.expected_commission_ex,
            c.expected_other_ex,
            c.expected_budget_id,
            c.budget_gross_profit_ex,$n10$;
  o11 constant text := $o11$            WHEN expected_source IS NOT NULL THEN COALESCE(expected_labour_ex, 0::numeric) + COALESCE(expected_materials_ex, 0::numeric) + COALESCE(expected_commission_ex, 0::numeric)
            ELSE NULL::numeric
        END AS expected_cost_ex,$o11$;
  n11 constant text := $n11$            WHEN expected_source IS NOT NULL THEN COALESCE(expected_labour_ex, 0::numeric) + COALESCE(expected_materials_ex, 0::numeric) + COALESCE(expected_commission_ex, 0::numeric) + COALESCE(expected_other_ex, 0::numeric)
            ELSE NULL::numeric
        END AS expected_cost_ex,$n11$;
  o12 constant text := $o12$            WHEN expected_source IS NOT NULL AND (expected_labour_ex IS NULL OR expected_materials_ex IS NULL OR expected_commission_ex IS NULL) THEN 'expected_cost_lane_missing'::text$o12$;
  n12 constant text := $n12$            WHEN expected_source IS NOT NULL AND (expected_labour_ex IS NULL OR expected_materials_ex IS NULL OR expected_commission_ex IS NULL OR expected_source = 'job_budget'::text AND expected_other_ex IS NULL) THEN 'expected_cost_lane_missing'::text$n12$;
  o13 constant text := $o13$COALESCE(expected_commission_ex, 0::numeric) + COALESCE(( SELECT sum(cv.trade_allocation_ex) AS sum$o13$;
  n13 constant text := $n13$COALESCE(expected_commission_ex, 0::numeric) + COALESCE(expected_other_ex, 0::numeric) + COALESCE(( SELECT sum(cv.trade_allocation_ex) AS sum$n13$;
  o14 constant text := $o14$        END AS expected_cost_with_variations_ex
   FROM flagged f;$o14$;
  n14 constant text := $n14$        END AS expected_cost_with_variations_ex,
    expected_other_ex,
    expected_budget_id,
    budget_gross_profit_ex
   FROM flagged f;$n14$;
  olds constant text[] := ARRAY[o1, o2, o3, o4, o5, o6, o7, o8, o9, o10, o11, o12, o13, o14];
  news constant text[] := ARRAY[n1, n2, n3, n4, n5, n6, n7, n8, n9, n10, n11, n12, n13, n14];
  times constant int[] := ARRAY[1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1];
  i int;
BEGIN
  IF to_regclass('public.job_budgets') IS NULL THEN
    RAISE EXCEPTION 'job_budgets is missing: apply 20261113190000 first';
  END IF;
  v_def := pg_get_viewdef('public.v_job_profit'::regclass, true);
  IF strpos(v_def, 'budget_rev AS (') > 0 THEN
    RAISE NOTICE 'v_job_profit already reads the job budget first';
    RETURN;
  END IF;
  IF md5(v_def) <> v_before THEN
    RAISE EXCEPTION 'v_job_profit is not the definition this migration was written against (md5 %)', md5(v_def);
  END IF;
  v_new := v_def;
  FOR i IN 1 .. array_length(olds, 1) LOOP
    IF (length(v_new) - length(replace(v_new, olds[i], ''))) / length(olds[i]) <> times[i] THEN
      RAISE EXCEPTION 'v_job_profit: replaced fragment % is not there % time(s)', i, times[i];
    END IF;
    v_new := replace(v_new, olds[i], news[i]);
  END LOOP;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_profit AS ' || v_new;
  IF pg_get_viewdef('public.v_job_profit'::regclass, true) <> v_new THEN
    RAISE EXCEPTION 'v_job_profit after the change is not exactly the replaced text (md5 % against %)',
      md5(pg_get_viewdef('public.v_job_profit'::regclass, true)), md5(v_new);
  END IF;
  RAISE NOTICE 'v_job_profit now reads the job budget first (md5 %)', md5(v_new);
END
$mig$;

COMMENT ON COLUMN public.v_job_profit.expected_other_ex IS
  'Ruling 17 step 5 (20261114040000): with a job budget read, its other lanes not paid to the crew (cost before commission less materials less the work order amount), ex GST. NULL without a budget.';
COMMENT ON COLUMN public.v_job_profit.expected_budget_id IS
  'Ruling 17 step 5 (20261114040000): the job_budgets row the expected costs were read from, while job_profit_expected_from_job_budget is on. NULL otherwise.';
COMMENT ON COLUMN public.v_job_profit.budget_gross_profit_ex IS
  'Ruling 17 step 5 (20261114040000): the job budget''s gross profit (sell less cost before commission), ex GST. The figure commission is worked from; never an assumed margin. NULL without a budget.';
