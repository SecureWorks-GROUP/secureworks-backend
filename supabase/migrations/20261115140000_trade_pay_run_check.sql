-- Trade pay-run check (15 Nov 2026), rule trade-pay-check-v1.
--
-- One read that checks every live trade invoice in a run of pay weeks against
-- what the system already holds, and marks each one clean or stopped with
-- plain reasons. It lets the bookkeeper approve the clean bills in Xero in one
-- batch and look only at the stopped ones. Contract and wording:
-- docs/trade-pay-run-check-v1.md. Owner: CFO thread "Integrate trade app
-- redesign end to end" (secureworks-projects job-profit/trade-app/contract.md).
--
-- trade_pay_run_check(p_as_of, p_weeks, p_org_id) returns one jsonb document.
-- Read only: it writes nothing, never calls Xero, and changes no invoice.
-- Service role only; the ops-api door passes the caller's org.
--
-- Which invoices: every trade_invoices row whose pay week falls in the p_weeks
-- pay weeks (Monday to Sunday) ending with the week holding p_as_of, whose
-- status is not draft or ops-reject. The pay week is week_start, or for a crew
-- share invoice (which has none) the Monday of the Perth week it was sent.
--
-- A STOP means "do not approve this bill until a person has looked":
--   not_in_xero              the invoice has no Xero bill.
--   xero_bill_voided         its Xero bill is VOIDED or DELETED.
--   xero_amount_differs      the Xero bill total differs by more than 5 cents
--                            from what the invoice pays: net_pay, plus GST when
--                            gst_on, less the weekly deduction, plus the lines
--                            the office added in Xero (xero_adjustments_ex).
--   xero_total_not_read      the bill exists but its total has not been read.
--   xero_changed_by_hand     the bill was changed in Xero to pay more than the
--                            invoice, or one of the invoice's own lines was
--                            edited there (xero_adjustment_lines kind
--                            'unexplained'). invoice_pays adds every Xero
--                            change back, so the amount check alone cannot see
--                            these.
--   work_order_over_agreed   the 'work order' lines on one job work order,
--                            across every live invoice of every trade, add up
--                            to more than work_orders.agreed_labour_ex. Every
--                            invoice holding such a line is stopped. Crew
--                            shares ('group share') are not summed: their 12%
--                            super sits inside the share, and the group work
--                            order's release holds them until the shares add
--                            up to the pool.
--   work_order_not_agreed    a 'work order' line has no job work order with an
--                            agreed amount to check it against.
--   rate_above_office        an hourly labour line's rate is above the
--                            trade's office rate on that day (trade_rates) and
--                            is not the rate on the trade's booking for that
--                            job (job_assignments.hourly_rate). Trades set
--                            their own rate on each job (owner, 15 Nov 2026):
--                            a rate at or below the office rate passes, one
--                            above it is flagged for a person. With no office
--                            rate on file the rate is not judged.
--   line_on_no_job           a labour or agreed-amount line has no job.
--   Labour here is 'labour', 'general labour' and 'make safe' lines.
--   second_invoice_same_week another live invoice of the same source from the
--                            same trade for the same week.
--
-- A NOTE is shown and never stops a bill:
--   hours_over_expected      the line already carries flag hours_over_baseline.
--   labour_over_agreed       all labour on a job work order ('work order'
--                            lines plus hourly, make safe, fencing, patio and
--                            decking lines, every trade) is above the agreed
--                            amount, when the 'work order' lines alone are not.
--   day_not_booked           an hourly line's day has no booking of that trade
--                            on that job.
--   changed_in_xero          the office took money off the bill in Xero (a loan
--                            repayment, an overpayment taken back).
--
-- verdict is 'stopped' with any stop, else 'clean'. paid is true when the
-- invoice status is paid or its Xero bill is PAID. A bill voided or deleted in
-- Xero is left out of the work-order totals and the same-week check. Amounts are as stored; the
-- check works out none of the invoice's own figures.

CREATE OR REPLACE FUNCTION public.trade_pay_run_check(
  p_as_of date DEFAULT NULL,
  p_weeks integer DEFAULT 2,
  p_org_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  WITH params AS (
    SELECT COALESCE(p_as_of, (now() AT TIME ZONE 'Australia/Perth')::date) AS as_of,
           LEAST(GREATEST(COALESCE(p_weeks, 2), 1), 26) AS weeks,
           p_org_id AS org_id
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
      AND (w.org_id IS NULL OR i.org_id = w.org_id)
  ), live_inv AS (
    -- Every live invoice in any week, for the cross-invoice checks. A bill
    -- voided or deleted in Xero is not a live claim on a work order or a week.
    SELECT i.id, i.user_id, i.week_start, i.org_id, COALESCE(i.invoice_source, '') AS src
    FROM public.trade_invoices i
    CROSS JOIN win w
    WHERE i.status IS DISTINCT FROM 'draft'
      AND i.status IS DISTINCT FROM 'ops-reject'
      AND upper(COALESCE(i.xero_bill_status, '')) NOT IN ('VOIDED', 'DELETED')
      AND (w.org_id IS NULL OR i.org_id = w.org_id)
  ), ln AS (
    SELECT l.*, i.user_id, i.pay_week
    FROM public.trade_invoice_lines l
    JOIN inv i ON i.id = l.trade_invoice_id
  ), wo_totals AS (
    SELECT l.job_work_order_id,
           max(w.agreed_labour_ex) AS agreed,
           -- A crew share ('group share') is left out: its 12% super sits inside
           -- the share, so shares add up to more than the agreed labour, and the
           -- group work order's own release already holds every share until
           -- the shares add up to the pool.
           sum(l.line_total_ex) FILTER (WHERE l.line_type = 'work order') AS wo_billed,
           count(DISTINCT li.user_id) FILTER (WHERE l.line_type = 'work order') AS wo_trades,
           sum(l.line_total_ex) FILTER (WHERE l.line_type IN ('work order', 'labour', 'general labour', 'make safe', 'fencing', 'patio', 'decking')) AS labour_billed
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
  ), findings AS (
    SELECT i.id AS invoice_id, 'stop'::text AS kind, 'not_in_xero'::text AS code,
           'Not in Xero yet.'::text AS text, 1 AS ord
    FROM inv i WHERE i.xero_bill_id IS NULL
    UNION ALL
    SELECT i.id, 'stop', 'xero_bill_voided', 'The Xero bill was voided or deleted.', 2
    FROM inv i
    WHERE i.xero_bill_id IS NOT NULL AND upper(COALESCE(i.xero_bill_status, '')) IN ('VOIDED', 'DELETED')
    UNION ALL
    SELECT i.id, 'stop', 'xero_amount_differs',
           'The Xero bill is ' || CASE WHEN i.xero_bill_total < 0 THEN '-$' ELSE '$' END
             || to_char(abs(i.xero_bill_total), 'FM999,999,999,990.00')
             || ', and the invoice pays ' || CASE WHEN p.invoice_pays < 0 THEN '-$' ELSE '$' END
             || to_char(abs(p.invoice_pays), 'FM999,999,999,990.00') || '.', 3
    FROM inv i JOIN pays p ON p.id = i.id
    WHERE i.xero_bill_id IS NOT NULL AND i.xero_bill_total IS NOT NULL
      AND upper(COALESCE(i.xero_bill_status, '')) NOT IN ('VOIDED', 'DELETED')
      AND abs(i.xero_bill_total - p.invoice_pays) > 0.05
    UNION ALL
    SELECT i.id, 'stop', 'xero_total_not_read', 'The Xero bill''s total has not been read yet.', 3
    FROM inv i
    WHERE i.xero_bill_id IS NOT NULL AND i.xero_bill_total IS NULL
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
                ELSE 'The Xero bill was changed by hand to pay $' || to_char(i.xero_adjustments_ex, 'FM999,999,999,990.00') || ' more.' END, 3
    FROM inv i
    WHERE upper(COALESCE(i.xero_bill_status, '')) NOT IN ('VOIDED', 'DELETED')
      AND (COALESCE(i.xero_adjustments_ex, 0) > 0.005
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(
                        CASE WHEN jsonb_typeof(i.xero_adjustment_lines) = 'array' THEN i.xero_adjustment_lines ELSE '[]'::jsonb END) x
                      WHERE x->>'kind' = 'unexplained'))
    UNION ALL
    SELECT * FROM (
      SELECT DISTINCT ON (l.trade_invoice_id, l.job_work_order_id)
             l.trade_invoice_id, 'stop', 'work_order_over_agreed',
             'The work order on ' || COALESCE(l.job_number, 'a job') || ' is billed $'
               || to_char(t.wo_billed, 'FM999,999,999,990.00')
               || CASE WHEN t.wo_trades > 1 THEN ' by ' || t.wo_trades || ' trades' ELSE '' END
               || ', and $' || to_char(t.agreed, 'FM999,999,999,990.00') || ' was agreed.', 4
      FROM ln l JOIN wo_totals t ON t.job_work_order_id = l.job_work_order_id
      WHERE l.line_type = 'work order'
        AND t.agreed IS NOT NULL AND t.wo_billed > t.agreed + 0.05
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
      SELECT DISTINCT ON (l.trade_invoice_id, l.job_id, l.hourly_rate)
             l.trade_invoice_id, 'stop', 'rate_above_office',
             'The rate on ' || COALESCE(l.job_number, 'a job') || ' is $' || to_char(l.hourly_rate, 'FM9,990.00')
               || ' an hour, above the office rate of $' || to_char(r.rate, 'FM9,990.00') || '.', 5
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
        AND l.hourly_rate IS NOT NULL
        AND l.hourly_rate > r.rate + 0.005
        AND NOT EXISTS (
          SELECT 1 FROM public.job_assignments a
          WHERE a.user_id = l.user_id AND a.job_id = l.job_id
            AND a.hourly_rate IS NOT NULL AND abs(a.hourly_rate - l.hourly_rate) <= 0.005)
      ORDER BY l.trade_invoice_id, l.job_id, l.hourly_rate, l.job_number
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
    WHERE EXISTS (
      SELECT 1 FROM live_inv j
      WHERE j.user_id = i.user_id AND j.week_start = i.week_start
        AND j.id <> i.id AND j.src = COALESCE(i.invoice_source, ''))
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
        AND NOT (t.wo_billed IS NOT NULL AND t.wo_billed > t.agreed + 0.05)
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
  ), per_invoice AS (
    SELECT i.id, i.invoice_number, i.user_id, COALESCE(i.trade_name, 'A trade') AS trade_name,
           i.pay_week AS week_start, i.status, i.xero_bill_id, i.xero_bill_status, i.xero_bill_total,
           p.invoice_pays,
           (COALESCE(i.status = 'paid', false) OR upper(COALESCE(i.xero_bill_status, '')) = 'PAID') AS paid,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('code', f.code, 'text', f.text) ORDER BY f.ord, f.text)
                     FROM findings f WHERE f.invoice_id = i.id AND f.kind = 'stop'), '[]'::jsonb) AS stops,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('code', f.code, 'text', f.text) ORDER BY f.ord, f.text)
                     FROM findings f WHERE f.invoice_id = i.id AND f.kind = 'note'), '[]'::jsonb) AS notes
    FROM inv i JOIN pays p ON p.id = i.id
  )
  SELECT jsonb_build_object(
    'rule', 'trade-pay-check-v1',
    'as_of', w.as_of,
    'weeks', w.weeks,
    'from_week', w.from_week,
    'to_week', w.to_week,
    'counts', jsonb_build_object(
      'invoices', (SELECT count(*) FROM per_invoice),
      'clean', (SELECT count(*) FROM per_invoice WHERE jsonb_array_length(stops) = 0),
      'stopped', (SELECT count(*) FROM per_invoice WHERE jsonb_array_length(stops) > 0),
      'to_pay', (SELECT count(*) FROM per_invoice WHERE NOT paid),
      'to_pay_clean', (SELECT count(*) FROM per_invoice WHERE NOT paid AND jsonb_array_length(stops) = 0),
      'to_pay_stopped', (SELECT count(*) FROM per_invoice WHERE NOT paid AND jsonb_array_length(stops) > 0)),
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
               'paid', pi.paid,
               'verdict', CASE WHEN jsonb_array_length(pi.stops) > 0 THEN 'stopped' ELSE 'clean' END,
               'stops', pi.stops,
               'notes', pi.notes)
             ORDER BY pi.paid, (jsonb_array_length(pi.stops) = 0), pi.week_start DESC, pi.trade_name, pi.id)
      FROM per_invoice pi), '[]'::jsonb)
  )
  FROM win w
$$;

COMMENT ON FUNCTION public.trade_pay_run_check(date, integer, uuid) IS
  'Trade pay-run check, rule trade-pay-check-v1 (20261115140000): every live trade invoice (not draft or ops-reject) in the p_weeks Monday pay weeks ending with the week of p_as_of (Perth today when null; 1 to 26 weeks, default 2; a crew share counts in the week it was sent), marked clean or stopped. Stops: not_in_xero, xero_bill_voided, xero_amount_differs (more than 5 cents from net_pay plus GST when gst_on, less the weekly deduction, plus office lines added in Xero), xero_total_not_read, xero_changed_by_hand (pays more than the invoice, or an invoice line edited in Xero), work_order_over_agreed (work order lines on one job work order across every live invoice, voided bills and crew shares left out, above agreed_labour_ex), work_order_not_agreed, rate_above_office (hourly rate above the office rate on the day and not the booking rate; trades set their own rate, at or below the office rate passes), line_on_no_job, second_invoice_same_week. Labour includes make safe lines. Notes never stop a bill: hours_over_expected, labour_over_agreed, day_not_booked, changed_in_xero (money taken off in Xero). p_org_id scopes every read. Read only, writes nothing, never calls Xero. Service role only. Contract: docs/trade-pay-run-check-v1.md.';

REVOKE ALL ON FUNCTION public.trade_pay_run_check(date, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trade_pay_run_check(date, integer, uuid) TO service_role;
