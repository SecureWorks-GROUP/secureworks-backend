-- (Job costing and Xero, 15 Nov 2026) The monthly tie to Xero reads Job Profit's own cost rows.
--
-- Found 15 Nov 2026 (job costing audit, read only on production): xero_tieout_monthly (TP-01, 20261029121500; TP-07
-- 20261030060000) sorts each supplier bill with its own copy of the placement rule: the bill's job_materials_facts
-- rows, else the bill's Xero job link. Job Profit moved on after it was written. Since 20261102130000 a bill line
-- with no job goes to the job bookkeeping's line evidence names, and since 20261104063000 to a job number written
-- on the line; neither route is in the tie-out's copy. So the tie-out called dollars unplaced that Job Profit counts
-- on jobs: 41.35% of the last six months' bill dollars, where Job Profit's own rows leave 4.7% to 8.9% a month for
-- July to October 2026.
--
-- Change: one function, public.xero_tieout_monthly(date, integer, uuid). Nothing is written anywhere; the function
-- only reads.
--   * On a job: Job Profit's actual cost rows for the bill (v_job_cost_events, sources supplier_bill and
--     materials_fact) on a job that is not a holding job, summed with their signs, capped at the bill. The view is
--     read once. A cost row is read in the org of the job it sits on. Credit rows (supplier_credit) and employer
--     super worked out from a crew bill (bill_employer_super) are not bill dollars and are left out.
--   * Overhead / not job related, capped at what the job rows left of the bill: the greater of what a person filed
--     in Bills to place (the overhead part of a split, else a bill filed not job related whole) and the lines
--     bookkeeping's current evidence rules are no job's cost (evidenced, no job, allocation overhead or
--     not_job_cost). non_job.by_basis splits the figure between the two.
--   * Unplaced: the bill's remainder. Reasons, first that applies: Job Profit holds an installer placement nobody has
--     confirmed (JP-12); a row on the holding job, or no row and a Xero link to it; waiting in Bills to place; never
--     reached the intake (no queue row, no cost row, no evidence); else rows short of the bill.
--   * Order: before, overhead was taken first and job rows were capped at the rest. Now job rows are first, because
--     "on a job" must equal what Job Profit counts. A bill Job Profit counts on a job that was also filed not job
--     related shows in over_allocated, so the disagreement is visible.
--   * Trade-app labour: a bill that reads as a trade-app bill (materials_ai_trade_mirror) and has no Job Profit
--     cost row on a job. One that Job Profit does count on a job (the cost view lets bookkeeping's evidence or a
--     placement put such a bill on a job) is on a job here too. Rehearsal: 1 of 246 such bills since June 2026.
--   * Over allocated: job rows plus the greater of the holding-job rows and the not-a-job claim, above the bill.
--     The two are not added: a bill linked in Xero to the holding job has every line on it whatever bookkeeping
--     ruled, and adding them would report a bill ruled overhead as placed twice.
--   * A bill whose cost rows sit on another org's job is not on a job in its own org's figures (unplaced, rows
--     short of the bill). Production has one org; this is stated so it is not read as a promise.
--   * Negative bills, drafts, spend, the months, the six-month line, parts_add_up and the
--     whole credit note section (TP-07) are unchanged. Every key of the answer is kept; two are added (on_job_rule,
--     non_job.by_basis). ops-api xero_tieout passes the answer through and needs no change.
--
-- Guards: the function must be 20261030060000's (comment and body md5 e0d6ef30a46cd98dd8c5fc67b46ca1ef, read on
-- production 15 Nov 2026) or already this migration's; v_job_cost_events and v_bookkeeping_line_evidence_current must
-- carry the columns read. Re-running it is a no-op. This migration's comment does not start with
-- 'TP-01 Xero tie-out (20261029121500)', so 20261030060000 and its down refuse while this body is live.
-- Rollback: supabase/rollbacks/20261115100000_xero_tieout_job_profit_rule_down.sql (20261030060000's function, comment and grants, byte for byte).
--
-- Rehearsed 15 Nov 2026 as a plain read on production (the sorting below run as a query, nothing created; as_of
-- 2026-11-15, 6 months, every org), bills total ex GST / unplaced / share:
--   2026-06  149,125.84 /  87,692.96 / 58.80%      2026-09  218,614.95 / 10,290.65 /  4.71%
--   2026-07  168,568.87 /  15,064.16 /  8.94%      2026-10  224,053.75 / 13,435.25 /  6.00%
--   2026-08  211,342.36 /  12,650.88 /  5.99%      2026-11   80,499.37 / 18,679.62 / 23.20%
-- Every month's parts add up to its bills total, and each total equals the live function's. Over allocated: 19 bills,
-- 6,623.73, none in a total (read before the holding-job change above, which can only lower it).

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $guard$
DECLARE
  fn regprocedure := to_regprocedure('public.xero_tieout_monthly(date,integer,uuid)');
  cmt text;
  src_md5 text;
  missing text;
BEGIN
  IF fn IS NULL THEN
    RAISE EXCEPTION 'xero_tieout_job_profit_rule_preimage_mismatch: public.xero_tieout_monthly is missing (20261029121500 and 20261030060000 first)';
  END IF;
  cmt := COALESCE(obj_description(fn, 'pg_proc'), '');
  SELECT md5(p.prosrc) INTO src_md5 FROM pg_proc p WHERE p.oid = fn;
  IF cmt LIKE 'TP-01 Xero tie-out, Job Profit rule (20261115100000%' THEN
    RAISE NOTICE 'xero_tieout_monthly already has 20261115100000';
  ELSIF cmt NOT LIKE 'TP-01 Xero tie-out (20261029121500), supplier credit notes TP-07 (20261030060000)%'
        OR src_md5 <> 'e0d6ef30a46cd98dd8c5fc67b46ca1ef' THEN
    RAISE EXCEPTION 'xero_tieout_job_profit_rule_preimage_mismatch: public.xero_tieout_monthly is not 20261030060000''s (body md5 %)', src_md5;
  END IF;
  SELECT string_agg(w.rel || '.' || w.col, ', ' ORDER BY w.rel, w.col) INTO missing
    FROM (VALUES ('v_job_cost_events', 'job_id'), ('v_job_cost_events', 'document_id'), ('v_job_cost_events', 'source'),
                 ('v_job_cost_events', 'is_actual'), ('v_job_cost_events', 'amount_ex'),
                 ('v_bookkeeping_line_evidence_current', 'xero_invoice_id'), ('v_bookkeeping_line_evidence_current', 'amount_ex_gst'),
                 ('v_bookkeeping_line_evidence_current', 'allocation'), ('v_bookkeeping_line_evidence_current', 'job_id'),
                 ('v_bookkeeping_line_evidence_current', 'evidenced')) AS w(rel, col)
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns c
                      WHERE c.table_schema = 'public' AND c.table_name = w.rel AND c.column_name = w.col);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'xero_tieout_job_profit_rule_preimage_mismatch: columns the tie-out reads are missing: %', missing;
  END IF;
END
$guard$;

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
  -- Job Profit's own cost rows for supplier bills, read once and summed per
  -- bill (so no bill is counted twice). These are the rows v_job_profit adds
  -- up: every route that puts a bill line on a job is in here, so a new route
  -- reaches this page the day it reaches Job Profit. A bill's rows are read in
  -- the org of the job they sit on. Credit rows (supplier_credit) and employer
  -- super worked out from a crew bill (bill_employer_super) are not bill
  -- dollars and are left out.
  eng AS MATERIALIZED (
    SELECT j.org_id, e.document_id AS xero_invoice_id,
           count(*) AS n,
           count(*) FILTER (WHERE e.is_actual AND NOT j.hold) AS job_n,
           COALESCE(sum(e.amount_ex) FILTER (WHERE e.is_actual AND NOT j.hold), 0) AS job_ex,
           COALESCE(sum(e.amount_ex) FILTER (WHERE e.is_actual AND j.hold), 0) AS hold_ex,
           COALESCE(bool_or(NOT e.is_actual AND e.amount_ex > 0), false) AS unconfirmed
      FROM public.v_job_cost_events e
      JOIN (SELECT jj.id, jj.org_id,
                   lower(COALESCE(jj.metadata ->> 'do_not_schedule', '')) = 'true' AS hold
              FROM public.jobs jj) j ON j.id = e.job_id
     WHERE e.source IN ('supplier_bill', 'materials_fact', 'installer_bill_unconfirmed')
       AND e.document_id IS NOT NULL
       AND (p_org_id IS NULL OR j.org_id = p_org_id)
     GROUP BY j.org_id, e.document_id
  ),
  -- Bookkeeping's current line evidence, per bill: the lines it ruled are no
  -- job's cost (overhead, or not a job cost), summed with their signs.
  ev AS (
    SELECT v.xero_invoice_id,
           count(*) AS n,
           COALESCE(sum(v.amount_ex_gst) FILTER (WHERE v.job_id IS NULL AND v.allocation IN ('overhead', 'not_job_cost')), 0) AS nonjob_ex
      FROM public.v_bookkeeping_line_evidence_current v
     WHERE v.evidenced
     GROUP BY v.xero_invoice_id
  ),
  b1 AS (
    SELECT b.org_id, b.xero_invoice_id, b.invoice_date, b.bill_ex, b.bill_inc,
           date_trunc('month', b.invoice_date)::date AS month,
           -- In the total: a bill of 0 or more. Below 0: negative_bill only.
           (b.bill_ex IS NOT NULL AND b.bill_ex >= 0) AS counted,
           (b.bill_ex IS NOT NULL AND b.bill_ex < 0) AS negative,
           -- Trade-app labour only while Job Profit has no cost row of the bill
           -- on a job: a bill that reads as a trade-app bill but that Job
           -- Profit counts on a job (bookkeeping's evidence, a placement) is
           -- on a job here too.
           (public.materials_ai_trade_mirror(b.xero_invoice_id, b.line_items) AND COALESCE(g.job_n, 0) = 0) AS mirror,
           q.status AS queue_status,
           round(GREATEST(COALESCE(q.overhead_ex, 0), 0), 2) AS overhead_part,
           COALESCE(g.n, 0) AS row_count,
           round(COALESCE(g.job_ex, 0), 2) AS job_rows_ex,
           round(COALESCE(g.hold_ex, 0), 2) AS hold_rows_ex,
           COALESCE(g.unconfirmed, false) AS installer_unconfirmed,
           COALESCE(v.n, 0) AS evidence_count,
           round(GREATEST(COALESCE(v.nonjob_ex, 0), 0), 2) AS evidence_nonjob_ex,
           CASE WHEN b.job_id IS NULL THEN 'none'
                WHEN xj.id IS NULL THEN 'unknown_job'
                WHEN lower(COALESCE(xj.metadata ->> 'do_not_schedule', '')) = 'true' THEN 'holding'
                ELSE 'job' END AS xero_link
      FROM bills b
      LEFT JOIN eng g ON g.org_id = b.org_id AND g.xero_invoice_id = b.xero_invoice_id
      LEFT JOIN ev v ON v.xero_invoice_id = b.xero_invoice_id
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
           -- What a person filed in Bills to place as not a job's cost: the
           -- overhead part of a split, else a bill filed not job related whole.
           CASE WHEN NOT counted OR mirror THEN 0
                WHEN overhead_part > 0 THEN overhead_part
                WHEN queue_status = 'not_job_related' THEN bill_ex
                ELSE 0 END AS filed_claim_ex
      FROM b1
  ),
  b3 AS (
    SELECT b2.*,
           -- On a job first: what Job Profit counts, capped at the bill.
           CASE WHEN NOT counted OR mirror THEN 0
                ELSE LEAST(GREATEST(job_rows_ex, 0), bill_ex) END AS on_job_ex,
           -- The claim that the bill is no job's cost: the greater of what was
           -- filed in Bills to place and what bookkeeping's evidence rules, so a
           -- line both name is counted once.
           CASE WHEN NOT counted OR mirror THEN 0
                ELSE GREATEST(filed_claim_ex, evidence_nonjob_ex) END AS nonjob_claim_ex
      FROM b2
  ),
  b4 AS (
    SELECT b3.*,
           CASE WHEN counted AND mirror THEN bill_ex ELSE 0 END AS mirror_ex,
           -- Overhead next, capped at what the job rows left of the bill.
           LEAST(nonjob_claim_ex, CASE WHEN counted AND NOT mirror THEN bill_ex - on_job_ex ELSE 0 END) AS overhead_ex,
           -- What the job rows (summed with their signs) and the dollars said
           -- to be on no real job say, above the bill. Holding-job rows and the
           -- not-a-job claim both say "no real job" and can name the same
           -- lines (a bill linked in Xero to the holding job has every line on
           -- it, whatever bookkeeping ruled), so the greater of the two is
           -- taken, not their sum. A trade-app labour bill is read whole and
           -- has no job rows, so it is never over allocated.
           CASE WHEN counted AND NOT mirror
                THEN GREATEST(job_rows_ex + GREATEST(hold_rows_ex, nonjob_claim_ex) - bill_ex, 0)
                ELSE 0 END AS over_ex
      FROM b3
  ),
  placed AS (
    SELECT b4.*,
           LEAST(filed_claim_ex, overhead_ex) AS overhead_filed_ex,
           overhead_ex - LEAST(filed_claim_ex, overhead_ex) AS overhead_evidence_ex,
           CASE WHEN NOT counted OR mirror THEN 0
                ELSE bill_ex - overhead_ex - on_job_ex END AS unplaced_ex
      FROM b4
  ),
  sorted AS (
    SELECT p.*,
           CASE WHEN p.unplaced_ex = 0 THEN NULL
                -- JP-12: an installer placement nobody has confirmed is not on a job yet.
                WHEN p.installer_unconfirmed THEN 'installer_awaiting_confirmation'
                WHEN p.hold_rows_ex > 0 OR (p.row_count = 0 AND p.xero_link = 'holding') THEN 'holding_job'
                WHEN p.queue_status = 'open' THEN 'waiting_in_bills_to_place'
                WHEN p.queue_status IS NULL AND p.row_count = 0 AND p.evidence_count = 0 THEN 'not_in_intake'
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
           COALESCE(sum(s.overhead_filed_ex), 0) AS overhead_filed_ex,
           COALESCE(sum(s.overhead_evidence_ex), 0) AS overhead_evidence_ex,
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
  ),
  -- TP-01's document (20261029121500), its keys kept; the sorting is Job
  -- Profit's (20261115100000).
  tp01 AS (
  SELECT jsonb_build_object(
    'as_of', win.as_of,
    'as_of_reads', 'as_of picks the months shown and nothing else. Job Profit''s cost rows, Bills to place states, overhead parts, bookkeeping''s line evidence and holding-job marks are read as they are today, and bills as our copy of Xero holds them today (copy_synced_at).',
    'on_job_rule', 'on_job_ex is what Job Profit counts for the bill today: its actual cost rows for the bill (v_job_cost_events, sources supplier_bill and materials_fact) on a job that is not a holding job, summed with their signs and capped at the bill. A row Job Profit holds back (an installer placement nobody has confirmed) is not on a job.',
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
        'why', 'No bill is marked stock or vehicle in our records yet. A bill a person filed as not job related, or a line bookkeeping ruled is no job''s cost, is in overhead.')),
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
            'by_basis', jsonb_build_object(
              'filed_in_bills_to_place_ex', r.overhead_filed_ex,
              'bookkeeping_evidence_ex', r.overhead_evidence_ex),
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
          'over_allocated', jsonb_build_object('bills', r.over_bills, 'ex', r.over_ex, 'counted', false,
            'reads', 'Per bill of 0 or more that is not trade-app labour: Job Profit''s job rows + the greater of its holding-job rows and the not-a-job claim (itself the greater of Bills to place and bookkeeping''s evidence) - bill, when above 0. Rows are summed with their signs. Holding-job rows and the not-a-job claim can name the same lines, so they are not added. A trade-app labour bill is read whole, so it is never over allocated.'),
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
  ) AS doc
  FROM win, six
  ),
  -- TP-07 (20261030060000): the org's supplier credit notes, read only once
  -- xero-sync has finished a full read of them (supplier_credit_notes_full:
  -- <org>:<tenant>); with no org, once every org with a bill in the copy has.
  cn_orgs AS (
    SELECT DISTINCT x.org_id FROM public.xero_invoices x WHERE x.invoice_type = 'ACCPAY'
  ),
  cn_read AS (
    SELECT CASE
             WHEN p_org_id IS NOT NULL THEN
               (SELECT min(s.cursor_at) FROM public.xero_sync_state s
                 WHERE starts_with(s.key, 'supplier_credit_notes_full:' || p_org_id::text || ':') AND s.cursor_at IS NOT NULL)
             WHEN NOT EXISTS (SELECT 1 FROM cn_orgs o
                               WHERE NOT EXISTS (SELECT 1 FROM public.xero_sync_state s
                                                  WHERE starts_with(s.key, 'supplier_credit_notes_full:' || o.org_id::text || ':')
                                                    AND s.cursor_at IS NOT NULL))
               THEN (SELECT min(s.cursor_at) FROM public.xero_sync_state s
                      WHERE starts_with(s.key, 'supplier_credit_notes_full:') AND s.cursor_at IS NOT NULL)
           END AS read_at
  ),
  -- The notes of the months shown (by credit note date) and undated ones.
  cn_note AS (
    SELECT n.org_id, n.xero_credit_note_id, n.credit_note_date,
           date_trunc('month', n.credit_note_date)::date AS month,
           COALESCE(n.status IN ('AUTHORISED', 'PAID'), false) AS live,
           n.total, n.sub_total
      FROM public.xero_supplier_credit_notes n, win
     WHERE (p_org_id IS NULL OR n.org_id = p_org_id)
       AND (n.credit_note_date IS NULL OR (n.credit_note_date >= win.from_month AND n.credit_note_date < win.to_excl))
  ),
  -- Their parts as the placement view sorts them (one rule, read once).
  cn_rows AS (
    SELECT p.org_id, p.xero_credit_note_id, p.part_key, p.state, p.job_profit, p.amount, p.counted_ex
      FROM public.v_supplier_credit_placement p
     WHERE (p_org_id IS NULL OR p.org_id = p_org_id)
       AND EXISTS (SELECT 1 FROM cn_note n
                    WHERE n.live AND n.org_id = p.org_id AND n.xero_credit_note_id = p.xero_credit_note_id)
  ),
  -- One row per part (a placed allocation is one row per job there).
  cn_part AS (
    SELECT DISTINCT ON (r.org_id, r.xero_credit_note_id, r.part_key)
           r.org_id, r.xero_credit_note_id, r.part_key, r.state, r.job_profit, r.amount
      FROM cn_rows r
     ORDER BY r.org_id, r.xero_credit_note_id, r.part_key
  ),
  cn_on_job AS (
    SELECT r.org_id, r.xero_credit_note_id, sum(r.counted_ex) AS counted_ex
      FROM cn_rows r
     WHERE r.job_profit = 'counted_from_credit_note'
     GROUP BY r.org_id, r.xero_credit_note_id
  ),
  cn_per_note AS (
    SELECT n.org_id, n.xero_credit_note_id, n.month, n.total, n.sub_total,
           COALESCE(max(j.counted_ex), 0) AS counted_ex,
           COALESCE(sum(p.amount) FILTER (WHERE p.state <> 'allocation_deleted' AND p.amount IS NOT NULL), 0) AS parts_inc,
           count(p.part_key) FILTER (WHERE p.state IN ('remaining_unknown', 'allocations_not_read', 'amount_unknown')
                                        OR (p.state = 'cash_refund' AND p.amount IS NULL)) AS unknown_parts,
           COALESCE(sum(p.amount) FILTER (WHERE p.state = 'placed'), 0) AS placed_inc,
           COALESCE(sum(p.amount) FILTER (WHERE p.job_profit = 'counted_from_credit_note'), 0) AS from_note_inc,
           COALESCE(sum(p.amount) FILTER (WHERE p.job_profit = 'counted_by_bill'), 0) AS by_bill_inc,
           COALESCE(sum(p.amount) FILTER (WHERE p.job_profit = 'bill_amount_credited'), 0) AS amount_credited_inc,
           COALESCE(sum(p.amount) FILTER (WHERE p.job_profit = 'exceeds_bill'), 0) AS exceeds_inc,
           COALESCE(sum(p.amount) FILTER (WHERE p.state = 'bill_not_in_copy'), 0) AS np_not_in_copy,
           COALESCE(sum(p.amount) FILTER (WHERE p.state = 'bill_not_live'), 0) AS np_not_live,
           COALESCE(sum(p.amount) FILTER (WHERE p.state = 'bill_total_unknown'), 0) AS np_total_unknown,
           COALESCE(sum(p.amount) FILTER (WHERE p.state = 'crew_bill'), 0) AS np_crew,
           COALESCE(sum(p.amount) FILTER (WHERE p.state = 'bill_not_placed'), 0) AS np_not_placed,
           COALESCE(sum(p.amount) FILTER (WHERE p.state = 'amount_not_positive'), 0) AS np_not_positive,
           COALESCE(sum(p.amount) FILTER (WHERE p.state = 'unallocated'), 0) AS unallocated_inc,
           COALESCE(sum(p.amount) FILTER (WHERE p.state = 'cash_refund'), 0) AS refund_inc
      FROM cn_note n
      LEFT JOIN cn_part p ON p.org_id = n.org_id AND p.xero_credit_note_id = n.xero_credit_note_id
      LEFT JOIN cn_on_job j ON j.org_id = n.org_id AND j.xero_credit_note_id = n.xero_credit_note_id
     WHERE n.live
     GROUP BY n.org_id, n.xero_credit_note_id, n.month, n.total, n.sub_total
  ),
  cn_month AS (
    SELECT m.month,
           count(c.xero_credit_note_id) AS notes,
           count(c.xero_credit_note_id) FILTER (WHERE c.total IS NULL) AS amount_unknown,
           COALESCE(sum(c.total), 0) AS total_inc,
           COALESCE(sum(c.sub_total), 0) AS total_ex,
           COALESCE(sum(c.placed_inc), 0) AS placed_inc,
           COALESCE(sum(c.from_note_inc), 0) AS from_note_inc,
           COALESCE(sum(c.by_bill_inc), 0) AS by_bill_inc,
           COALESCE(sum(c.amount_credited_inc), 0) AS amount_credited_inc,
           COALESCE(sum(c.exceeds_inc), 0) AS exceeds_inc,
           COALESCE(sum(c.counted_ex), 0) AS counted_ex,
           COALESCE(sum(c.np_not_in_copy + c.np_not_live + c.np_total_unknown + c.np_crew + c.np_not_placed + c.np_not_positive), 0) AS not_placed_inc,
           COALESCE(sum(c.np_not_in_copy), 0) AS np_not_in_copy,
           COALESCE(sum(c.np_not_live), 0) AS np_not_live,
           COALESCE(sum(c.np_total_unknown), 0) AS np_total_unknown,
           COALESCE(sum(c.np_crew), 0) AS np_crew,
           COALESCE(sum(c.np_not_placed), 0) AS np_not_placed,
           COALESCE(sum(c.np_not_positive), 0) AS np_not_positive,
           COALESCE(sum(c.unallocated_inc), 0) AS unallocated_inc,
           COALESCE(sum(c.refund_inc), 0) AS refund_inc,
           COALESCE(sum(c.unknown_parts), 0) AS unknown_parts,
           count(c.xero_credit_note_id) FILTER (WHERE c.total IS NULL OR c.unknown_parts > 0) AS unknown_notes,
           COALESCE(sum(c.total - c.parts_inc) FILTER (WHERE c.total IS NOT NULL AND c.unknown_parts = 0), 0) AS not_accounted_inc,
           CASE
             WHEN bool_or(c.total IS NOT NULL AND c.unknown_parts = 0 AND c.total <> c.parts_inc) THEN false
             WHEN bool_or(c.total IS NULL OR c.unknown_parts > 0) THEN NULL
             ELSE true
           END AS parts_add_up,
           (SELECT count(*) FROM cn_note x WHERE NOT x.live AND x.month = m.month) AS not_live_notes,
           (SELECT COALESCE(sum(x.total), 0) FROM cn_note x WHERE NOT x.live AND x.month = m.month) AS not_live_inc
      FROM months m
      LEFT JOIN cn_per_note c ON c.month = m.month
     GROUP BY m.month
  ),
  cn_month_doc AS (
    SELECT to_char(c.month, 'YYYY-MM') AS month,
           jsonb_build_object(
             'status', 'read',
             'ticket', 'TP-07',
             'counted', false,
             'basis', 'inc GST as Xero allocates credit; total_ex is Xero''s SubTotal; on_job_ex is what Job Profit takes off actual job cost, ex GST. By credit note date. Live notes (AUTHORISED or PAID) only; shown beside the bills total, never netted from it.',
             'notes', c.notes,
             'amount_unknown_count', c.amount_unknown,
             'total_inc', c.total_inc,
             'total_ex', c.total_ex,
             'amount_ex', c.total_ex,
             'placed_inc', c.placed_inc,
             'placed_by_job_profit', jsonb_build_object(
               'counted_from_credit_note_inc', c.from_note_inc,
               'counted_by_bill_inc', c.by_bill_inc,
               'bill_amount_credited_inc', c.amount_credited_inc,
               'exceeds_bill_inc', c.exceeds_inc),
             'on_job_ex', jsonb_build_object('counted_from_credit_note_ex', c.counted_ex),
             'not_placed_inc', c.not_placed_inc,
             'not_placed_by_reason', jsonb_build_object(
               'bill_not_in_copy', c.np_not_in_copy,
               'bill_not_live', c.np_not_live,
               'bill_total_unknown', c.np_total_unknown,
               'crew_bill', c.np_crew,
               'bill_not_placed', c.np_not_placed,
               'amount_not_positive', c.np_not_positive),
             'unallocated_inc', c.unallocated_inc,
             'cash_refund_inc', c.refund_inc,
             'unknown_parts', c.unknown_parts,
             'unknown_notes', c.unknown_notes,
             'not_accounted_inc', c.not_accounted_inc,
             'parts_add_up', c.parts_add_up,
             'parts_check', 'Per live note with a known total and no unknown part: placed + not placed + unallocated + refunded against Xero''s Total; a deleted allocation is no part. Null while a total or a part is unknown; false when a known note does not add up.',
             'not_live', jsonb_build_object('notes', c.not_live_notes, 'inc', c.not_live_inc, 'counted', false)
           ) AS doc
      FROM cn_month c
  )
  SELECT CASE
    WHEN r.read_at IS NULL THEN t.doc
    ELSE t.doc || jsonb_build_object(
      'covers', 'bills; supplier credit notes are shown beside each month, never netted from the bills total',
      'credit_notes_read_at', r.read_at,
      'not_yet_read', (SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ord), '[]'::jsonb)
                         FROM jsonb_array_elements(t.doc -> 'not_yet_read') WITH ORDINALITY AS e(value, ord)
                        WHERE e.value ->> 'part' IS DISTINCT FROM 'supplier_credit_notes'),
      'undated_credit_notes', (SELECT jsonb_build_object('count', count(*) FILTER (WHERE c.live),
                                                         'inc', COALESCE(sum(c.total) FILTER (WHERE c.live), 0))
                                 FROM cn_note c WHERE c.credit_note_date IS NULL),
      'months', (SELECT COALESCE(jsonb_agg(CASE WHEN d.doc IS NULL THEN m.value
                                                ELSE m.value || jsonb_build_object('credit_notes', d.doc) END
                                           ORDER BY m.ord), '[]'::jsonb)
                   FROM jsonb_array_elements(t.doc -> 'months') WITH ORDINALITY AS m(value, ord)
                   LEFT JOIN cn_month_doc d ON d.month = m.value ->> 'month'))
  END
  FROM tp01 t, cn_read r
$$;

COMMENT ON FUNCTION public.xero_tieout_monthly(date, integer, uuid) IS
  'TP-01 Xero tie-out, Job Profit rule (20261115100000; built on 20261029121500 and TP-07 20261030060000): by month, every AUTHORISED or PAID supplier bill dollar of 0 or more (ex GST) in our copy of Xero sorted into on a job, trade-app labour (already counted on jobs by the trade app), overhead / not job related (stock and vehicles not yet separated) or unplaced, with the unplaced share (rounded up, never below 0) and the last 6 months. On a job is what Job Profit counts for the bill today: its actual cost rows for the bill in v_job_cost_events (sources supplier_bill and materials_fact) on a job that is not a holding job, summed with their signs and capped at the bill, so every route that puts a bill line on a job (a placement, the Xero job link, a job number on the line, bookkeeping''s line evidence) is counted here the day Job Profit counts it, for a job in the bill''s own org. A bill that reads as a trade-app bill is trade-app labour only while Job Profit has no cost row of it on a job. A row Job Profit holds back (an installer placement nobody has confirmed, JP-12) is unplaced: installer_awaiting_confirmation. Overhead is next, capped at what the job rows left: the greater of what a person filed in Bills to place (the overhead part of a split, else a bill filed not job related whole) and the lines bookkeeping''s current evidence rules are no job''s cost (v_bookkeeping_line_evidence_current, evidenced, no job, allocation overhead or not_job_cost); non_job.by_basis splits it. Unplaced is the bill''s remainder, by reason. A bill below 0 is shown only as negative_bill; job rows plus the greater of the holding-job rows and the not-a-job claim, above a bill that is not trade-app labour, are shown as over_allocated; neither is in the total. parts_add_up checks the buckets against the bills read directly. p_org_id scopes every read to one org (null reads every org, a bill per org and Xero id; a bill''s cost rows are read in the org of the job they sit on). as_of picks the months only: cost rows, Bills to place states and evidence are as of today. Spend money (TP-08) is not_yet_read with a null amount, never $0. Supplier credit notes (TP-07) are read exactly as 20261030060000 reads them: not_yet_read until xero-sync has finished a full read of the org''s credit notes, then shown beside each month from v_supplier_credit_placement, never netted from the bills total. Read only, aggregates only, service role only.';
REVOKE ALL ON FUNCTION public.xero_tieout_monthly(date, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.xero_tieout_monthly(date, integer, uuid) TO service_role;
