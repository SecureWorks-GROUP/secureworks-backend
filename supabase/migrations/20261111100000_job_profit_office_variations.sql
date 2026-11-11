-- (RQ-15.g, 11 Nov 2026) Job Profit counts an approved office variation.
--
-- A customer variation the office records on a job work order (work_order_customer_variations, approved by a
-- work_order_settings approver) changed nothing in Job Profit: v_job_revenue_events listed only job_variations,
-- so the job's agreed price, the variation-not-invoiced check and the expected labour all left it out.
-- Change, read only views, no table and no row:
--   1. v_job_revenue_events lists each approved office variation once, as an agreed variation (kind variation,
--      amount its customer_price_ex, ex GST, dated its approval day, source_id office_variation:<id>,
--      counts_as_invoiced false). A draft or cancelled one is not listed. Invoiced, collected and every cost
--      are unchanged: the variation's invoice line counts when Xero holds it, as every invoice does.
--   2. v_job_profit counts it in variations_listed_ex and variations_agreed, so the margin is held
--      (variation_not_invoiced) until the job's invoices cover the quote plus the variation. It is never
--      "not costed": its trade allocation is its cost figure.
--   3. v_job_profit appends five columns. The quote's own figures (quoted_ex, expected_labour_ex,
--      expected_cost_ex, ...) stay the quote's, because the story money book prints expected_cost_ex as
--      "Expected cost at the quote":
--        office_variations_ex                the approved office variations' customer price, ex GST (0 when none)
--        office_variation_labour_ex          their trade allocation, ex GST (0 when none)
--        expected_labour_with_variations_ex  expected_labour_ex plus that allocation (NULL when the quote's is)
--        expected_cost_with_variations_ex    expected_cost_ex's lanes plus that allocation (NULL when no
--                                            quote cost is fixed, as expected_cost_ex)
--      Profit is still invoiced less actual cost; these are expected figures only.
--
-- Guard: each view must be the definition this was written against (pg_get_viewdef(..., true), UTC):
--   v_job_revenue_events 2191799f0f51ef34b5fe90879e8387cb -> cea985aadcb59a2f751b1f403176a39c (production),
--                        18c6f924719d2c53ca537e8d58d7555f -> b8354d49625e92fdb4a52d81df3a761a (contract stack);
--   v_job_profit         1ac286e983426f43c67f94fd84268e07 -> ef8c3682ff4da148ffe42635eb404abe (both).
-- The production after-values were worked out read only from production's own definitions; the production
-- rehearsal is the Job Profit lane's. Re-running it is a no-op.
-- Rollback: supabase/rollbacks/20261111100000_job_profit_office_variations_down.sql.

SET LOCAL lock_timeout = '5s';
SET LOCAL TimeZone = 'UTC';

DO $mig$
DECLARE
  v_def text;
  v_after text;
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
  IF to_regclass('public.work_order_customer_variations') IS NULL THEN
    RAISE EXCEPTION 'work_order_customer_variations is missing: apply 20261013140000 first';
  END IF;
  v_def := pg_get_viewdef('public.v_job_revenue_events'::regclass, true);
  IF md5(v_def) IN ('cea985aadcb59a2f751b1f403176a39c', 'b8354d49625e92fdb4a52d81df3a761a') THEN
    RAISE NOTICE 'v_job_revenue_events already lists approved office variations';
    RETURN;
  END IF;
  v_after := CASE md5(v_def) WHEN '2191799f0f51ef34b5fe90879e8387cb' THEN 'cea985aadcb59a2f751b1f403176a39c'
                             WHEN '18c6f924719d2c53ca537e8d58d7555f' THEN 'b8354d49625e92fdb4a52d81df3a761a' END;
  IF v_after IS NULL THEN
    RAISE EXCEPTION 'v_job_revenue_events is not the definition this migration was written against (md5 %)', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, o1, ''))) / length(o1) <> 1 THEN
    RAISE EXCEPTION 'v_job_revenue_events: the replaced fragment is not there exactly once';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_revenue_events AS ' || replace(v_def, o1, n1);
  IF md5(pg_get_viewdef('public.v_job_revenue_events'::regclass, true)) <> v_after THEN
    RAISE EXCEPTION 'v_job_revenue_events after the change is not the rehearsed definition (md5 %)',
      md5(pg_get_viewdef('public.v_job_revenue_events'::regclass, true));
  END IF;
END
$mig$;

DO $mig$
DECLARE
  v_def text;
  v_before constant text := '1ac286e983426f43c67f94fd84268e07';
  v_after constant text := 'ef8c3682ff4da148ffe42635eb404abe';
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
BEGIN
  v_def := pg_get_viewdef('public.v_job_profit'::regclass, true);
  IF md5(v_def) = v_after THEN
    RAISE NOTICE 'v_job_profit already counts approved office variations';
    RETURN;
  END IF;
  IF md5(v_def) <> v_before THEN
    RAISE EXCEPTION 'v_job_profit is not the definition this migration was written against (md5 %)', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, o1, ''))) / length(o1) <> 1
     OR (length(v_def) - length(replace(v_def, o2, ''))) / length(o2) <> 1 THEN
    RAISE EXCEPTION 'v_job_profit: a replaced fragment is not there exactly once';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_profit AS ' || replace(replace(v_def, o1, n1), o2, n2);
  IF md5(pg_get_viewdef('public.v_job_profit'::regclass, true)) <> v_after THEN
    RAISE EXCEPTION 'v_job_profit after the change is not the rehearsed definition (md5 %)',
      md5(pg_get_viewdef('public.v_job_profit'::regclass, true));
  END IF;
END
$mig$;
