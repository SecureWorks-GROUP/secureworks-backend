-- WO-6 (job-profit INBOX, 2 Nov 2026): every patio job with 2+ crew gets a
-- priced, approved work order and a group work order, measured weekly.
--
-- 1. Office milestone fees. Nithin bills "Council Approval" and "Materials
--    Ordered" as flat labour lines on the patio jobs he sold (25 lines,
--    $2,550 live on 2 Nov, nobody else). They are not install labour and are
--    not paid from the work order's labour ("Labour - 2 trades x N days"),
--    but the group double-pay fence counted them as normal pay. So they
--    blocked a group on SWP-26595, SWP-26701 and SWP-261222, and on a grouped
--    job the fence would refuse his next fee. They no longer count, in either
--    direction. Install hours and work-order claims still block as before.
--    Job Profit is unchanged: the fees stay in the labour lane.
-- 2. Flag group_work_order_auto_patio_v1, added off: the ops-api sweep opens
--    the missing work order and the group for patio jobs with 2+ crew.
-- 3. v_patio_group_coverage: the weekly measure, with the reason a job is
--    not covered.

CREATE OR REPLACE FUNCTION public.group_work_order_line_is_office_fee(
  p_line_type text,
  p_description text
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT replace(replace(lower(btrim(COALESCE(p_line_type, ''))), '_', ' '), ' ', '') = 'labour'
    AND COALESCE(p_description, '') ~* '^\s*(council\s+approval|materials\s+ordered)\M';
$$;

COMMENT ON FUNCTION public.group_work_order_line_is_office_fee(text, text) IS
  'WO-6 (20261102120000): a flat office milestone fee (Council Approval, Materials Ordered) billed as a labour line. Not install labour, so it never blocks a group work order and a group never blocks it.';

CREATE OR REPLACE FUNCTION public.group_work_orders_refuse_existing_pay()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.group_work_order_lock_job(NEW.job_id);
  IF EXISTS (
    SELECT 1
    FROM public.trade_invoice_lines l
    JOIN public.trade_invoices i ON i.id = l.trade_invoice_id
    WHERE l.job_id = NEW.job_id
      AND i.status IS DISTINCT FROM 'ops-reject'
      AND public.group_work_order_line_is_normal_pay(l.line_type, l.source_work_order_id)
      AND NOT public.group_work_order_line_is_office_fee(l.line_type, l.description)
  ) THEN
    RAISE EXCEPTION 'group_open_blocked_by_work_order_claim' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trade_invoice_lines_group_share_snapshot()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_type text;
  v_group uuid;
  v_job uuid;
  v_basis text;
  v_invoice_user uuid;
  v_invoice_status text;
  v_invoice_basis text;
  v_share_id uuid;
  v_share_user uuid;
  v_share_ex numeric;
  v_frozen timestamptz;
  v_groups int;
BEGIN
  v_type := lower(btrim(COALESCE(NEW.line_type, '')));

  IF v_type = 'group share' OR NEW.group_share_id IS NOT NULL THEN
    IF NEW.job_id IS NULL OR NEW.trade_invoice_id IS NULL THEN
      RAISE EXCEPTION 'group_work_order_not_found' USING ERRCODE = 'P0002';
    END IF;
    PERFORM public.group_work_order_lock_job(NEW.job_id);
    SELECT count(*) INTO v_groups
    FROM public.group_work_orders g
    WHERE g.job_id = NEW.job_id AND g.status <> 'void';
    IF v_groups = 0 THEN
      RAISE EXCEPTION 'group_work_order_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF v_groups > 1 THEN
      RAISE EXCEPTION 'group_work_order_ambiguous' USING ERRCODE = '23514';
    END IF;
    SELECT g.id, g.job_id, g.split_frozen_at, g.pay_basis
      INTO v_group, v_job, v_frozen, v_basis
    FROM public.group_work_orders g
    WHERE g.job_id = NEW.job_id AND g.status <> 'void'
    FOR UPDATE;
    IF EXISTS (
      SELECT 1
      FROM public.trade_invoice_lines l
      JOIN public.trade_invoices i ON i.id = l.trade_invoice_id
      WHERE l.job_id = NEW.job_id
        AND l.id IS DISTINCT FROM NEW.id
        AND i.status IS DISTINCT FROM 'ops-reject'
        AND public.group_work_order_line_is_normal_pay(l.line_type, l.source_work_order_id)
        AND NOT public.group_work_order_line_is_office_fee(l.line_type, l.description)
    ) THEN
      RAISE EXCEPTION 'group_share_blocked_by_work_order_claim' USING ERRCODE = '23514';
    END IF;
    SELECT i.user_id, i.status, i.super_basis INTO v_invoice_user, v_invoice_status, v_invoice_basis
    FROM public.trade_invoices i
    WHERE i.id = NEW.trade_invoice_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'group_share_owner_mismatch' USING ERRCODE = '23514';
    END IF;
    IF NOT public.group_client_signoff_counts(v_job) THEN
      RAISE EXCEPTION 'group_client_signoff_required' USING ERRCODE = '23514';
    END IF;
    -- A draft does not freeze and does not hold the share. A non-draft
    -- line freezes in this statement when the marker is still null.
    IF v_invoice_status = 'draft' AND v_frozen IS NULL THEN
      NEW.group_share_id := NULL;
      NEW.line_type := 'group share';
      NEW.source_work_order_id := NULL;
      RETURN NEW;
    END IF;
    -- Full employer super is priced on its own invoice; every other basis
    -- stays on the ordinary split.
    IF (v_basis = 'all_in_12_v2') IS DISTINCT FROM (v_invoice_basis IS NOT DISTINCT FROM 'employer_12_v2') THEN
      RAISE EXCEPTION 'group_super_basis_mismatch' USING ERRCODE = '23514';
    END IF;
    IF v_invoice_status IS DISTINCT FROM 'draft' AND v_frozen IS NULL THEN
      PERFORM public.group_work_order_write_split(v_group, true);
    END IF;
    SELECT s.id, s.user_id, s.share_ex
      INTO v_share_id, v_share_user, v_share_ex
    FROM public.group_work_order_shares s
    WHERE s.group_id = v_group AND s.user_id = v_invoice_user;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'group_share_not_in_split' USING ERRCODE = '23514';
    END IF;
    IF NEW.group_share_id IS NOT NULL AND NEW.group_share_id IS DISTINCT FROM v_share_id THEN
      RAISE EXCEPTION 'group_share_owner_mismatch' USING ERRCODE = '23514';
    END IF;
    IF v_invoice_user IS DISTINCT FROM v_share_user THEN
      RAISE EXCEPTION 'group_share_owner_mismatch' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM public.trade_invoice_lines l
      JOIN public.trade_invoices i ON i.id = l.trade_invoice_id
      WHERE l.group_share_id = v_share_id
        AND l.id IS DISTINCT FROM NEW.id
        AND i.status IS DISTINCT FROM 'ops-reject'
        AND i.status IS DISTINCT FROM 'draft'
    ) THEN
      RAISE EXCEPTION 'group_share_already_invoiced' USING ERRCODE = '23514';
    END IF;
    IF NEW.line_total_ex IS DISTINCT FROM (public.group_work_order_share_pay(v_group,v_share_ex)->>'invoice_ex')::numeric THEN
      RAISE EXCEPTION 'group_share_amount_mismatch' USING ERRCODE = '23514';
    END IF;
    NEW.group_share_id := v_share_id;
    NEW.line_type := 'group share';
    NEW.source_work_order_id := NULL;
    RETURN NEW;
  END IF;

  -- An employer-super invoice carries its group share and nothing else.
  IF NEW.trade_invoice_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.trade_invoices i WHERE i.id = NEW.trade_invoice_id AND i.super_basis IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'group_super_basis_mismatch' USING ERRCODE = '23514';
  END IF;

  IF NEW.job_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF public.group_work_order_line_is_normal_pay(NEW.line_type, NEW.source_work_order_id)
     AND NOT public.group_work_order_line_is_office_fee(NEW.line_type, NEW.description) THEN
    PERFORM public.group_work_order_lock_job(NEW.job_id);
    IF EXISTS (
      SELECT 1 FROM public.group_work_orders g
      WHERE g.job_id = NEW.job_id AND g.status <> 'void'
    ) THEN
      RAISE EXCEPTION 'work_order_claim_blocked_by_group_share' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES ('group_work_order_auto_patio_v1', false,
        'WO-6: the work-order sweep opens the missing job work order and a group work order for patio jobs with 2+ crew (20261102120000).')
ON CONFLICT (flag_name) DO NOTHING;

-- The weekly measure. One row per patio job per Perth week (Monday) in which
-- 2+ install crew are allocated: live allocations only (no ghost, observer or
-- cancelled row), office admins not counted. covered = a priced, approved,
-- sealed job work order and a live group. reason names the first gap.
CREATE OR REPLACE VIEW public.v_patio_group_coverage
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
  SELECT j.id AS job_id, j.job_number, j.status AS job_status, c.week_start, c.crew_count,
         w.id AS work_order_id, w.status AS work_order_status, w.agreed_labour_ex,
         (w.status = 'approved' AND w.sealed_content_hash IS NOT NULL
           AND COALESCE(w.agreed_labour_ex, 0) > 0) AS priced_work_order,
         g.id AS group_id,
         EXISTS (
           SELECT 1 FROM public.trade_invoice_lines l
           JOIN public.trade_invoices i ON i.id = l.trade_invoice_id
           WHERE l.job_id = j.id
             AND i.status IS DISTINCT FROM 'ops-reject'
             AND public.group_work_order_line_is_normal_pay(l.line_type, l.source_work_order_id)
             AND NOT public.group_work_order_line_is_office_fee(l.line_type, l.description)
         ) AS normal_pay_on_job
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
  WHERE j.type = 'patio' AND c.crew_count >= 2
    AND COALESCE(j.status, '') NOT IN ('cancelled', 'lost')
)
SELECT f.*,
       (f.priced_work_order AND f.group_id IS NOT NULL) AS covered,
       CASE
         WHEN f.priced_work_order AND f.group_id IS NOT NULL THEN 'covered'
         WHEN f.work_order_id IS NULL THEN 'no_work_order'
         WHEN f.work_order_status <> 'approved' THEN 'work_order_not_approved'
         WHEN NOT f.priced_work_order THEN 'work_order_has_no_labour'
         WHEN f.normal_pay_on_job THEN 'crew_paid_by_hours_already'
         ELSE 'no_group_yet'
       END AS reason
FROM facts f;

COMMENT ON VIEW public.v_patio_group_coverage IS
  'WO-6 weekly measure (20261102120000): patio jobs with 2+ install crew allocated in a Perth week; covered when the job has a priced, approved, sealed work order and a live group work order; reason names the first gap. Read only.';

REVOKE ALL ON public.v_patio_group_coverage FROM anon, authenticated;
GRANT SELECT ON public.v_patio_group_coverage TO service_role;
