-- Undo 20261111100000_job_profit_office_variations: v_job_profit and v_job_revenue_events back to the definitions
-- before it. Each is rebuilt from the view as it now stands with that migration's fragments put back (the
-- migration's replacements are exact, so the result is the earlier text), and checked against the earlier md5:
--   v_job_profit         ef8c3682ff4da148ffe42635eb404abe -> 1ac286e983426f43c67f94fd84268e07
--   v_job_revenue_events cea985aadcb59a2f751b1f403176a39c -> 2191799f0f51ef34b5fe90879e8387cb (production),
--                        b8354d49625e92fdb4a52d81df3a761a -> 18c6f924719d2c53ca537e8d58d7555f (contract stack).
-- A view column cannot be removed in place and job_profit(uuid) returns the view's row type, so (as the
-- 20261104080000 rollback does) both are dropped and made again, with their comments, column comments and grants
-- read first and put back exactly. Nothing else depends on either view (read 11 Nov 2026). No row changes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL TimeZone = 'UTC';

DO $down$
DECLARE
  v_def text := pg_get_viewdef('public.v_job_profit'::regclass, true);
  o1 constant text := $o1$            count(*) FILTER (WHERE v.cost_estimate IS NULL) AS variations_not_costed
           FROM v_job_revenue_events e
             JOIN job_variations v ON v.id::text = e.source_id$o1$;
  n1 constant text := $n1$            count(*) FILTER (WHERE v.id IS NOT NULL AND v.cost_estimate IS NULL) AS variations_not_costed
           FROM v_job_revenue_events e
             LEFT JOIN job_variations v ON v.id::text = e.source_id$n1$;
  o2 constant text := $o2$        END AS expected_cost_missing
   FROM flagged f;$o2$;
  n2 constant text := $n2$        END AS expected_cost_missing,
    COALESCE(( SELECT sum(cv.customer_price_ex) AS sum
           FROM work_order_customer_variations cv
          WHERE cv.job_id = f.job_id AND cv.status = 'approved'::text), 0::numeric) AS office_variations_ex,
    COALESCE(( SELECT sum(cv.trade_allocation_ex) AS sum
           FROM work_order_customer_variations cv
          WHERE cv.job_id = f.job_id AND cv.status = 'approved'::text), 0::numeric) AS office_variation_labour_ex,
    expected_labour_ex + COALESCE(( SELECT sum(cv.trade_allocation_ex) AS sum
           FROM work_order_customer_variations cv
          WHERE cv.job_id = f.job_id AND cv.status = 'approved'::text), 0::numeric) AS expected_labour_with_variations_ex,
        CASE
            WHEN expected_source IS NOT NULL THEN COALESCE(expected_labour_ex, 0::numeric) + COALESCE(expected_materials_ex, 0::numeric) + COALESCE(expected_commission_ex, 0::numeric) + COALESCE(( SELECT sum(cv.trade_allocation_ex) AS sum
               FROM work_order_customer_variations cv
              WHERE cv.job_id = f.job_id AND cv.status = 'approved'::text), 0::numeric)
            ELSE NULL::numeric
        END AS expected_cost_with_variations_ex
   FROM flagged f;$n2$;
  v_comment text;
  v_cols jsonb;
  v_grants jsonb;
  v_fn regprocedure := to_regprocedure('public.job_profit(uuid)');
  v_fn_def text;
  v_fn_comment text;
  v_fn_grants jsonb;
  r record;
BEGIN
  IF md5(v_def) = '1ac286e983426f43c67f94fd84268e07' THEN
    RAISE NOTICE 'v_job_profit is already the earlier definition';
    RETURN;
  END IF;
  IF md5(v_def) <> 'ef8c3682ff4da148ffe42635eb404abe' THEN
    RAISE EXCEPTION 'v_job_profit is not the 20261111100000 definition (md5 %)', md5(v_def);
  END IF;
  v_def := replace(replace(v_def, n2, o2), n1, o1);
  IF md5(v_def) <> '1ac286e983426f43c67f94fd84268e07' THEN
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

  IF md5(pg_get_viewdef('public.v_job_profit'::regclass, true)) <> '1ac286e983426f43c67f94fd84268e07' THEN
    RAISE EXCEPTION 'v_job_profit after the rollback is not the earlier definition (md5 %)', md5(pg_get_viewdef('public.v_job_profit'::regclass, true));
  END IF;
END
$down$;

DO $down$
DECLARE
  v_def text := pg_get_viewdef('public.v_job_revenue_events'::regclass, true);
  v_before text;
  o1 constant text := $o1$   FROM job_variations v
  WHERE v.job_id IS NOT NULL;$o1$;
  n1 constant text := $n1$   FROM job_variations v
  WHERE v.job_id IS NOT NULL
UNION ALL
 SELECT cv.job_id,
    'variation'::text AS kind,
    cv.approved_at::date AS invoice_date,
    cv.customer_price_ex AS amount_ex,
    cv.status,
    false AS paid,
    NULL::date AS paid_on,
    false AS counts_as_invoiced,
    'office_variation:'::text || cv.id AS source_id,
    cv.id::text AS document_id,
    'Work order variation '::text || cv.variation_number AS document_number,
    NULL::text AS party,
    cv.description,
    NULL::text AS account_code,
    NULL::text AS business_unit,
    true AS agreed
   FROM work_order_customer_variations cv
  WHERE cv.status = 'approved'::text;$n1$;
BEGIN
  IF md5(v_def) IN ('2191799f0f51ef34b5fe90879e8387cb', '18c6f924719d2c53ca537e8d58d7555f') THEN
    RAISE NOTICE 'v_job_revenue_events is already the earlier definition';
    RETURN;
  END IF;
  v_before := CASE md5(v_def) WHEN 'cea985aadcb59a2f751b1f403176a39c' THEN '2191799f0f51ef34b5fe90879e8387cb'
                              WHEN 'b8354d49625e92fdb4a52d81df3a761a' THEN '18c6f924719d2c53ca537e8d58d7555f' END;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'v_job_revenue_events is not the 20261111100000 definition (md5 %)', md5(v_def);
  END IF;
  -- Same columns either way, so the view is replaced in place and keeps its comments and grants.
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_revenue_events AS ' || replace(v_def, n1, o1);
  IF md5(pg_get_viewdef('public.v_job_revenue_events'::regclass, true)) <> v_before THEN
    RAISE EXCEPTION 'v_job_revenue_events after the rollback is not the earlier definition (md5 %)',
      md5(pg_get_viewdef('public.v_job_revenue_events'::regclass, true));
  END IF;
END
$down$;
