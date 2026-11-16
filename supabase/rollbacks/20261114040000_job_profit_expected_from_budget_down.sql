-- Undo 20261114040000_job_profit_expected_from_budget: v_job_profit back to 20261111100000's definition
-- (ef8c3682ff4da148ffe42635eb404abe) and the switch removed. The view is rebuilt from the view as it now
-- stands with that migration's fragments put back in reverse order (its replacements are exact, so the
-- result is the earlier text), and checked against the earlier md5. A view column cannot be removed in
-- place and job_profit(uuid) returns the view's row type, so (as the 20261111100000 rollback does) both are
-- dropped and made again, with their comments, column comments and grants read first and put back exactly
-- (the three columns this migration added go with their comments). Nothing else depends on the view (read
-- 13 Nov 2026). No row changes except the switch row.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL TimeZone = 'UTC';

DO $down$
DECLARE
  v_def text := pg_get_viewdef('public.v_job_profit'::regclass, true);
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
  v_comment text;
  v_cols jsonb;
  v_grants jsonb;
  v_fn regprocedure := to_regprocedure('public.job_profit(uuid)');
  v_fn_def text;
  v_fn_comment text;
  v_fn_grants jsonb;
  r record;
BEGIN
  IF md5(v_def) = 'ef8c3682ff4da148ffe42635eb404abe' THEN
    RAISE NOTICE 'v_job_profit is already the earlier definition';
    RETURN;
  END IF;
  IF strpos(v_def, 'budget_rev AS (') = 0 THEN
    RAISE EXCEPTION 'v_job_profit is not the 20261114040000 definition (md5 %); refusing', md5(v_def);
  END IF;
  FOR i IN REVERSE array_length(olds, 1) .. 1 LOOP
    IF (length(v_def) - length(replace(v_def, news[i], ''))) / length(news[i]) <> times[i] THEN
      RAISE EXCEPTION 'v_job_profit: fragment % that 20261114040000 wrote is not there % time(s); refusing', i, times[i];
    END IF;
    v_def := replace(v_def, news[i], olds[i]);
  END LOOP;
  IF md5(v_def) <> 'ef8c3682ff4da148ffe42635eb404abe' THEN
    RAISE EXCEPTION 'v_job_profit: putting the fragments back does not give the earlier definition (md5 %)', md5(v_def);
  END IF;
  v_comment := obj_description('public.v_job_profit'::regclass, 'pg_class');
  SELECT jsonb_object_agg(a.attname, col_description(a.attrelid, a.attnum))
    INTO v_cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.v_job_profit'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND col_description(a.attrelid, a.attnum) IS NOT NULL;
  SELECT jsonb_agg(jsonb_build_object('grantee', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(x.grantee::regrole::text) END,
                                      'privilege', x.privilege_type))
    INTO v_grants
    FROM pg_class c, aclexplode(c.relacl) x
   WHERE c.oid = 'public.v_job_profit'::regclass AND x.grantee <> c.relowner;
  IF v_fn IS NOT NULL THEN
    v_fn_def := pg_get_functiondef(v_fn);
    v_fn_comment := obj_description(v_fn, 'pg_proc');
    SELECT jsonb_agg(jsonb_build_object('grantee', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(x.grantee::regrole::text) END,
                                        'privilege', x.privilege_type))
      INTO v_fn_grants
      FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) x
     WHERE p.oid = v_fn AND x.grantee <> p.proowner;
    EXECUTE 'DROP FUNCTION public.job_profit(uuid)';
  END IF;

  DROP VIEW public.v_job_profit;
  EXECUTE 'CREATE VIEW public.v_job_profit AS ' || v_def;
  IF v_comment IS NOT NULL THEN
    EXECUTE format('COMMENT ON VIEW public.v_job_profit IS %L', v_comment);
  END IF;
  FOR r IN SELECT key, value FROM jsonb_each_text(COALESCE(v_cols, '{}'::jsonb)) LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.v_job_profit'::regclass AND a.attname = r.key
                AND a.attnum > 0 AND NOT a.attisdropped) THEN
      EXECUTE format('COMMENT ON COLUMN public.v_job_profit.%I IS %L', r.key, r.value);
    END IF;
  END LOOP;
  -- Exactly the grants it had: first take off whatever the new view picked up by default, then grant the old ones.
  EXECUTE 'REVOKE ALL ON public.v_job_profit FROM PUBLIC';
  FOR r IN SELECT DISTINCT quote_ident(x.grantee::regrole::text) AS grantee
             FROM pg_class c, aclexplode(c.relacl) x
            WHERE c.oid = 'public.v_job_profit'::regclass AND x.grantee <> c.relowner AND x.grantee <> 0 LOOP
    EXECUTE format('REVOKE ALL ON public.v_job_profit FROM %s', r.grantee);
  END LOOP;
  FOR r IN SELECT g.grantee, g.privilege FROM jsonb_to_recordset(COALESCE(v_grants, '[]'::jsonb)) AS g(grantee text, privilege text) LOOP
    EXECUTE format('GRANT %s ON public.v_job_profit TO %s', r.privilege, r.grantee);
  END LOOP;
  IF v_fn_def IS NOT NULL THEN
    EXECUTE v_fn_def;
    v_fn := to_regprocedure('public.job_profit(uuid)');
    IF v_fn_comment IS NOT NULL THEN
      EXECUTE format('COMMENT ON FUNCTION public.job_profit(uuid) IS %L', v_fn_comment);
    END IF;
    EXECUTE 'REVOKE ALL ON FUNCTION public.job_profit(uuid) FROM PUBLIC';
    FOR r IN SELECT DISTINCT quote_ident(x.grantee::regrole::text) AS grantee
               FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) x
              WHERE p.oid = v_fn AND x.grantee <> p.proowner AND x.grantee <> 0 LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION public.job_profit(uuid) FROM %s', r.grantee);
    END LOOP;
    FOR r IN SELECT g.grantee, g.privilege FROM jsonb_to_recordset(COALESCE(v_fn_grants, '[]'::jsonb)) AS g(grantee text, privilege text) LOOP
      EXECUTE format('GRANT %s ON FUNCTION public.job_profit(uuid) TO %s', r.privilege, r.grantee);
    END LOOP;
  END IF;

  IF md5(pg_get_viewdef('public.v_job_profit'::regclass, true)) <> 'ef8c3682ff4da148ffe42635eb404abe' THEN
    RAISE EXCEPTION 'v_job_profit after the rollback is not the earlier definition (md5 %)', md5(pg_get_viewdef('public.v_job_profit'::regclass, true));
  END IF;
END
$down$;

DELETE FROM public.feature_flags WHERE flag_name = 'job_profit_expected_from_job_budget';
