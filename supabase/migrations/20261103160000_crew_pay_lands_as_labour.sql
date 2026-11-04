-- (Context finish line row B2, 3 Nov 2026) Every crew invoice or group share lands as labour on its job
-- the same day, in Job Profit.
--
-- 1. A crew line on a DRAFT invoice no longer counts as actual cost. It stays in v_job_cost_events (so the
--    job still shows the hours being logged), with is_actual false until the crew submit it. Found 3 Nov:
--    9 draft lines ($1,735.00 on 9 jobs, created 1 Nov) counted as actual labour, and their company-super
--    rows with them (trade_employer_super inherits is_actual from the crew line). B2 is about invoices,
--    not drafts. Guard: the view must be the 20261103050000 definition (md5 a3ab8d8b...).
-- 2. job_profit_crew_pay_landing(p_since): the B2 measure. For each crew pay line (not commission or a
--    commission advance) on a submitted crew invoice since p_since: is it on its job in Job Profit, in the
--    labour lane, counting as actual? A group share on all_in_12_v2 must also carry its company-super row.
--    Read only. v_job_cost_events is a plain view, so a line lands the moment it is saved.
-- Rollback: supabase/rollbacks/20261103160000_crew_pay_lands_as_labour_down.sql

DO $mig$
DECLARE
  v_def text := pg_get_viewdef('public.v_job_cost_events'::regclass, true);
  v_old text := 'r.cost_lane <> ''advance''::text AS is_actual';
  v_new text := 'r.cost_lane <> ''advance''::text AND ti.status <> ''draft''::text AS is_actual';
BEGIN
  IF md5(v_def) = '926479b3b905dea4b087834c37438572' THEN
    RAISE NOTICE 'v_job_cost_events already leaves crew drafts out of actual cost';
  ELSE
    IF md5(v_def) <> 'a3ab8d8be6e4ff755736cbe53a7d131f' THEN
      RAISE EXCEPTION 'v_job_cost_events is not the definition this migration was written against (md5 %)', md5(v_def);
    END IF;
    IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION 'v_job_cost_events: the crew is_actual rule is not there exactly once';
    END IF;
    EXECUTE 'CREATE OR REPLACE VIEW public.v_job_cost_events AS ' || replace(v_def, v_old, v_new);
    IF md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true)) <> '926479b3b905dea4b087834c37438572' THEN
      RAISE EXCEPTION 'v_job_cost_events after the change is not the rehearsed definition (md5 %)', md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true));
    END IF;
  END IF;
END
$mig$;

CREATE OR REPLACE FUNCTION public.job_profit_crew_pay_landing(p_since timestamptz DEFAULT now() - interval '7 days')
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  WITH ev AS MATERIALIZED (
    -- The view is read once: a lookup per line times out.
    SELECT source, source_id, job_id, lane, is_actual
    FROM v_job_cost_events WHERE source IN ('trade_line', 'trade_employer_super')
  ),
  pay AS (
    SELECT li.id AS line_id, li.job_id, li.line_type, li.group_share_id, li.line_total_ex,
           ti.id AS invoice_id, ti.invoice_number, ti.status, ti.created_at,
           r.cost_lane, j.job_number,
           g.pay_basis
    FROM trade_invoice_lines li
    JOIN trade_invoices ti ON ti.id = li.trade_invoice_id
    LEFT JOIN v_trade_charge_resolved r ON r.line_id = li.id
    LEFT JOIN jobs j ON j.id = li.job_id
    LEFT JOIN group_work_order_shares s ON s.id = li.group_share_id
    LEFT JOIN group_work_orders g ON g.id = s.group_id
    WHERE ti.created_at >= p_since
      AND ti.status NOT IN ('draft', 'ops-reject')
      AND upper(COALESCE(ti.xero_bill_status, '')) NOT IN ('DELETED', 'VOIDED')
      AND COALESCE(r.cost_lane, 'labour') NOT IN ('commission', 'advance')
      AND NOT COALESCE(r.is_probable_test_line, false)
  ),
  judged AS (
    SELECT p.*,
      CASE
        WHEN p.job_id IS NULL THEN 'no_job'
        WHEN NOT EXISTS (SELECT 1 FROM ev e WHERE e.source = 'trade_line' AND e.source_id = p.line_id::text) THEN 'not_in_job_profit'
        WHEN NOT EXISTS (SELECT 1 FROM ev e WHERE e.source = 'trade_line' AND e.source_id = p.line_id::text AND e.job_id = p.job_id) THEN 'wrong_job'
        WHEN NOT EXISTS (SELECT 1 FROM ev e WHERE e.source = 'trade_line' AND e.source_id = p.line_id::text AND e.job_id = p.job_id AND e.lane = 'labour') THEN 'not_labour'
        WHEN NOT EXISTS (SELECT 1 FROM ev e WHERE e.source = 'trade_line' AND e.source_id = p.line_id::text AND e.job_id = p.job_id AND e.lane = 'labour' AND e.is_actual) THEN 'not_actual'
        WHEN p.pay_basis = 'all_in_12_v2' AND NOT EXISTS (SELECT 1 FROM ev e WHERE e.source = 'trade_employer_super' AND e.source_id = p.line_id::text || ':employer_super' AND e.job_id = p.job_id) THEN 'share_without_company_super'
        ELSE NULL
      END AS problem
    FROM pay p
  )
  SELECT jsonb_build_object(
    'since', p_since,
    'read_at', now(),
    'pay_lines', count(*),
    'landed', count(*) FILTER (WHERE problem IS NULL),
    'group_share_lines', count(*) FILTER (WHERE group_share_id IS NOT NULL),
    'green', count(*) FILTER (WHERE problem IS NOT NULL) = 0,
    'missing', COALESCE(jsonb_agg(jsonb_build_object(
        'invoice_number', invoice_number, 'line_id', line_id, 'job_number', job_number,
        'line_type', line_type, 'amount_ex', line_total_ex, 'problem', problem)
      ORDER BY created_at) FILTER (WHERE problem IS NOT NULL), '[]'::jsonb)
  )
  FROM judged;
$fn$;

COMMENT ON FUNCTION public.job_profit_crew_pay_landing(timestamptz) IS
  'Context finish line B2: every crew pay line (and group share) on a submitted crew invoice since p_since is on its job in Job Profit as actual labour; group shares on all_in_12_v2 also carry company super. Read only.';

REVOKE ALL ON FUNCTION public.job_profit_crew_pay_landing(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.job_profit_crew_pay_landing(timestamptz) TO service_role;
