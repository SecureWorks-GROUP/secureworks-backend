-- TP-01 Xero tie-out (29 Oct 2026).
--
-- Ticket TP-01 (integrated framework 02-tickets.md; plan 08 §4 step 1 and
-- §5 check A): one read that sorts every supplier bill, spend-money and
-- supplier-credit dollar in Xero, by month, into on a job, a named non-job
-- bucket, or unplaced, and shows the unplaced dollars and their share.
--
-- xero_tieout_monthly(p_as_of, p_months, p_org_id) returns one jsonb
-- document. Service role only, read only, aggregates only (no bill, supplier or
-- job is named).
--
-- Org: with p_org_id, every read (bills, allocation rows, Bills to place, the
-- bank copy, the copy time) is that org's only. With p_org_id null, every org
-- is read and a bill is one (org_id, xero_invoice_id); its rows and its Bills
-- to place row are joined on the same org. The ops-api door always passes the
-- caller's org. An allocation row with no org is read as its bill's org.
--
-- as_of picks the months shown and nothing else. Allocation rows, Bills to
-- place states, overhead parts and holding-job marks are read as they are
-- today, and bills as our copy of Xero holds them today (copy_synced_at), so
-- an old month re-read later can move as bills are placed. The answer says so
-- (as_of_reads).
--
-- What is read, and how each dollar is sorted (ex GST, per Xero bill):
--   * Bills: every ACCPAY in our copy of Xero (xero_invoices) whose status is
--     AUTHORISED or PAID, by invoice_date month, one row per (org_id,
--     xero_invoice_id) (the live copy first, as v_bill_allocation_balance reads
--     it). Month total = sum of round(sub_total, 2) over bills of 0 or more.
--     DRAFT and SUBMITTED bills are not in the total; their count and dollars
--     are shown beside it.
--   * A bill below 0 is never in the total, on a job, unplaced or the share:
--     it is shown only under negative_bill, with its count and dollars.
--   * Trade-app labour: a bill the trade app already counts as labour on jobs
--     (materials_ai_trade_mirror) goes whole to trade_app_labour_ex, kept apart
--     from on_job_ex so it is never counted twice, and is not a non-job bucket.
--   * Allocation rows (job_materials_facts, kind actual) and a person's
--     overhead part (materials_reconciliation_queue.overhead_ex) decide a bill
--     that has either. A row on a holding job (jobs.metadata do_not_schedule
--     'true' or '1', as the context layer reads it) is never on a job: it is
--     unplaced, reason holding_job.
--   * A bill with neither: Bills to place status not_job_related goes whole
--     to overhead / not job related; otherwise a bill whose Xero job link is a
--     real job is on that job (the job profit engine reads it the same way);
--     everything else is unplaced.
--   * JP-12, as v_bill_allocation_balance: an installer bill (306/301) whose
--     job dollars neither a person nor the AI bill reader placed, and with no
--     overhead part, is not on a job yet: unplaced, reason
--     installer_awaiting_confirmation.
--   * Within a bill, overhead is placed first, then job rows, each capped at
--     what is left of the bill; the rest is unplaced. over_allocated is, per
--     bill of 0 or more, job rows + holding-job rows + overhead part - bill,
--     when above 0: rows bigger than the bill, rows on a 0 bill and an overhead
--     part bigger than the bill all show there. It is outside the total.
--   * parts_add_up compares on_job + trade_app_labour + overhead + unplaced
--     against the month's bills read directly from the copy (not through the
--     allocation, Bills to place or job joins). Unplaced is each bill's
--     remainder, so this check catches a bill dropped or counted twice by a
--     join, not a mis-sorted dollar.
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
-- the gap is never understated; null when the total is 0; never below 0.
-- last_6_months: the six calendar months ending with p_as_of's month.
--
-- Never writes. Rollback: supabase/rollbacks/20261029120000_xero_tieout_monthly_down.sql
-- Contract: supabase/tests/migration-contracts/20261029120000_xero_tieout_monthly/

CREATE OR REPLACE FUNCTION public.xero_tieout_monthly(p_as_of date DEFAULT NULL, p_months integer DEFAULT 12, p_org_id uuid DEFAULT NULL)
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
    SELECT DISTINCT ON (x.org_id, x.xero_invoice_id)
           x.org_id, x.xero_invoice_id, x.status, x.invoice_date, x.job_id, x.line_items,
           round(x.sub_total, 2) AS bill_ex, round(x.total, 2) AS bill_inc
      FROM public.xero_invoices x
     WHERE x.invoice_type = 'ACCPAY'
       AND x.xero_invoice_id IS NOT NULL
       AND (p_org_id IS NULL OR x.org_id = p_org_id)
     ORDER BY x.org_id, x.xero_invoice_id, (x.status IN ('AUTHORISED', 'PAID')) DESC
  ),
  b1 AS (
    SELECT b.org_id, b.xero_invoice_id, b.invoice_date, b.bill_ex, b.bill_inc,
           date_trunc('month', b.invoice_date)::date AS month,
           -- In the total: a bill of 0 or more. Below 0: negative_bill only.
           (b.bill_ex IS NOT NULL AND b.bill_ex >= 0) AS counted,
           (b.bill_ex IS NOT NULL AND b.bill_ex < 0) AS negative,
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
                WHEN COALESCE(xj.metadata ->> 'do_not_schedule', '') IN ('true', '1') THEN 'holding'
                ELSE 'job' END AS xero_link
      FROM bills b
      -- The bill's allocation rows, summed per bill (so no bill is counted
      -- twice). A row with no org is read as its bill's org.
      LEFT JOIN LATERAL (
        SELECT count(*) AS n,
               sum(f.amount_ex_gst) FILTER (WHERE NOT f.hold) AS job_rows_ex,
               sum(f.amount_ex_gst) FILTER (WHERE f.hold) AS hold_rows_ex,
               bool_or(f.automation_source IN ('manual_queue', 'manual_split', 'agent_ai')) AS person_placed
          FROM (SELECT f.amount_ex_gst, f.automation_source,
                       COALESCE(j.metadata ->> 'do_not_schedule', '') IN ('true', '1') AS hold
                  FROM public.job_materials_facts f
                  LEFT JOIN public.jobs j ON j.id = f.job_id
                 WHERE f.kind = 'actual'
                   AND f.xero_invoice_id = b.xero_invoice_id
                   AND COALESCE(f.org_id, b.org_id) = b.org_id) f
      ) a ON true
      LEFT JOIN public.materials_reconciliation_queue q ON q.org_id = b.org_id AND q.xero_invoice_id = b.xero_invoice_id
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
           -- Overhead first, capped at the bill.
           CASE WHEN NOT counted OR mirror THEN 0
                WHEN by_rows THEN LEAST(overhead_part, bill_ex)
                WHEN queue_status = 'not_job_related' THEN bill_ex
                ELSE 0 END AS overhead_ex,
           CASE WHEN NOT counted OR mirror THEN 0
                WHEN by_rows THEN CASE WHEN installer_gate THEN 0 ELSE GREATEST(job_rows_ex, 0) END
                WHEN queue_status = 'not_job_related' THEN 0
                WHEN xero_link = 'job' AND NOT installer_gate THEN bill_ex
                ELSE 0 END AS job_basis,
           -- Everything the rows and the overhead part claim, above the bill.
           CASE WHEN counted AND NOT mirror AND by_rows
                THEN GREATEST(job_rows_ex + hold_rows_ex + overhead_part - bill_ex, 0)
                ELSE 0 END AS over_ex
      FROM b2
  ),
  b4 AS (
    SELECT b3.*,
           CASE WHEN counted AND mirror THEN bill_ex ELSE 0 END AS mirror_ex,
           -- Job rows next, capped at what overhead left of the bill.
           LEAST(job_basis, CASE WHEN counted THEN bill_ex - overhead_ex ELSE 0 END) AS on_job_ex
      FROM b3
  ),
  placed AS (
    SELECT b4.*,
           CASE WHEN NOT counted OR mirror THEN 0
                ELSE bill_ex - overhead_ex - on_job_ex END AS unplaced_ex
      FROM b4
  ),
  sorted AS (
    SELECT p.*,
           CASE WHEN p.unplaced_ex = 0 THEN NULL
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
  -- The month's bills read straight from the copy, not through any join, for
  -- parts_add_up.
  direct AS (
    SELECT date_trunc('month', b.invoice_date)::date AS month, sum(b.bill_ex) AS ex
      FROM bills b
     WHERE b.status IN ('AUTHORISED', 'PAID') AND b.bill_ex >= 0
     GROUP BY 1
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
       AND (p_org_id IS NULL OR t.org_id = p_org_id)
     GROUP BY 1
  ),
  month_rows AS (
    SELECT m.month,
           count(s.xero_invoice_id) FILTER (WHERE s.counted OR s.bill_ex IS NULL) AS bills,
           COALESCE(sum(s.bill_ex) FILTER (WHERE s.counted), 0) AS total_ex,
           COALESCE(sum(s.bill_inc) FILTER (WHERE s.counted), 0) AS total_inc,
           count(s.xero_invoice_id) FILTER (WHERE s.bill_ex IS NULL) AS amount_unknown,
           COALESCE(sum(s.on_job_ex), 0) AS on_job_ex,
           COALESCE(sum(s.overhead_ex), 0) AS overhead_ex,
           COALESCE(sum(s.mirror_ex), 0) AS mirror_ex,
           COALESCE(sum(s.unplaced_ex), 0) AS unplaced_ex,
           COALESCE(sum(s.over_ex), 0) AS over_ex,
           count(s.xero_invoice_id) FILTER (WHERE s.over_ex > 0) AS over_bills,
           count(s.xero_invoice_id) FILTER (WHERE s.negative) AS neg_bills,
           COALESCE(sum(s.bill_ex) FILTER (WHERE s.negative), 0) AS neg_ex,
           COALESCE(sum(s.bill_inc) FILTER (WHERE s.negative), 0) AS neg_inc,
           COALESCE(sum(s.unplaced_ex) FILTER (WHERE s.unplaced_reason = 'waiting_in_bills_to_place'), 0) AS r_waiting,
           COALESCE(sum(s.unplaced_ex) FILTER (WHERE s.unplaced_reason = 'holding_job'), 0) AS r_holding,
           COALESCE(sum(s.unplaced_ex) FILTER (WHERE s.unplaced_reason = 'installer_awaiting_confirmation'), 0) AS r_installer,
           COALESCE(sum(s.unplaced_ex) FILTER (WHERE s.unplaced_reason = 'not_in_intake'), 0) AS r_not_in_intake,
           COALESCE(sum(s.unplaced_ex) FILTER (WHERE s.unplaced_reason = 'rows_short_of_bill'), 0) AS r_short
      FROM months m
      LEFT JOIN sorted s ON s.month = m.month
     GROUP BY m.month
  ),
  six AS (
    SELECT COALESCE(sum(s.bill_ex) FILTER (WHERE s.counted), 0) AS total_ex,
           COALESCE(sum(s.unplaced_ex), 0) AS unplaced_ex
      FROM sorted s, win
     WHERE s.invoice_date >= win.six_from AND s.invoice_date < win.to_excl
  )
  SELECT jsonb_build_object(
    'as_of', win.as_of,
    'as_of_reads', 'as_of picks the months shown and nothing else. Allocation rows, Bills to place states, overhead parts and holding-job marks are read as they are today, and bills as our copy of Xero holds them today (copy_synced_at).',
    'org_id', p_org_id,
    'months_shown', win.months,
    'from_month', win.from_month,
    'basis', 'ex GST, to the cent; supplier bills (ACCPAY) AUTHORISED or PAID in our copy of Xero, by invoice date; a bill below 0 is shown only as negative_bill',
    'covers', 'bills only',
    'complete', false,
    'copy_synced_at', (SELECT max(x.synced_at) FROM public.xero_invoices x
                        WHERE x.invoice_type = 'ACCPAY' AND (p_org_id IS NULL OR x.org_id = p_org_id)),
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
    'undated_bills', (SELECT jsonb_build_object('count', count(*) FILTER (WHERE NOT s.negative),
                                                'ex', COALESCE(sum(s.bill_ex) FILTER (WHERE s.counted), 0),
                                                'negative_bills', count(*) FILTER (WHERE s.negative))
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
          'trade_app_labour_ex', r.mirror_ex,
          'non_job', jsonb_build_object(
            'overhead_not_job_related_ex', r.overhead_ex,
            'stock_ex', NULL,
            'vehicles_ex', NULL,
            'stock_and_vehicles', 'not_yet_separated'),
          'unplaced_ex', r.unplaced_ex,
          'unplaced_share', CASE WHEN r.total_ex > 0 THEN (ceil(r.unplaced_ex / r.total_ex * 10000) / 10000)::numeric(8,4) END,
          'unplaced_by_reason', jsonb_build_object(
            'waiting_in_bills_to_place', r.r_waiting,
            'holding_job', r.r_holding,
            'installer_awaiting_confirmation', r.r_installer,
            'not_in_intake', r.r_not_in_intake,
            'rows_short_of_bill', r.r_short),
          'over_allocated', jsonb_build_object('bills', r.over_bills, 'ex', r.over_ex, 'counted', false),
          'negative_bill', jsonb_build_object('bills', r.neg_bills, 'ex', r.neg_ex, 'inc', r.neg_inc, 'counted', false),
          'parts_add_up', (r.on_job_ex + r.mirror_ex + r.overhead_ex + r.unplaced_ex = COALESCE(d.ex, 0)),
          'parts_check', 'on_job + trade_app_labour + overhead + unplaced against the bills read directly from the copy; unplaced is each bill''s remainder, so this catches a bill dropped or counted twice, not a mis-sorted dollar'),
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
      LEFT JOIN direct d ON d.month = r.month
      LEFT JOIN not_counted nc ON nc.month = r.month
      LEFT JOIN spend sp ON sp.month = r.month)
  )
  FROM win, six
$$;

COMMENT ON FUNCTION public.xero_tieout_monthly(date, integer, uuid) IS
  'TP-01 Xero tie-out (20261029120000): by month, every AUTHORISED or PAID supplier bill dollar of 0 or more (ex GST) in our copy of Xero sorted into on a job, trade-app labour (already counted on jobs by the trade app), overhead / not job related (stock and vehicles not yet separated) or unplaced, with the unplaced share (rounded up, never below 0) and the last 6 months. A bill below 0 is shown only as negative_bill; rows and overhead parts above a bill are shown as over_allocated; neither is in the total. parts_add_up checks the buckets against the bills read directly. p_org_id scopes every read to one org (null reads every org, a bill per org and Xero id). as_of picks the months only: allocations and Bills to place states are as of today. Supplier credit notes (TP-07) and spend money (TP-08) are not_yet_read with null amounts, never $0. Read only, aggregates only, service role only.';
REVOKE ALL ON FUNCTION public.xero_tieout_monthly(date, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.xero_tieout_monthly(date, integer, uuid) TO service_role;
