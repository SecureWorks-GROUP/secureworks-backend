-- TP-01 Xero tie-out (29 Oct 2026).
--
-- Ticket TP-01 (integrated framework 02-tickets.md; plan 08 §4 step 1 and
-- §5 check A): one read that sorts every supplier bill, spend-money and
-- supplier-credit dollar in Xero, by month, into on a job, a named non-job
-- bucket, or unplaced, and shows the unplaced dollars and their share.
--
-- xero_tieout_monthly(p_as_of, p_months) returns one jsonb document. Service
-- role only, read only, aggregates only (no bill, supplier or job is named).
--
-- What is read, and how each dollar is sorted (ex GST, per Xero bill):
--   * Bills: every ACCPAY in our copy of Xero (xero_invoices) whose status is
--     AUTHORISED or PAID, by invoice_date month, one row per xero_invoice_id
--     (the live copy first, as v_bill_allocation_balance reads it). Month
--     total = sum of round(sub_total, 2). DRAFT and SUBMITTED bills are not in
--     the total; their count and dollars are shown beside it.
--   * Trade-app mirror: a bill the trade app already counts as labour
--     (materials_ai_trade_mirror) goes whole to that named bucket.
--   * Allocation rows (job_materials_facts, kind actual) and a person's
--     overhead part (materials_reconciliation_queue.overhead_ex) decide a bill
--     that has either. A row on a holding job (jobs.metadata do_not_schedule)
--     is never on a job: it is unplaced, reason holding_job.
--   * A bill with neither: Bills to place status not_job_related goes whole
--     to overhead / not job related; otherwise a bill whose Xero job link is a
--     real job is on that job (the job profit engine reads it the same way);
--     everything else is unplaced.
--   * JP-12, as v_bill_allocation_balance: an installer bill (306/301) whose
--     job dollars neither a person nor the AI bill reader placed, and with no
--     overhead part, is not on a job yet: unplaced, reason
--     installer_awaiting_confirmation.
--   * Rows that add up to more than the bill never make on-job dollars exceed
--     the bill: the excess is shown as over_allocated, outside the total, so
--     on_job + non_job + unplaced = the month's bill total to the cent.
--
-- Not yet read, shown as not_yet_read with a null amount, never as $0:
--   * Supplier credit notes (ACCPAYCREDIT): not copied from Xero (TP-07).
--   * Spend money and card spend: not in the bill intake (TP-08). The bank copy
--     (xero_bank_transactions) holds only reconciled transactions from a
--     rolling 90-day window and mixes supplier prepayments and overpayments
--     into SPEND, so its sums are shown as a partial look, never counted.
--   * Stock and vehicles: no bill is marked either in our records yet, so both
--     named buckets are null (not_yet_separated). A person's "not job related"
--     filing sits in overhead.
-- So the tie-out total today covers bills only, and says so (covers).
--
-- Shares: unplaced share = unplaced / bills total, rounded UP to 4 places so
-- the gap is never understated; null when the total is 0.
-- last_6_months: the six calendar months ending with p_as_of's month.
--
-- Never writes. Rollback: supabase/rollbacks/20261029120000_xero_tieout_monthly_down.sql
-- Contract: supabase/tests/migration-contracts/20261029120000_xero_tieout_monthly/

CREATE OR REPLACE FUNCTION public.xero_tieout_monthly(p_as_of date DEFAULT NULL, p_months integer DEFAULT 12)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH win AS (
    SELECT a.as_of,
           m.months,
           (date_trunc('month', a.as_of) - make_interval(months => m.months - 1))::date AS from_month,
           (date_trunc('month', a.as_of) + interval '1 month')::date AS to_excl,
           (date_trunc('month', a.as_of) - interval '5 months')::date AS six_from
      FROM (SELECT COALESCE(p_as_of, (now() AT TIME ZONE 'Australia/Perth')::date) AS as_of) a,
           (SELECT GREATEST(1, LEAST(COALESCE(p_months, 12), 120)) AS months) m
  ),
  bills AS (
    SELECT DISTINCT ON (x.xero_invoice_id)
           x.xero_invoice_id, x.status, x.invoice_date, x.job_id, x.line_items,
           round(x.sub_total, 2) AS bill_ex, round(x.total, 2) AS bill_inc
      FROM public.xero_invoices x
     WHERE x.invoice_type = 'ACCPAY'
       AND x.xero_invoice_id IS NOT NULL
     ORDER BY x.xero_invoice_id, (x.status IN ('AUTHORISED', 'PAID')) DESC
  ),
  alloc AS (
    SELECT f.xero_invoice_id,
           count(*) AS n,
           sum(f.amount_ex_gst) FILTER (WHERE NOT f.hold) AS job_rows_ex,
           sum(f.amount_ex_gst) FILTER (WHERE f.hold) AS hold_rows_ex,
           bool_or(f.automation_source IN ('manual_queue', 'manual_split', 'agent_ai')) AS person_placed
      FROM (SELECT f.xero_invoice_id, f.amount_ex_gst, f.automation_source,
                   lower(COALESCE(j.metadata ->> 'do_not_schedule', '')) = 'true' AS hold
              FROM public.job_materials_facts f
              LEFT JOIN public.jobs j ON j.id = f.job_id
             WHERE f.kind = 'actual') f
     GROUP BY f.xero_invoice_id
  ),
  b1 AS (
    SELECT b.xero_invoice_id, b.invoice_date, b.bill_ex, b.bill_inc,
           date_trunc('month', b.invoice_date)::date AS month,
           public.materials_ai_trade_mirror(b.xero_invoice_id, b.line_items) AS mirror,
           public.job_cost_installer_bill(b.line_items) AS installer,
           q.status AS queue_status,
           round(GREATEST(COALESCE(q.overhead_ex, 0), 0), 2) AS overhead_part,
           COALESCE(a.n, 0) AS row_count,
           round(COALESCE(a.job_rows_ex, 0), 2) AS job_rows_ex,
           round(COALESCE(a.hold_rows_ex, 0), 2) AS hold_rows_ex,
           COALESCE(a.person_placed, false) AS person_placed,
           CASE WHEN b.job_id IS NULL THEN 'none'
                WHEN xj.id IS NULL THEN 'unknown_job'
                WHEN lower(COALESCE(xj.metadata ->> 'do_not_schedule', '')) = 'true' THEN 'holding'
                ELSE 'job' END AS xero_link
      FROM bills b
      LEFT JOIN alloc a ON a.xero_invoice_id = b.xero_invoice_id
      LEFT JOIN public.materials_reconciliation_queue q ON q.xero_invoice_id = b.xero_invoice_id
      LEFT JOIN public.jobs xj ON xj.id = b.job_id
     CROSS JOIN win
     WHERE b.status IN ('AUTHORISED', 'PAID')
       -- Only the months read (and undated bills, so none is silently dropped).
       AND (b.invoice_date IS NULL
            OR (b.invoice_date >= LEAST(win.from_month, win.six_from) AND b.invoice_date < win.to_excl))
  ),
  b2 AS (
    SELECT b1.*,
           (row_count > 0 OR overhead_part > 0) AS by_rows,
           -- JP-12: a machine's installer placement is not on a job yet.
           (installer AND NOT person_placed AND overhead_part = 0) AS installer_gate
      FROM b1
  ),
  b3 AS (
    SELECT b2.*,
           CASE WHEN mirror OR bill_ex IS NULL OR bill_ex <= 0 THEN 0
                WHEN by_rows THEN LEAST(overhead_part, bill_ex)
                WHEN queue_status = 'not_job_related' THEN bill_ex
                ELSE 0 END AS overhead_ex,
           CASE WHEN mirror OR bill_ex IS NULL OR bill_ex <= 0 THEN 0
                WHEN by_rows THEN CASE WHEN installer_gate THEN 0 ELSE job_rows_ex END
                WHEN queue_status = 'not_job_related' THEN 0
                WHEN xero_link = 'job' AND NOT installer_gate THEN bill_ex
                ELSE 0 END AS job_basis
      FROM b2
  ),
  b4 AS (
    SELECT b3.*,
           CASE WHEN mirror AND bill_ex IS NOT NULL THEN bill_ex ELSE 0 END AS mirror_ex,
           LEAST(GREATEST(job_basis, 0), GREATEST(COALESCE(bill_ex, 0) - overhead_ex, 0)) AS on_job_ex,
           GREATEST(job_basis - GREATEST(COALESCE(bill_ex, 0) - overhead_ex, 0), 0) AS over_ex
      FROM b3
  ),
  placed AS (
    SELECT b4.*,
           CASE WHEN mirror OR bill_ex IS NULL THEN 0
                ELSE bill_ex - overhead_ex - on_job_ex END AS unplaced_ex
      FROM b4
  ),
  sorted AS (
    SELECT p.*,
           CASE WHEN p.unplaced_ex = 0 THEN NULL
                WHEN p.bill_ex < 0 THEN 'negative_bill'
                WHEN p.installer_gate AND (p.job_rows_ex > 0 OR (NOT p.by_rows AND p.xero_link = 'job')) THEN 'installer_awaiting_confirmation'
                WHEN p.hold_rows_ex > 0 OR (NOT p.by_rows AND p.xero_link = 'holding') THEN 'holding_job'
                WHEN p.queue_status = 'open' THEN 'waiting_in_bills_to_place'
                WHEN p.queue_status IS NULL AND NOT p.by_rows THEN 'not_in_intake'
                ELSE 'rows_short_of_bill' END AS unplaced_reason
      FROM placed p
  ),
  months AS (
    SELECT g::date AS month
      FROM win, generate_series(win.from_month::timestamp, (win.to_excl - 1)::timestamp, interval '1 month') g
  ),
  not_counted AS (
    SELECT date_trunc('month', b.invoice_date)::date AS month, count(*) AS n, sum(b.bill_ex) AS ex
      FROM bills b
     WHERE b.status IN ('DRAFT', 'SUBMITTED')
     GROUP BY 1
  ),
  spend AS (
    SELECT date_trunc('month', t.txn_date)::date AS month,
           count(*) AS n,
           CASE WHEN bool_and(t.sub_total IS NOT NULL) THEN sum(abs(t.sub_total)) END AS ex
      FROM public.xero_bank_transactions t
     WHERE t.txn_type = 'SPEND'
       AND upper(COALESCE(t.status, '')) NOT IN ('DELETED', 'VOIDED')
     GROUP BY 1
  ),
  month_rows AS (
    SELECT m.month,
           count(s.xero_invoice_id) AS bills,
           COALESCE(sum(s.bill_ex), 0) AS total_ex,
           COALESCE(sum(s.bill_inc), 0) AS total_inc,
           count(s.xero_invoice_id) FILTER (WHERE s.bill_ex IS NULL) AS amount_unknown,
           COALESCE(sum(s.on_job_ex), 0) AS on_job_ex,
           COALESCE(sum(s.overhead_ex), 0) AS overhead_ex,
           COALESCE(sum(s.mirror_ex), 0) AS mirror_ex,
           COALESCE(sum(s.unplaced_ex), 0) AS unplaced_ex,
           COALESCE(sum(s.over_ex), 0) AS over_ex,
           count(s.xero_invoice_id) FILTER (WHERE s.over_ex > 0) AS over_bills,
           COALESCE(sum(s.unplaced_ex) FILTER (WHERE s.unplaced_reason = 'waiting_in_bills_to_place'), 0) AS r_waiting,
           COALESCE(sum(s.unplaced_ex) FILTER (WHERE s.unplaced_reason = 'holding_job'), 0) AS r_holding,
           COALESCE(sum(s.unplaced_ex) FILTER (WHERE s.unplaced_reason = 'installer_awaiting_confirmation'), 0) AS r_installer,
           COALESCE(sum(s.unplaced_ex) FILTER (WHERE s.unplaced_reason = 'not_in_intake'), 0) AS r_not_in_intake,
           COALESCE(sum(s.unplaced_ex) FILTER (WHERE s.unplaced_reason = 'rows_short_of_bill'), 0) AS r_short,
           COALESCE(sum(s.unplaced_ex) FILTER (WHERE s.unplaced_reason = 'negative_bill'), 0) AS r_negative
      FROM months m
      LEFT JOIN sorted s ON s.month = m.month
     GROUP BY m.month
  ),
  six AS (
    SELECT COALESCE(sum(s.bill_ex), 0) AS total_ex, COALESCE(sum(s.unplaced_ex), 0) AS unplaced_ex
      FROM sorted s, win
     WHERE s.invoice_date >= win.six_from AND s.invoice_date < win.to_excl
  )
  SELECT jsonb_build_object(
    'as_of', win.as_of,
    'months_shown', win.months,
    'from_month', win.from_month,
    'basis', 'ex GST, to the cent; supplier bills (ACCPAY) AUTHORISED or PAID in our copy of Xero, by invoice date',
    'covers', 'bills only',
    'complete', false,
    'copy_synced_at', (SELECT max(x.synced_at) FROM public.xero_invoices x WHERE x.invoice_type = 'ACCPAY'),
    'not_yet_read', jsonb_build_array(
      jsonb_build_object('part', 'supplier_credit_notes', 'ticket', 'TP-07',
        'why', 'Supplier credit notes (ACCPAYCREDIT) are not copied from Xero yet.'),
      jsonb_build_object('part', 'spend_money', 'ticket', 'TP-08',
        'why', 'Spend money and card spend are not in the bill intake yet. The bank copy holds only reconciled transactions from the last 90 days, so it is shown as a partial look and not counted.'),
      jsonb_build_object('part', 'stock_and_vehicles', 'ticket', 'TP-01',
        'why', 'No bill is marked stock or vehicle in our records yet. A bill a person filed as not job related is in overhead.')),
    'last_6_months', jsonb_build_object(
      'from', win.six_from,
      'to', (win.to_excl - 1),
      'bills_total_ex', six.total_ex,
      'unplaced_ex', six.unplaced_ex,
      'unplaced_share_of_bills', CASE WHEN six.total_ex > 0 THEN (ceil(six.unplaced_ex / six.total_ex * 10000) / 10000)::numeric(8,4) END,
      'accounted_share_of_bills', CASE WHEN six.total_ex > 0 THEN (1 - ceil(six.unplaced_ex / six.total_ex * 10000) / 10000)::numeric(8,4) END),
    'undated_bills', (SELECT jsonb_build_object('count', count(*), 'ex', COALESCE(sum(s.bill_ex), 0))
                        FROM sorted s WHERE s.invoice_date IS NULL),
    'months', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'month', to_char(r.month, 'YYYY-MM'),
        'tie_out_total_ex', r.total_ex,
        'covers', 'bills only',
        'bills', jsonb_build_object(
          'count', r.bills,
          'total_ex', r.total_ex,
          'total_inc', r.total_inc,
          'amount_unknown_count', r.amount_unknown,
          'on_job_ex', r.on_job_ex,
          'non_job', jsonb_build_object(
            'overhead_not_job_related_ex', r.overhead_ex,
            'trade_app_mirror_ex', r.mirror_ex,
            'stock_ex', NULL,
            'vehicles_ex', NULL,
            'stock_and_vehicles', 'not_yet_separated'),
          'non_job_ex', r.overhead_ex + r.mirror_ex,
          'unplaced_ex', r.unplaced_ex,
          'unplaced_share', CASE WHEN r.total_ex > 0 THEN (ceil(r.unplaced_ex / r.total_ex * 10000) / 10000)::numeric(8,4) END,
          'unplaced_by_reason', jsonb_build_object(
            'waiting_in_bills_to_place', r.r_waiting,
            'holding_job', r.r_holding,
            'installer_awaiting_confirmation', r.r_installer,
            'not_in_intake', r.r_not_in_intake,
            'rows_short_of_bill', r.r_short,
            'negative_bill', r.r_negative),
          'over_allocated', jsonb_build_object('bills', r.over_bills, 'ex', r.over_ex),
          'parts_add_up', (r.on_job_ex + r.overhead_ex + r.mirror_ex + r.unplaced_ex = r.total_ex)),
        'not_counted', jsonb_build_object(
          'draft_or_submitted_bills', COALESCE(nc.n, 0),
          'draft_or_submitted_ex', COALESCE(nc.ex, 0)),
        'spend', jsonb_build_object(
          'status', 'not_yet_read',
          'ticket', 'TP-08',
          'amount_ex', NULL,
          'counted', false,
          'bank_copy_partial', jsonb_build_object(
            'rows', COALESCE(sp.n, 0),
            'ex', sp.ex,
            'note', 'Reconciled spend in the rolling 90-day bank copy only; includes supplier prepayments and overpayments; not placed; not counted.')),
        'credit_notes', jsonb_build_object(
          'status', 'not_yet_read',
          'ticket', 'TP-07',
          'amount_ex', NULL,
          'counted', false)
      ) ORDER BY r.month DESC), '[]'::jsonb)
      FROM month_rows r
      LEFT JOIN not_counted nc ON nc.month = r.month
      LEFT JOIN spend sp ON sp.month = r.month)
  )
  FROM win, six
$$;

COMMENT ON FUNCTION public.xero_tieout_monthly(date, integer) IS
  'TP-01 Xero tie-out (20261029120000): by month, every AUTHORISED or PAID supplier bill dollar (ex GST) in our copy of Xero sorted into on a job, a named non-job bucket (overhead / not job related, trade-app mirror; stock and vehicles not yet separated) or unplaced, with the unplaced share (rounded up) and the last 6 months. on_job + non_job + unplaced = the month''s bill total to the cent. Supplier credit notes (TP-07) and spend money (TP-08) are not_yet_read with null amounts, never $0. Read only, aggregates only, service role only.';
REVOKE ALL ON FUNCTION public.xero_tieout_monthly(date, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.xero_tieout_monthly(date, integer) TO service_role;
