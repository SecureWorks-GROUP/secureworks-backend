-- 2026-09-11 (CIO): a job billed as a Work Order or Commission line never
-- locked the trade's job card.
--
-- generate_trade_invoice stamped job_assignments.invoiced_in only for the
-- assignment ids carried by LABOUR lines. Work Order and Commission lines bill
-- the whole job, carry no assignment ids, and stamped nothing. my_hours hides a
-- card only when invoiced_in points at a live invoice, so the card stayed on the
-- trade's Pay tab under a week that was already billed and paid. The same job
-- could be billed a second time.
--
-- The case that surfaced it: trade Alyx, invoice SW-INV-A-260830-025 (week
-- 2026-08-24..30, PAID in Xero). Line 1 billed SWF-261063 as a Work Order. His
-- lead_installer card on SWF-261063 (scheduled 2026-08-24) kept invoiced_in NULL.
--
-- ops-api now folds those cards into the same Layer B stamp. This one-off pass
-- locks the backlog already sitting behind live invoices.
--
-- Rules, identical to the runtime stamp:
--   * only invoices that are LIVE (status not draft / failed / ops-reject);
--   * only lines with a job that bill the job: line_type 'work order',
--     'work_order' or 'commission', or a weekly work-order scope line
--     (source_work_order_id set) whose line_type is 'labour' or 'patio' — the
--     only two weeklyScopeLineType values that bill the crew's work. A weekly
--     'travel', 'materials' or 'other' scope line reimburses a cost and must
--     never consume a lead installer's day card, and the five deduction types
--     are excluded by not being on that list;
--   * only the invoice owner's own cards on that job (user_id matches);
--   * THE BILLED DATE WINDOW, per invoice and per job:
--       - weekly invoice (week_start and week_end set): week_start..week_end;
--       - non-week invoice: min(line_date)..max(line_date) across THAT job's
--         own job-level billing lines on THAT invoice, upper bound clamped to
--         the day the invoice was submitted (a card scheduled later is work not
--         yet done). A job whose billing lines carry no line_date gets no
--         window and locks NOTHING — guessing a range is what let a $200
--         commission line swallow a trade's unbilled day cards back to the
--         beginning of time;
--     in both cases a card with a NULL scheduled_date is never locked: it
--     cannot be shown to fall inside the window;
--   * only cards whose invoiced_in is still NULL. An existing stamp is never
--     overwritten;
--   * when two live invoices could claim the same card, the earliest submitted
--     one takes it.
-- One business_events row per stamped card. Re-running is harmless: the
-- invoiced_in IS NULL guard makes the second pass match nothing.

WITH billed_job AS (
  SELECT
    ti.id            AS invoice_id,
    ti.user_id,
    ti.invoice_number,
    ti.status        AS invoice_status,
    ti.week_start,
    ti.week_end,
    COALESCE(ti.submitted_at, ti.created_at, now())          AS submitted_at_eff,
    COALESCE(ti.submitted_at, ti.created_at, now())::date    AS submitted_on,
    l.job_id,
    min(l.line_date) AS window_from,
    max(l.line_date) AS window_to,
    (array_agg(lower(btrim(COALESCE(l.line_type, '')))
       ORDER BY l.line_date NULLS LAST, l.id))[1] AS line_type
  FROM public.trade_invoices ti
  JOIN public.trade_invoice_lines l
    ON l.trade_invoice_id = ti.id
  WHERE ti.status NOT IN ('draft', 'failed', 'ops-reject')
    AND l.job_id IS NOT NULL
    AND (
      lower(btrim(COALESCE(l.line_type, ''))) IN ('work order', 'work_order', 'commission')
      OR (
        l.source_work_order_id IS NOT NULL
        AND lower(btrim(COALESCE(l.line_type, ''))) IN ('labour', 'patio')
      )
    )
  GROUP BY ti.id, ti.user_id, ti.invoice_number, ti.status,
           ti.week_start, ti.week_end, ti.submitted_at, ti.created_at, l.job_id
),
candidate AS (
  SELECT DISTINCT ON (ja.id)
    ja.id AS assignment_id,
    ja.job_id,
    b.invoice_id,
    b.invoice_number,
    b.invoice_status,
    b.line_type
  FROM billed_job b
  JOIN public.job_assignments ja
    ON ja.job_id = b.job_id
   AND ja.user_id = b.user_id
  WHERE ja.invoiced_in IS NULL
    AND ja.scheduled_date IS NOT NULL
    AND (
      CASE
        WHEN b.week_start IS NOT NULL AND b.week_end IS NOT NULL
          THEN ja.scheduled_date BETWEEN b.week_start AND b.week_end
        ELSE b.window_from IS NOT NULL
          AND b.window_to IS NOT NULL
          AND ja.scheduled_date
              BETWEEN b.window_from AND LEAST(b.window_to, b.submitted_on)
      END
    )
  ORDER BY ja.id, b.submitted_at_eff ASC NULLS LAST, b.invoice_id
),
stamped AS (
  UPDATE public.job_assignments ja
  SET invoiced_in = c.invoice_id
  FROM candidate c
  WHERE ja.id = c.assignment_id
    AND ja.invoiced_in IS NULL
  RETURNING
    ja.id AS assignment_id,
    ja.job_id,
    ja.scheduled_date,
    c.invoice_id,
    c.invoice_number,
    c.invoice_status,
    c.line_type
)
INSERT INTO public.business_events (
  event_type, source, entity_type, entity_id, job_id, payload
)
SELECT
  'trade_invoice.assignment_lock_backfilled',
  'cio_trade_wo_backfill',
  'job_assignment',
  s.assignment_id::text,
  s.job_id,
  jsonb_build_object(
    'invoice_id', s.invoice_id,
    'invoice_number', s.invoice_number,
    'invoice_status', s.invoice_status,
    'line_type', s.line_type,
    'scheduled_date', s.scheduled_date,
    'backfill', true
  )
FROM stamped s;
