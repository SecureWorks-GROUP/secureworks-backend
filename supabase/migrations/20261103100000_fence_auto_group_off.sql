-- V8 fence groups (job-profit INBOX, 3 Nov 2026), built switched off.
--
-- The WO-6 auto-group (20261102120000) covers patio jobs. The pay rule for
-- fencing is the owner's G5 call, not decided on 3 Nov: "on jobs with 2+
-- crew, pay the work order's labour as one group pool split by hours x rate,
-- keep hours-only for solo". This migration changes no pay and no job:
--
-- 1. Flag group_work_order_auto_fence_v1, added off. When the owner turns it
--    on, the ops-api work-order sweep opens the missing job work order and a
--    group for open fencing jobs with 2+ crew, as it does for patio. The
--    patio flag and the patio sweep are untouched.
-- 2. group_work_order_labour_outside_pool(scope_items): the work order's
--    quote prices labour its pool does not hold (a line the quote fill
--    flagged outside_quote_labour, with a total). Live on 3 Nov: SWF-261459,
--    pool $0.35 (one fence panel) with $1,200 of quoted labour outside it,
--    and SWF-261527 ($160). The fence sweep makes no group on such a job.
-- 3. v_group_coverage: the weekly measure for patio and fencing together,
--    one row per job per Perth week with 2+ install crew, with job_type and
--    the reason a job is not covered. Patio rows read exactly as
--    v_patio_group_coverage (unchanged, still there). Fencing rows add two
--    reasons: labour_outside_pool, and work_order_claimed_already for a fence
--    lead's fixed-price "Work order $X. Less labour: ..." line, which is
--    normal pay and blocks a group like hours do.

INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES ('group_work_order_auto_fence_v1', false,
        'V8: the work-order sweep opens the missing job work order and a group work order for fencing jobs with 2+ crew. Off until the owner decides the fence pay rule (G5) (20261103100000).')
ON CONFLICT (flag_name) DO NOTHING;

CREATE OR REPLACE FUNCTION public.group_work_order_labour_outside_pool(
  p_scope_items jsonb
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(p_scope_items) = 'array' THEN p_scope_items ELSE '[]'::jsonb END
    ) AS si(item)
    WHERE jsonb_typeof(si.item) = 'object'
      AND jsonb_typeof(si.item -> 'flags') = 'array'
      AND (si.item -> 'flags') ? 'outside_quote_labour'
      AND jsonb_typeof(si.item -> 'total') = 'number'
      AND (si.item ->> 'total')::numeric > 0
  );
$$;

COMMENT ON FUNCTION public.group_work_order_labour_outside_pool(jsonb) IS
  'V8 (20261103100000): true when a job work order''s scope has a priced line the quote fill flagged outside_quote_labour, so its agreed labour (the group pool) leaves quoted labour out. The fence auto-group makes no group on such a work order. Mirror of labourOutsidePool in ops-api patio_auto_group.ts.';

-- The weekly measure for both auto-grouped job types. Crew, work order, group
-- and normal pay are read as in v_patio_group_coverage. job_open: the job is
-- in an open work-order status, the only jobs the sweep groups.
-- auto_switch_on: that job type's auto-group flag is on now.
CREATE OR REPLACE VIEW public.v_group_coverage
WITH (security_invoker = true) AS
WITH crew AS (
  SELECT ja.job_id,
         date_trunc('week', ja.scheduled_date::timestamp)::date AS week_start,
         count(DISTINCT ja.user_id) AS crew_count
  FROM public.job_assignments ja
  JOIN public.users u ON u.id = ja.user_id
  WHERE COALESCE(ja.is_ghost, false) = false
    AND lower(COALESCE(ja.role, '')) <> 'observer'
    AND lower(COALESCE(ja.status, '')) <> 'cancelled'
    AND lower(COALESCE(u.role, '')) <> 'admin'
    AND ja.scheduled_date IS NOT NULL
  GROUP BY ja.job_id, date_trunc('week', ja.scheduled_date::timestamp)::date
), facts AS (
  SELECT j.type AS job_type, j.id AS job_id, j.job_number, j.status AS job_status,
         (j.status = ANY (public.job_work_order_open_statuses())) AS job_open,
         c.week_start, c.crew_count,
         w.id AS work_order_id, w.status AS work_order_status, w.agreed_labour_ex,
         (w.status = 'approved' AND w.sealed_content_hash IS NOT NULL
           AND COALESCE(w.agreed_labour_ex, 0) > 0) AS priced_work_order,
         COALESCE(public.group_work_order_labour_outside_pool(w.scope_items), false) AS labour_outside_pool,
         g.id AS group_id,
         EXISTS (
           SELECT 1 FROM public.trade_invoice_lines l
           JOIN public.trade_invoices i ON i.id = l.trade_invoice_id
           WHERE l.job_id = j.id
             AND i.status IS DISTINCT FROM 'ops-reject'
             AND public.group_work_order_line_is_normal_pay(l.line_type, l.source_work_order_id)
             AND NOT public.group_work_order_line_is_office_fee(l.line_type, l.description)
         ) AS normal_pay_on_job,
         EXISTS (
           SELECT 1 FROM public.trade_invoice_lines l
           JOIN public.trade_invoices i ON i.id = l.trade_invoice_id
           WHERE l.job_id = j.id
             AND i.status IS DISTINCT FROM 'ops-reject'
             AND replace(replace(lower(btrim(COALESCE(l.line_type, ''))), '_', ' '), ' ', '') = 'workorder'
         ) AS work_order_claim_on_job,
         COALESCE((
           SELECT f.enabled FROM public.feature_flags f
           WHERE f.flag_name = CASE j.type
             WHEN 'patio' THEN 'group_work_order_auto_patio_v1'
             WHEN 'fencing' THEN 'group_work_order_auto_fence_v1'
           END
           LIMIT 1
         ), false) AS auto_switch_on
  FROM crew c
  JOIN public.jobs j ON j.id = c.job_id
  LEFT JOIN LATERAL (
    SELECT w.* FROM public.work_orders w
    WHERE w.job_id = j.id AND w.kind = 'job' AND w.status <> 'void'
    ORDER BY (w.status = 'approved') DESC, w.created_at DESC LIMIT 1
  ) w ON true
  LEFT JOIN LATERAL (
    SELECT g.id FROM public.group_work_orders g
    WHERE g.job_id = j.id AND g.status <> 'void' LIMIT 1
  ) g ON true
  WHERE j.type IN ('patio', 'fencing') AND c.crew_count >= 2
    AND COALESCE(j.status, '') NOT IN ('cancelled', 'lost')
)
SELECT f.*,
       (f.priced_work_order AND f.group_id IS NOT NULL) AS covered,
       CASE
         WHEN f.priced_work_order AND f.group_id IS NOT NULL THEN 'covered'
         WHEN f.work_order_id IS NULL THEN 'no_work_order'
         WHEN f.work_order_status <> 'approved' THEN 'work_order_not_approved'
         WHEN NOT f.priced_work_order THEN 'work_order_has_no_labour'
         -- Fencing only: the fence sweep refuses these; the patio sweep and
         -- v_patio_group_coverage do not, so patio rows stay as they were.
         WHEN f.job_type = 'fencing' AND f.labour_outside_pool THEN 'labour_outside_pool'
         WHEN f.job_type = 'fencing' AND f.normal_pay_on_job AND f.work_order_claim_on_job
           THEN 'work_order_claimed_already'
         WHEN f.normal_pay_on_job THEN 'crew_paid_by_hours_already'
         ELSE 'no_group_yet'
       END AS reason
FROM facts f;

COMMENT ON VIEW public.v_group_coverage IS
  'V8 weekly measure (20261103100000): patio and fencing jobs with 2+ install crew allocated in a Perth week; covered when the job has a priced, approved, sealed work order and a live group work order; reason names the first gap. Patio rows match v_patio_group_coverage. Fencing adds labour_outside_pool and work_order_claimed_already. auto_switch_on shows whether that type''s auto-group flag is on. Read only.';

REVOKE ALL ON public.v_group_coverage FROM anon, authenticated;
GRANT SELECT ON public.v_group_coverage TO service_role;
