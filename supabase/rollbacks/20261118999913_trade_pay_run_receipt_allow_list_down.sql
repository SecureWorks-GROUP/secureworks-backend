-- Rollback of SEC-465 (receipt allow-list): gives back 20261118194500's
-- trade_pay_run_check_v2 body (md5 c6c1f4da1fb43e2fb781b884502a7b5d), byte for
-- byte, only over this migration's own body.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $check_guard$
/* block */ BEGIN
  IF to_regprocedure('public.trade_pay_run_check_v2(date,integer,uuid,text)') IS NOT NULL
     AND (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.trade_pay_run_check_v2(date,integer,uuid,text)'))
     NOT IN ('fa27e07999e8d14a6cf0145f828818e9', 'c6c1f4da1fb43e2fb781b884502a7b5d') THEN
    RAISE EXCEPTION 'trade_pay_run_check_v2 rollback: Rule 15, another body is installed; refusing to replace it';
  END IF;
END $check_guard$;

CREATE OR REPLACE FUNCTION public.trade_pay_run_check_v2(
  p_as_of date, p_weeks integer, p_org_id uuid, p_stage text DEFAULT 'after_xero'
) RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_query text;
  v_result jsonb;
  v_has_kind boolean;
  v_has_run boolean; BEGIN
  IF p_stage IS NULL OR p_stage NOT IN ('before_xero', 'after_xero') THEN
    RAISE EXCEPTION 'pay_check_stage_invalid' USING ERRCODE = '22023';
  END IF;
  SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.trade_invoices'::regclass
    AND attname = 'invoice_kind' AND NOT attisdropped) INTO v_has_kind;
  SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.trade_invoices'::regclass
    AND attname = 'pay_run_id' AND NOT attisdropped) INTO v_has_run;
  -- Resolve optional schema before planning. No caller data is SQL text.
  v_query := $query$
  WITH params AS (
    SELECT COALESCE($1, (now() AT TIME ZONE 'Australia/Perth')::date) AS as_of,
           LEAST(GREATEST(COALESCE($2, 2), 1), 26) AS weeks,
           $3 AS org_id
  ), win AS (
    SELECT p.as_of, p.weeks, p.org_id,
           date_trunc('week', p.as_of)::date AS to_week,
           (date_trunc('week', p.as_of)::date - 7 * (p.weeks - 1)) AS from_week
    FROM params p
  ), inv AS (
    SELECT i.*, u.name AS trade_name, e.pay_week
    FROM public.trade_invoices i
    CROSS JOIN win w
    CROSS JOIN LATERAL (
      -- A crew share invoice carries no week_start: it counts in the Monday
      -- week (Perth) it was sent.
      SELECT COALESCE(i.week_start,
                      date_trunc('week', (COALESCE(i.submitted_at, i.created_at) AT TIME ZONE 'Australia/Perth'))::date) AS pay_week
    ) e
    LEFT JOIN public.users u ON u.id = i.user_id
    WHERE e.pay_week >= w.from_week AND e.pay_week < w.to_week + 7
      AND i.status IS DISTINCT FROM 'draft'
      AND i.status IS DISTINCT FROM 'ops-reject'
      @invoice_kind@
      AND (w.org_id IS NULL OR i.org_id = w.org_id)
  ), live_inv AS (
    -- Every live invoice in any week, for the cross-invoice checks. A bill
    -- voided or deleted in Xero is not a live claim on a work order or a week.
    SELECT i.id, i.user_id, i.week_start, i.org_id, COALESCE(i.invoice_source, '') AS src, i.super_basis, @kind_value@ AS invoice_kind
    FROM public.trade_invoices i
    CROSS JOIN win w
    WHERE i.status IS DISTINCT FROM 'draft'
      AND i.status IS DISTINCT FROM 'ops-reject'
      @invoice_kind@
      AND upper(COALESCE(i.xero_bill_status, '')) NOT IN ('VOIDED', 'DELETED')
      AND (w.org_id IS NULL OR i.org_id = w.org_id)
  ), ln AS MATERIALIZED (
    SELECT l.*, i.user_id, i.pay_week, i.super_basis
    FROM inv i
    CROSS JOIN LATERAL (
      SELECT l.* FROM public.trade_invoice_lines l WHERE l.trade_invoice_id = i.id OFFSET 0
    ) l
  ), share_line AS MATERIALIZED (
    -- Existing line indexes: group_share_id and job_work_order_id. Only the
    -- run's share coordinates are searched, across every live pay week.
    SELECT l.id AS line_id, l.trade_invoice_id, li.user_id, l.group_share_id, l.job_work_order_id,
           l.job_id, l.line_total_ex, li.invoice_kind
    FROM (
      SELECT hit.* FROM (SELECT DISTINCT s.id FROM public.group_work_order_shares s WHERE s.group_id IN (
        SELECT own.group_id FROM ln run_line JOIN public.group_work_order_shares own ON own.id = run_line.group_share_id
        WHERE run_line.line_type = 'group share')) coordinate
      CROSS JOIN LATERAL (SELECT l.* FROM public.trade_invoice_lines l WHERE l.group_share_id = coordinate.id OFFSET 0) hit
      UNION
      SELECT hit.* FROM (SELECT DISTINCT job_work_order_id FROM ln WHERE line_type = 'group share'
        AND job_work_order_id IS NOT NULL) coordinate
      CROSS JOIN LATERAL (SELECT l.* FROM public.trade_invoice_lines l WHERE l.job_work_order_id = coordinate.job_work_order_id OFFSET 0) hit
      UNION
      SELECT l.* FROM ln run_line
      CROSS JOIN LATERAL (SELECT l.* FROM public.trade_invoice_lines l WHERE l.id = run_line.id OFFSET 0) l
      WHERE run_line.line_type = 'group share' AND run_line.group_share_id IS NULL AND run_line.job_work_order_id IS NULL
    ) l
    JOIN live_inv li ON li.id = l.trade_invoice_id
    WHERE l.line_type = 'group share'
  ), grouped_share_lines AS MATERIALIZED (
    SELECT l.*, g.id AS group_id, g.pay_basis, g.created_at AS group_opened_at, g.split_frozen_at
    FROM share_line l
    LEFT JOIN public.group_work_order_shares s ON s.id = l.group_share_id
    JOIN public.group_work_orders g ON g.id = s.group_id
      OR (s.id IS NULL AND g.work_order_id = l.job_work_order_id AND g.job_id = l.job_id)
  ), group_totals AS (
    SELECT g.group_id, sum(g.line_total_ex) AS billed,
      (SELECT CASE WHEN count(DISTINCT s.pot_ex) = 1 THEN max(s.pot_ex) END
       FROM public.group_work_order_shares s WHERE s.group_id = g.group_id) AS pot
    FROM grouped_share_lines g
    WHERE g.pay_basis = 'inclusive_12_112_v1' AND g.split_frozen_at IS NOT NULL
    GROUP BY g.group_id
  ), wo_totals AS (
    SELECT l.job_work_order_id,
           max(w.agreed_labour_ex
             + COALESCE((SELECT sum(v.trade_allocation_ex) FROM public.work_order_customer_variations v
                         WHERE v.work_order_id = w.id AND v.status = 'approved'), 0)
             + @amount_change@) AS agreed,
           sum(l.line_total_ex) FILTER (WHERE l.line_type = 'work order'
             OR (l.line_type = 'group share' AND li.super_basis = 'inclusive_12_112_v1')) AS wo_billed,
           count(DISTINCT li.user_id) FILTER (WHERE l.line_type = 'work order'
             OR (l.line_type = 'group share' AND li.super_basis = 'inclusive_12_112_v1')) AS wo_trades,
           sum(l.line_total_ex) FILTER (WHERE l.line_type IN ('work order', 'labour', 'general labour', 'make safe', 'fencing', 'patio', 'decking')
             OR (l.line_type = 'group share' AND li.super_basis = 'inclusive_12_112_v1')) AS labour_billed
    FROM public.trade_invoice_lines l
    JOIN live_inv li ON li.id = l.trade_invoice_id
    JOIN public.work_orders w ON w.id = l.job_work_order_id
    WHERE l.job_work_order_id IN (SELECT job_work_order_id FROM ln WHERE job_work_order_id IS NOT NULL)
    GROUP BY l.job_work_order_id
  ), pays AS (
    SELECT i.id,
           round(COALESCE(i.net_pay, 0)
                 + CASE WHEN i.gst_on THEN COALESCE(i.gst, 0) ELSE 0 END
                 - COALESCE(i.recurring_deduction_amount, 0)
                 + COALESCE(i.xero_adjustments_ex, 0), 2) AS invoice_pays
    FROM inv i
  ), line_sums AS (
    SELECT i.id, count(l.id) AS n_lines, round(COALESCE(sum(l.line_total_ex), 0), 2) AS lines_ex
    FROM inv i LEFT JOIN ln l ON l.trade_invoice_id = i.id
    GROUP BY i.id
  ), findings AS (
    SELECT i.id AS invoice_id, 'stop'::text AS kind, 'invoice_not_approved'::text AS code,
           ('The office has not approved this invoice yet (it is ' || replace(COALESCE(i.status, 'blank'), '_', ' ') || ').')::text AS text, 0 AS ord
    FROM inv i WHERE $4 = 'after_xero' AND COALESCE(i.status, '') NOT IN ('approved', 'pushed_to_xero', 'paid')
    UNION ALL
    SELECT i.id, 'stop', 'lines_differ',
           CASE WHEN s.n_lines = 0 THEN 'The invoice has no lines.'
                ELSE 'The invoice''s lines add up to $' || to_char(s.lines_ex, 'FM999,999,999,990.00')
                     || ', and its total before super is $' || to_char(COALESCE(i.subtotal_ex, 0), 'FM999,999,999,990.00') || '.' END, 0
    FROM inv i JOIN line_sums s ON s.id = i.id
    WHERE s.n_lines = 0 OR abs(s.lines_ex - COALESCE(i.subtotal_ex, 0)) > 0.05
    UNION ALL
    SELECT i.id, 'stop', 'pay_above_lines',
           'The invoice pays $' || to_char(COALESCE(i.net_pay, 0), 'FM999,999,999,990.00')
             || ' before GST, more than its lines come to ($' || to_char(COALESCE(i.subtotal_ex, 0), 'FM999,999,999,990.00') || ').', 0
    FROM inv i
    WHERE COALESCE(i.net_pay, 0) > COALESCE(i.subtotal_ex, 0) + 0.05
    UNION ALL
    SELECT i.id, 'stop', 'not_in_xero', 'Not in Xero yet.', 1
    FROM inv i WHERE $4 = 'after_xero' AND i.xero_bill_id IS NULL
    UNION ALL
    SELECT i.id, 'stop', 'xero_bill_voided', 'The Xero bill was voided or deleted.', 2
    FROM inv i
    WHERE $4 = 'after_xero' AND i.xero_bill_id IS NOT NULL AND upper(COALESCE(i.xero_bill_status, '')) IN ('VOIDED', 'DELETED')
    UNION ALL
    SELECT i.id, 'stop', 'xero_amount_differs',
           'The Xero bill is ' || CASE WHEN i.xero_bill_total < 0 THEN '-$' ELSE '$' END
             || to_char(abs(i.xero_bill_total), 'FM999,999,999,990.00')
             || ', and the invoice pays ' || CASE WHEN p.invoice_pays < 0 THEN '-$' ELSE '$' END
             || to_char(abs(p.invoice_pays), 'FM999,999,999,990.00') || '.', 3
    FROM inv i JOIN pays p ON p.id = i.id
    WHERE $4 = 'after_xero' AND i.xero_bill_id IS NOT NULL AND i.xero_bill_total IS NOT NULL
      AND upper(COALESCE(i.xero_bill_status, '')) NOT IN ('VOIDED', 'DELETED')
      AND abs(i.xero_bill_total - p.invoice_pays) > 0.05
    UNION ALL
    SELECT i.id, 'stop', 'xero_total_not_read', 'The Xero bill''s total has not been read yet.', 3
    FROM inv i
    WHERE $4 = 'after_xero' AND i.xero_bill_id IS NOT NULL AND i.xero_bill_total IS NULL
      AND upper(COALESCE(i.xero_bill_status, '')) NOT IN ('VOIDED', 'DELETED')
    UNION ALL
    -- invoice_pays adds back every change made in Xero, so a changed bill
    -- always "matches". A change that pays the trade more, or one of our own
    -- lines edited by hand (xero-sync kind 'unexplained'), needs a person.
    -- An office line that takes money off (a loan repayment) stays a note.
    SELECT i.id, 'stop', 'xero_changed_by_hand',
           CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(
                               CASE WHEN jsonb_typeof(i.xero_adjustment_lines) = 'array' THEN i.xero_adjustment_lines ELSE '[]'::jsonb END) x
                             WHERE x->>'kind' = 'unexplained')
                THEN 'A line from the invoice was changed by hand in Xero.'
                WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(
                               CASE WHEN jsonb_typeof(i.xero_adjustment_lines) = 'array' THEN i.xero_adjustment_lines ELSE '[]'::jsonb END) x
                             WHERE jsonb_typeof(x->'amount') IS DISTINCT FROM 'number')
                THEN 'A line on the Xero bill could not be read.'
                WHEN COALESCE(i.xero_adjustments_ex, 0) > 0.005
                THEN 'The Xero bill was changed by hand to pay $' || to_char(i.xero_adjustments_ex, 'FM999,999,999,990.00') || ' more.'
                ELSE 'A line adding money was put on the Xero bill by hand.' END, 3
    FROM inv i
    WHERE $4 = 'after_xero' AND upper(COALESCE(i.xero_bill_status, '')) NOT IN ('VOIDED', 'DELETED')
      AND (COALESCE(i.xero_adjustments_ex, 0) > 0.005
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(
                        CASE WHEN jsonb_typeof(i.xero_adjustment_lines) = 'array' THEN i.xero_adjustment_lines ELSE '[]'::jsonb END) x
                      WHERE x->>'kind' = 'unexplained'
                         OR jsonb_typeof(x->'amount') IS DISTINCT FROM 'number'
                         OR CASE WHEN jsonb_typeof(x->'amount') = 'number' THEN (x->>'amount')::numeric END > 0.005))
    UNION ALL
    SELECT * FROM (
      SELECT DISTINCT ON (l.trade_invoice_id, l.job_work_order_id)
             l.trade_invoice_id, 'stop', 'work_order_over_agreed',
             'The work order on ' || COALESCE(l.job_number, 'a job') || ' is billed $'
               || to_char(t.wo_billed, 'FM999,999,999,990.00')
               || CASE WHEN t.wo_trades > 1 THEN ' by ' || t.wo_trades || ' trades' ELSE '' END
               || ', and $' || to_char(t.agreed, 'FM999,999,999,990.00') || ' was agreed.', 4
      FROM ln l JOIN wo_totals t ON t.job_work_order_id = l.job_work_order_id
      WHERE (l.line_type = 'work order' OR (l.line_type = 'group share' AND l.super_basis = 'inclusive_12_112_v1'))
        AND t.agreed IS NOT NULL AND t.wo_billed > t.agreed
      ORDER BY l.trade_invoice_id, l.job_work_order_id, l.job_number
    ) wo_over
    UNION ALL
    SELECT * FROM (
      SELECT DISTINCT ON (l.trade_invoice_id, l.job_id)
             l.trade_invoice_id, 'stop', 'work_order_not_agreed',
             'The work order on ' || COALESCE(l.job_number, 'a job')
               || ' has no agreed amount on file to check it against.', 4
      FROM ln l
      LEFT JOIN public.work_orders w ON w.id = l.job_work_order_id
      WHERE l.line_type = 'work order'
        AND w.agreed_labour_ex IS NULL
      ORDER BY l.trade_invoice_id, l.job_id, l.job_number
    ) wo_none
    UNION ALL
    SELECT * FROM (
      SELECT DISTINCT ON (l.trade_invoice_id, l.job_id, COALESCE(l.hourly_rate, l.unit_rate))
             l.trade_invoice_id, 'stop', 'rate_above_office',
             'The rate on ' || COALESCE(l.job_number, 'a job') || ' is $' || to_char(COALESCE(l.hourly_rate, l.unit_rate), 'FM999,999,990.00')
               || ' an hour, above the office rate of $' || to_char(r.rate, 'FM999,999,990.00') || '.', 5
      FROM ln l
      CROSS JOIN LATERAL (
        SELECT tr.hourly_rate AS rate
        FROM public.trade_rates tr
        WHERE tr.user_id = l.user_id
          AND tr.effective_from <= COALESCE(l.work_date, l.line_date, l.pay_week)
          AND (tr.effective_to IS NULL OR tr.effective_to >= COALESCE(l.work_date, l.line_date, l.pay_week))
        ORDER BY tr.effective_from DESC
        LIMIT 1
      ) r
      WHERE l.line_type IN ('labour', 'general labour', 'make safe')
        AND COALESCE(l.hourly_rate, l.unit_rate) IS NOT NULL
        AND COALESCE(l.hourly_rate, l.unit_rate) > r.rate + 0.005
        AND NOT EXISTS (
          SELECT 1 FROM public.job_assignments a
          WHERE a.user_id = l.user_id AND a.job_id = l.job_id
            AND a.status IS DISTINCT FROM 'cancelled'
            AND a.hourly_rate IS NOT NULL AND abs(a.hourly_rate - COALESCE(l.hourly_rate, l.unit_rate)) <= 0.005)
      ORDER BY l.trade_invoice_id, l.job_id, COALESCE(l.hourly_rate, l.unit_rate), l.job_number
    ) rate_off
    UNION ALL
    SELECT DISTINCT l.trade_invoice_id, 'stop', 'line_on_no_job', 'A line is on no job.', 6
    FROM ln l
    WHERE l.job_id IS NULL
      AND l.line_type IN ('labour', 'general labour', 'make safe', 'work order', 'group share', 'fencing', 'patio', 'decking')
    UNION ALL
    SELECT i.id, 'stop', 'second_invoice_same_week',
           'There is another invoice from this trade for the same week.', 7
    FROM inv i
    WHERE @not_follow_on_i@ AND EXISTS (
      SELECT 1 FROM live_inv j
      WHERE j.user_id = i.user_id AND j.week_start = i.week_start
        AND j.invoice_kind <> 'follow_on' AND j.id <> i.id AND j.src = COALESCE(i.invoice_source, ''))
    UNION ALL
    SELECT DISTINCT a.trade_invoice_id, 'stop', 'second_invoice_same_week',
           'There is another invoice from this trade for the same crew share.', 7
    FROM share_line a
    JOIN inv i ON i.id = a.trade_invoice_id
    WHERE a.invoice_kind <> 'follow_on' AND EXISTS (
      SELECT 1 FROM share_line b
      WHERE b.invoice_kind <> 'follow_on' AND b.user_id = a.user_id AND b.line_id <> a.line_id
        AND (b.group_share_id = a.group_share_id OR b.job_work_order_id = a.job_work_order_id))
    UNION ALL
    SELECT DISTINCT a.trade_invoice_id, 'stop', 'share_without_group',
           'A crew share line names no group work order.', 7
    FROM share_line a
    JOIN inv i ON i.id = a.trade_invoice_id
    WHERE a.group_share_id IS NULL AND a.job_work_order_id IS NULL
    UNION ALL
    SELECT i.id, 'stop', 'super_not_inclusive',
           'This invoice does not use the inclusive super rule for its pay week.', 8
    FROM inv i CROSS JOIN public.trade_pay_settings settings
    WHERE settings.id = 1 AND settings.inclusive_super_from IS NOT NULL
      AND COALESCE(i.week_start, (COALESCE(i.submitted_at, i.created_at) AT TIME ZONE 'Australia/Perth')::date) >= settings.inclusive_super_from
      AND EXISTS (SELECT 1 FROM public.feature_flags f WHERE f.flag_name = 'trade_pay_inclusive_super_v1' AND f.enabled)
      AND i.super_basis IS DISTINCT FROM 'inclusive_12_112_v1'
      AND NOT (i.super_basis IS NOT DISTINCT FROM 'employer_12_v2'
        AND EXISTS (SELECT 1 FROM ln l WHERE l.trade_invoice_id = i.id)
        AND NOT EXISTS (SELECT 1 FROM ln l WHERE l.trade_invoice_id = i.id AND
          (l.line_type IS DISTINCT FROM 'group share' OR NOT EXISTS (
            SELECT 1 FROM grouped_share_lines g WHERE g.line_id = l.id
              AND g.pay_basis = 'all_in_12_v2'
              AND (g.group_opened_at AT TIME ZONE 'Australia/Perth')::date < settings.inclusive_super_from))))
    UNION ALL
    SELECT i.id, 'stop', 'super_wrong',
           'The super or the amount paid to you does not add up to the cent.', 8
    FROM inv i
    WHERE i.super_basis = 'inclusive_12_112_v1'
      AND (i.gross_earned IS NULL OR i.super_amount IS NULL OR i.net_pay IS NULL
        OR i.super_amount IS DISTINCT FROM round(COALESCE(i.super_base_ex, i.gross_earned) * 12 / 112, 2)
        OR i.net_pay IS DISTINCT FROM i.gross_earned - i.super_amount)
    UNION ALL
    SELECT DISTINCT l.trade_invoice_id, 'stop', 'reimbursement_no_receipt',
           'A reimbursement has no stored receipt image.', 8
    FROM ln l LEFT JOIN public.expense_receipts e ON e.id = l.expense_receipt_id
    WHERE l.line_type = 'reimbursement' AND NULLIF(btrim(e.receipt_storage_path), '') IS NULL
      AND NULLIF(btrim(e.receipt_photo_url), '') IS NULL
    UNION ALL
    SELECT DISTINCT l.trade_invoice_id, 'stop', 'reimbursement_account_not_set',
           'The office needs to set the reimbursement account before this invoice is paid.', 8
    FROM ln l WHERE l.line_type = 'reimbursement' AND NOT EXISTS (
      SELECT 1 FROM public.trade_pay_settings s WHERE s.id = 1 AND NULLIF(btrim(s.reimbursement_account_code), '') IS NOT NULL)
    UNION ALL
    -- cl-payrun-v1-followups: a pay-back line whose receipt is marked not booked on its job
    -- (expense_receipts.unbooked_job_id, 20261118194000) and not yet confirmed by the office.
    -- The held term is job_cost_lines_sync_receipt's (20261118194300) and expenseHeldNotBooked's
    -- (expense_own_job.ts), word for word; change the three together.
    SELECT DISTINCT l.trade_invoice_id, 'stop', 'reimbursement_not_booked_unconfirmed',
           'A pay-back receipt is from someone not booked on its job, and the office has not confirmed it yet.', 8
    FROM ln l JOIN public.expense_receipts e ON e.id = l.expense_receipt_id
    WHERE l.line_type = 'reimbursement' AND e.unbooked_job_id IS NOT NULL
      AND lower(coalesce(e.status,'')) NOT IN ('approved','pushed_to_xero')
    UNION ALL
    SELECT DISTINCT l.trade_invoice_id, 'stop', 'commission_no_record',
           'A commission has no named commission record on its job.', 8
    FROM ln l WHERE l.line_type = 'commission'
      AND EXISTS (SELECT 1 FROM public.feature_flags f WHERE f.flag_name = 'commission_from_job_only_v1' AND f.enabled)
      AND NOT EXISTS (SELECT 1 FROM public.job_commissions c WHERE c.job_id = l.job_id AND c.state = 'named')
    UNION ALL
    SELECT DISTINCT l.trade_invoice_id, 'stop', 'work_order_missing',
           'An open job on this invoice has no job work order.', 8
    FROM ln l JOIN public.jobs j ON j.id = l.job_id
    WHERE l.line_type IS DISTINCT FROM 'reimbursement'
      AND lower(COALESCE(j.status, '')) NOT IN ('complete', 'completed', 'closed', 'archived', 'cancelled', 'lost')
      AND NOT EXISTS (SELECT 1 FROM public.work_orders w WHERE w.job_id = l.job_id AND w.kind = 'job')
    UNION ALL
    SELECT DISTINCT g.trade_invoice_id, 'stop', 'group_shares_differ_from_pool',
           'The live crew share lines do not add up to the frozen group pot.', 8
    FROM grouped_share_lines g JOIN inv i ON i.id = g.trade_invoice_id
    JOIN group_totals t ON t.group_id = g.group_id
    WHERE t.billed IS DISTINCT FROM t.pot
    UNION ALL
    SELECT DISTINCT l.trade_invoice_id, 'stop', 'not_job_work_account_not_set',
           'The office needs to set the account for work without a job.', 8
    FROM ln l WHERE l.not_job_work_type_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.trade_pay_settings s WHERE s.id = 1 AND NULLIF(btrim(s.not_job_work_account_code), '') IS NOT NULL)
    UNION ALL
    SELECT DISTINCT l.trade_invoice_id, 'stop', 'held_line_in_run',
           'A line on this invoice is still held for the office.', 8
    FROM ln l WHERE l.office_review_status IN ('awaiting', 'queried', 'rejected')
    UNION ALL
    SELECT i.id, 'stop', 'repayment_account_not_set',
           'The office needs to set the account for this repayment.', 8
    FROM inv i JOIN public.trade_recurring_deductions d ON d.id = i.recurring_deduction_id
    WHERE COALESCE(i.recurring_deduction_amount, 0) > 0 AND d.kind = 'repayment'
      AND NULLIF(btrim(d.xero_account_code), '') IS NULL
    UNION ALL
    SELECT * FROM (
      SELECT DISTINCT ON (l.trade_invoice_id, l.job_id)
             l.trade_invoice_id, 'note', 'hours_over_expected',
             'More hours than expected on ' || COALESCE(l.job_number, 'a job')
               || CASE WHEN l.baseline_hours IS NOT NULL AND l.total_hours IS NOT NULL
                       THEN ': ' || to_char(l.total_hours, 'FM9,990.0#') || ' h, and '
                            || to_char(l.baseline_hours, 'FM9,990.0#') || ' h were expected.'
                       ELSE '.' END, 11
      FROM ln l
      WHERE l.flag_type = 'hours_over_baseline'
      ORDER BY l.trade_invoice_id, l.job_id, l.total_hours DESC NULLS LAST
    ) hrs
    UNION ALL
    SELECT * FROM (
      SELECT DISTINCT ON (l.trade_invoice_id, l.job_work_order_id)
             l.trade_invoice_id, 'note', 'labour_over_agreed',
             'All labour on ' || COALESCE(l.job_number, 'a job') || ' comes to $'
               || to_char(t.labour_billed, 'FM999,999,999,990.00') || ', and $'
               || to_char(t.agreed, 'FM999,999,999,990.00') || ' was agreed.', 12
      FROM ln l JOIN wo_totals t ON t.job_work_order_id = l.job_work_order_id
      WHERE t.agreed IS NOT NULL AND t.labour_billed > t.agreed + 0.05
        AND NOT (t.wo_billed IS NOT NULL AND t.wo_billed > t.agreed)
      ORDER BY l.trade_invoice_id, l.job_work_order_id, l.job_number
    ) lab
    UNION ALL
    SELECT * FROM (
      SELECT DISTINCT ON (l.trade_invoice_id, l.job_id, l.work_date)
             l.trade_invoice_id, 'note', 'day_not_booked',
             'Not booked on ' || COALESCE(l.job_number, 'the job') || ' on '
               || to_char(l.work_date, 'FMDay FMDD Mon') || '.', 13
      FROM ln l
      WHERE l.work_date IS NOT NULL AND l.job_id IS NOT NULL
        AND l.line_type IN ('labour', 'general labour', 'make safe')
        AND NOT EXISTS (
          SELECT 1 FROM public.job_assignments a
          WHERE a.user_id = l.user_id AND a.job_id = l.job_id
            AND a.status IS DISTINCT FROM 'cancelled'
            AND l.work_date BETWEEN a.scheduled_date
                                AND GREATEST(a.scheduled_date, COALESCE(a.scheduled_end, a.scheduled_date)))
      ORDER BY l.trade_invoice_id, l.job_id, l.work_date, l.job_number
    ) unbooked
    UNION ALL
    SELECT i.id, 'note', 'changed_in_xero',
           'The office changed the bill in Xero by ' || CASE WHEN i.xero_adjustments_ex < 0 THEN '-$' ELSE '$' END
             || to_char(abs(i.xero_adjustments_ex), 'FM999,999,999,990.00') || '.', 14
    FROM inv i
    WHERE COALESCE(i.xero_adjustments_ex, 0) < -0.005
    UNION ALL
    -- cl-1622-fix, director ruling 15:54: an hourly line on a job with no
    -- agreed amount on file is a note: shown and counted, never a stop. To
    -- make it a stop later, change 'note' to 'stop' on the kind line below.
    SELECT * FROM (
      SELECT DISTINCT ON (l.trade_invoice_id, l.job_id)
             l.trade_invoice_id,
             'note',
             'hourly_no_agreed_amount',
             'Hours on ' || COALESCE(l.job_number, 'a job')
               || ' are not checked against an agreed amount: none is on file.', 15
      FROM ln l
      WHERE l.job_id IS NOT NULL
        AND l.line_type IN ('labour', 'general labour', 'make safe')
        AND NOT EXISTS (SELECT 1 FROM public.work_orders w
                        WHERE w.job_id = l.job_id AND w.kind = 'job'
                          AND w.agreed_labour_ex IS NOT NULL)
      ORDER BY l.trade_invoice_id, l.job_id, l.job_number
    ) hourly_unagreed
  ), per_invoice AS (
    SELECT i.id, i.invoice_number, i.user_id, COALESCE(i.trade_name, 'A trade') AS trade_name,
           i.pay_week AS week_start, i.status, i.xero_bill_id, i.xero_bill_status, i.xero_bill_total,
           p.invoice_pays, i.super_amount, i.net_pay AS paid_to_you, @pay_run_id@ AS pay_run_id,
           (COALESCE(i.status = 'paid', false) OR upper(COALESCE(i.xero_bill_status, '')) = 'PAID') AS paid,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('code', f.code, 'text', f.text, 'words', f.text) ORDER BY f.ord, f.text)
                     FROM findings f WHERE f.invoice_id = i.id AND f.kind = 'stop'), '[]'::jsonb) AS stops,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('code', f.code, 'text', f.text, 'words', f.text) ORDER BY f.ord, f.text)
                     FROM findings f WHERE f.invoice_id = i.id AND f.kind = 'note'), '[]'::jsonb) AS notes
    FROM inv i JOIN pays p ON p.id = i.id
  )
  SELECT jsonb_build_object(
    'rule', 'trade-pay-check-v2',
    'stage', $4,
    'as_of', w.as_of,
    'weeks', w.weeks,
    'from_week', w.from_week,
    'to_week', w.to_week,
    'counts', jsonb_build_object(
      'invoices', (SELECT count(*) FROM per_invoice),
      'clean', (SELECT count(*) FROM per_invoice WHERE jsonb_array_length(stops) = 0),
      'clean_with_notes', (SELECT count(*) FROM per_invoice WHERE jsonb_array_length(stops) = 0 AND jsonb_array_length(notes) > 0),
      'stopped', (SELECT count(*) FROM per_invoice WHERE jsonb_array_length(stops) > 0),
      'to_pay', (SELECT count(*) FROM per_invoice WHERE NOT paid),
      'to_pay_clean', (SELECT count(*) FROM per_invoice WHERE NOT paid AND jsonb_array_length(stops) = 0),
      'to_pay_stopped', (SELECT count(*) FROM per_invoice WHERE NOT paid AND jsonb_array_length(stops) > 0),
      'undated', (SELECT count(*) FROM public.trade_invoices u
                  WHERE u.week_start IS NULL AND u.submitted_at IS NULL AND u.created_at IS NULL
                    AND u.status IS DISTINCT FROM 'draft' AND u.status IS DISTINCT FROM 'ops-reject'
                    @undated_kind@
                    AND (w.org_id IS NULL OR u.org_id = w.org_id))),
    'invoices', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'invoice_id', pi.id,
               'invoice_number', pi.invoice_number,
               'user_id', pi.user_id,
               'trade_name', pi.trade_name,
               'week_start', pi.week_start,
               'status', pi.status,
               'xero_bill_id', pi.xero_bill_id,
               'xero_bill_status', pi.xero_bill_status,
               'xero_bill_total', pi.xero_bill_total,
               'invoice_pays', pi.invoice_pays,
               'super_amount', pi.super_amount,
               'paid_to_you', pi.paid_to_you,
               'pay_run_id', pi.pay_run_id,
               'stage', $4,
               'paid', pi.paid,
               'verdict', CASE WHEN jsonb_array_length(pi.stops) > 0 THEN 'stopped' ELSE 'clean' END,
               'stops', pi.stops,
               'notes', pi.notes)
             ORDER BY pi.paid, (jsonb_array_length(pi.stops) = 0), pi.week_start DESC, pi.trade_name, pi.id)
      FROM per_invoice pi), '[]'::jsonb)
  )
  FROM win w
$query$;
  v_query := replace(v_query, '@invoice_kind@', CASE WHEN v_has_kind THEN 'AND i.invoice_kind IN (''standard'', ''follow_on'')' ELSE '' END);
  v_query := replace(v_query, '@undated_kind@', CASE WHEN v_has_kind THEN 'AND u.invoice_kind IN (''standard'', ''follow_on'')' ELSE '' END);
  v_query := replace(v_query, '@kind_value@', CASE WHEN v_has_kind THEN 'i.invoice_kind' ELSE '''standard''::text' END);
  v_query := replace(v_query, '@not_follow_on_i@', CASE WHEN v_has_kind THEN 'i.invoice_kind <> ''follow_on''' ELSE 'true' END);
  v_query := replace(v_query, '@pay_run_id@', CASE WHEN v_has_run THEN 'i.pay_run_id' ELSE 'NULL::uuid' END);
  v_query := replace(v_query, '@amount_change@', CASE WHEN to_regprocedure('public.work_order_amount_change_total(uuid)') IS NOT NULL
    THEN 'public.work_order_amount_change_total(w.id)' ELSE '0::numeric' END);
  EXECUTE v_query INTO v_result USING p_as_of, p_weeks, p_org_id, p_stage;
  RETURN v_result;
END $function$;
COMMENT ON FUNCTION public.trade_pay_run_check_v2(date,integer,uuid,text) IS
  'Trade pay-run check, rule trade-pay-check-v2. Service role read only; before_xero or after_xero; no caller changed. P1-08.1; hourly_no_agreed_amount note cl-1622-fix; reimbursement_not_booked_unconfirmed stop cl-payrun-v1-followups.';
REVOKE ALL ON FUNCTION public.trade_pay_run_check_v2(date,integer,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trade_pay_run_check_v2(date,integer,uuid,text) TO service_role;

DO $own$
/* block */ BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.trade_pay_run_check_v2(date,integer,uuid,text)'))
     IS DISTINCT FROM 'c6c1f4da1fb43e2fb781b884502a7b5d' THEN
    RAISE EXCEPTION 'trade_pay_run_check_v2 rollback: did not restore 20261118194500''s body';
  END IF;
END $own$;
