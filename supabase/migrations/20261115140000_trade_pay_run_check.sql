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
-- Which invoices: every trade_invoices row whose week_start falls in the
-- p_weeks pay weeks (Monday to Sunday) ending with the week holding p_as_of,
-- whose status is not draft or ops-reject.
--
-- A STOP means "do not approve this bill until a person has looked":
--   not_in_xero              the invoice has no Xero bill.
--   xero_bill_voided         its Xero bill is VOIDED or DELETED.
--   xero_amount_differs      the Xero bill total differs by more than 5 cents
--                            from what the invoice pays: net_pay, plus GST when
--                            gst_on, less the weekly deduction, plus the lines
--                            the office added in Xero (xero_adjustments_ex).
--   work_order_over_agreed   the agreed-amount lines (line_type 'work order' or
--                            'group share') on one job work order, across every
--                            live invoice of every trade, add up to more than
--                            work_orders.agreed_labour_ex. Every invoice
--                            holding such a line is stopped.
--   rate_above_office        an hourly labour line's rate is above the
--                            trade's office rate on that day (trade_rates) and
--                            is not the rate on the trade's booking for that
--                            job (job_assignments.hourly_rate). Trades set
--                            their own rate on each job (owner, 15 Nov 2026):
--                            a rate at or below the office rate passes, one
--                            above it is flagged for a person. With no office
--                            rate on file the rate is not judged.
--   line_on_no_job           a labour or agreed-amount line has no job.
--   second_invoice_same_week another live invoice of the same source from the
--                            same trade for the same week.
--
-- A NOTE is shown and never stops a bill:
--   hours_over_expected      the line already carries flag hours_over_baseline.
--   labour_over_agreed       all labour on a job work order (agreed-amount
--                            lines plus hourly, fencing, patio and decking
--                            lines, every trade) is above the agreed amount,
--                            when the agreed-amount lines alone are not.
--   day_not_booked           an hourly line's day has no booking of that trade
--                            on that job.
--   changed_in_xero          the office added lines to the bill in Xero.
--
-- verdict is 'stopped' with any stop, else 'clean'. paid is true when the
-- invoice status is paid or its Xero bill is PAID. Amounts are as stored; the
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
    SELECT i.*, u.name AS trade_name
    FROM public.trade_invoices i
    CROSS JOIN win w
    LEFT JOIN public.users u ON u.id = i.user_id
    WHERE i.week_start BETWEEN w.from_week AND w.to_week
      AND i.status IS DISTINCT FROM 'draft'
      AND i.status IS DISTINCT FROM 'ops-reject'
      AND (w.org_id IS NULL OR i.org_id = w.org_id)
  ), live_inv AS (
    SELECT i.id, i.user_id, i.week_start, i.org_id, COALESCE(i.invoice_source, '') AS src
    FROM public.trade_invoices i
    CROSS JOIN win w
    WHERE i.status IS DISTINCT FROM 'draft'
      AND i.status IS DISTINCT FROM 'ops-reject'
      AND (w.org_id IS NULL OR i.org_id = w.org_id)
  ), ln AS (
    SELECT l.*, i.user_id, i.week_start
    FROM public.trade_invoice_lines l
    JOIN inv i ON i.id = l.trade_invoice_id
  ), wo_totals AS (
    SELECT l.job_work_order_id,
           max(w.agreed_labour_ex) AS agreed,
           sum(l.line_total_ex) FILTER (WHERE l.line_type IN ('work order', 'group share')) AS wo_billed,
           count(DISTINCT li.user_id) FILTER (WHERE l.line_type IN ('work order', 'group share')) AS wo_trades,
           sum(l.line_total_ex) FILTER (WHERE l.line_type IN ('work order', 'group share', 'labour', 'general labour', 'fencing', 'patio', 'decking')) AS labour_billed
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
           'The Xero bill is $' || to_char(i.xero_bill_total, 'FM999,999,990.00')
             || ', and the invoice pays $' || to_char(p.invoice_pays, 'FM999,999,990.00') || '.', 3
    FROM inv i JOIN pays p ON p.id = i.id
    WHERE i.xero_bill_id IS NOT NULL AND i.xero_bill_total IS NOT NULL
      AND upper(COALESCE(i.xero_bill_status, '')) NOT IN ('VOIDED', 'DELETED')
      AND abs(i.xero_bill_total - p.invoice_pays) > 0.05
    UNION ALL
    SELECT * FROM (
      SELECT DISTINCT ON (l.trade_invoice_id, l.job_work_order_id)
             l.trade_invoice_id, 'stop', 'work_order_over_agreed',
             'The work order on ' || COALESCE(l.job_number, 'a job') || ' is billed $'
               || to_char(t.wo_billed, 'FM999,999,990.00')
               || CASE WHEN t.wo_trades > 1 THEN ' by ' || t.wo_trades || ' trades' ELSE '' END
               || ', and $' || to_char(t.agreed, 'FM999,999,990.00') || ' was agreed.', 4
      FROM ln l JOIN wo_totals t ON t.job_work_order_id = l.job_work_order_id
      WHERE l.line_type IN ('work order', 'group share')
        AND t.agreed IS NOT NULL AND t.wo_billed > t.agreed + 0.05
      ORDER BY l.trade_invoice_id, l.job_work_order_id, l.job_number
    ) wo_over
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
          AND tr.effective_from <= COALESCE(l.work_date, l.line_date, l.week_start)
          AND (tr.effective_to IS NULL OR tr.effective_to >= COALESCE(l.work_date, l.line_date, l.week_start))
        ORDER BY tr.effective_from DESC
        LIMIT 1
      ) r
      WHERE l.line_type IN ('labour', 'general labour')
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
      AND l.line_type IN ('labour', 'general labour', 'work order', 'group share', 'fencing', 'patio', 'decking')
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
               || to_char(t.labour_billed, 'FM999,999,990.00') || ', and $'
               || to_char(t.agreed, 'FM999,999,990.00') || ' was agreed.', 12
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
        AND l.line_type IN ('labour', 'general labour')
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
           'The office changed the bill in Xero by $' || to_char(i.xero_adjustments_ex, 'FM999,999,990.00') || '.', 14
    FROM inv i
    WHERE COALESCE(i.xero_adjustments_ex, 0) <> 0
  ), per_invoice AS (
    SELECT i.id, i.invoice_number, i.user_id, COALESCE(i.trade_name, 'A trade') AS trade_name,
           i.week_start, i.status, i.xero_bill_id, i.xero_bill_status, i.xero_bill_total,
           p.invoice_pays,
           (i.status = 'paid' OR upper(COALESCE(i.xero_bill_status, '')) = 'PAID') AS paid,
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
  'Trade pay-run check, rule trade-pay-check-v1 (20261115140000): every live trade invoice (not draft or ops-reject) in the p_weeks Monday pay weeks ending with the week of p_as_of (Perth today when null; 1 to 26 weeks, default 2), marked clean or stopped. Stops: not_in_xero, xero_bill_voided, xero_amount_differs (more than 5 cents from net_pay plus GST when gst_on, less the weekly deduction, plus office lines added in Xero), work_order_over_agreed (agreed-amount lines on one job work order across every live invoice above agreed_labour_ex), rate_above_office (hourly rate above the office rate on the day and not the booking rate; trades set their own rate, at or below the office rate passes), line_on_no_job, second_invoice_same_week. Notes never stop a bill: hours_over_expected, labour_over_agreed, day_not_booked, changed_in_xero. p_org_id scopes every read. Read only, writes nothing, never calls Xero. Service role only. Contract: docs/trade-pay-run-check-v1.md.';

REVOKE ALL ON FUNCTION public.trade_pay_run_check(date, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trade_pay_run_check(date, integer, uuid) TO service_role;
