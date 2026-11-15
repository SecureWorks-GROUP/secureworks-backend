-- TP-08 Xero tie-out, the two sides the bills page does not cover: card and bank spend, and customer invoices.
--
-- The bills tie-out (xero_tieout_monthly, 20261115100000) sorts every supplier bill dollar. Two kinds of money never
-- pass through a supplier bill and were not read at all:
--   * Spend money: card and bank payments entered straight into Xero (fuel, hardware on the card, subscriptions,
--     loan repayments). xero-sync now copies each one's lines (xero-sync/bank_transactions.ts) into their own
--     table, so they can be sorted by the Xero account each line was coded to.
--   * Customer invoices: every ACCREC invoice dollar, against what Job Profit counts as invoiced on a job.
--
-- What this migration adds, and nothing else:
--   1. public.xero_bank_transaction_lines: the lines of each bank transaction (one row per transaction), written
--      only by xero-sync, service role only. They are kept OUT of xero_bank_transactions on purpose: that table
--      can be read with the browser key today (policy "Users view transactions", USING (true), with anon and
--      authenticated grants), and a line carries the description typed in Xero. This migration does not change
--      who can read xero_bank_transactions; that is the owner's call.
--   2. public.xero_accounts: our copy of Xero's chart of accounts (one row per account), written only by xero-sync.
--      Xero's own account Type and Class decide what a spend line is. No list of account codes lives in SQL.
--   3. public.xero_spend_revenue_monthly(as_of, months, org): by month, read only, aggregates only.
--        spend    every reconciled spend money dollar (ex GST) in our copy, sorted by the account of each line:
--                 direct_cost (Xero type DIRECTCOSTS), overhead (any other EXPENSE class account), not_a_cost
--                 (ASSET, LIABILITY, EQUITY: loan repayments, tax, wages payable, drawings, prepayments),
--                 income_account (REVENUE class), account_unknown (no such account in our copy of the chart),
--                 paid_ahead (every line of a supplier prepayment or overpayment, whatever its account: the
--                 cost usually arrives again on a supplier bill, so it is shown apart and never called a cost),
--                 no_line_detail (a transaction copied before lines were read), lines_differ (the difference
--                 between the lines and the transaction's own subtotal). A month adds up only when no
--                 transaction's lines differ from its subtotal by more than 5 cents; differences are counted
--                 per transaction, so two that cancel still show, and such a month is partial, never read. Job Profit has no route from spend money to
--                 a job, so direct cost spend is on no job: on_job_ex is null with the reason, never 0.
--        revenue  every AUTHORISED or PAID customer invoice dollar (ex GST) in our copy, as on a job (what Job
--                 Profit counts as invoiced for that invoice on a job that is not a holding job), on a holding
--                 job, or not on a job; with the invoices not counted (draft, submitted) beside it.
--      It changes no figure anywhere: xero_tieout_monthly, Job Profit and every view are untouched. ops-api joins
--      the two answers for the Tie to Xero page.
--
-- Known limit, not fixed here: the copy is only ever added to. A transaction unreconciled or removed in Xero
-- after it was copied is not read again and stays counted until the copy is corrected.
--
-- A holding job is lower(coalesce(metadata->>'do_not_schedule','')) = 'true', Job Profit's rule.
-- as_of picks the months only; everything is read as it stands today.
-- Rollback: supabase/rollbacks/20261115110000_xero_spend_revenue_tieout_down.sql (drops the function; drops each
-- of the two tables only while it is empty, else leaves it and says so).
--
-- Rehearsed 15 Nov 2026 as a plain read on production (revenue half; the spend half has no lines to read until
-- xero-sync's first whole read): customer invoices AUTHORISED or PAID, ex GST, all on a job by Job Profit's rows:
--   2026-07 214,080.80   2026-08 273,625.47   2026-09 258,524.11   2026-10 321,183.06   2026-11 109,396.84

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $guard$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(w.rel || '.' || w.col, ', ' ORDER BY w.rel, w.col) INTO missing
    FROM (VALUES ('xero_bank_transactions', 'org_id'), ('xero_bank_transactions', 'xero_txn_id'),
                 ('xero_bank_transactions', 'sub_total'), ('xero_bank_transactions', 'synced_at'),
                 ('xero_bank_transactions', 'txn_type'), ('xero_bank_transactions', 'txn_date'),
                 ('xero_bank_transactions', 'status'), ('xero_sync_state', 'cursor_at'),
                 ('v_job_revenue_events', 'job_id'), ('v_job_revenue_events', 'document_id'),
                 ('v_job_revenue_events', 'kind'), ('v_job_revenue_events', 'amount_ex'),
                 ('v_job_revenue_events', 'counts_as_invoiced'), ('v_job_revenue_events', 'invoice_date'),
                 ('xero_invoices', 'invoice_type'), ('xero_invoices', 'sub_total'), ('jobs', 'metadata')) AS w(rel, col)
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns c
                      WHERE c.table_schema = 'public' AND c.table_name = w.rel AND c.column_name = w.col);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'xero_spend_revenue_tieout_prerequisite_missing: %', missing;
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS public.xero_bank_transaction_lines (
  org_id            uuid        NOT NULL,
  xero_txn_id       text        NOT NULL,
  xero_type         text,
  line_amount_types text,
  line_items        jsonb       NOT NULL,
  xero_updated_at   timestamptz,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, xero_txn_id),
  CONSTRAINT xero_bank_transaction_lines_is_array CHECK (jsonb_typeof(line_items) = 'array')
);

COMMENT ON TABLE public.xero_bank_transaction_lines IS
  'The lines of each Xero bank transaction (20261115110000): one row per transaction (org, Xero id), line_items exactly as Xero sent them, xero_type Xero''s own transaction type (SPEND, SPEND-PREPAYMENT, SPEND-OVERPAYMENT and so on, before it is folded to SPEND, RECEIVE or TRANSFER) and line_amount_types (Inclusive, Exclusive, NoTax) saying whether line amounts hold GST. Written only by xero-sync (xero-sync/bank_transactions.ts). Kept apart from xero_bank_transactions, which browser roles can read; this table is service role only. Read by xero_spend_revenue_monthly.';

ALTER TABLE public.xero_bank_transaction_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.xero_bank_transaction_lines FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.xero_bank_transaction_lines TO service_role;

CREATE TABLE IF NOT EXISTS public.xero_accounts (
  org_id          uuid        NOT NULL,
  xero_account_id text        NOT NULL,
  code            text,
  name            text,
  type            text,
  class           text,
  status          text,
  tax_type        text,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, xero_account_id)
);

CREATE INDEX IF NOT EXISTS xero_accounts_org_code_idx ON public.xero_accounts (org_id, code);

COMMENT ON TABLE public.xero_accounts IS
  'Our copy of Xero''s chart of accounts (20261115110000): one row per Xero account, type and class exactly as Xero sent them, written only by xero-sync (xero-sync/accounts.ts). Read by xero_spend_revenue_monthly to say what a spend money line is. Service role only.';

ALTER TABLE public.xero_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.xero_accounts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.xero_accounts TO service_role;

CREATE OR REPLACE FUNCTION public.xero_spend_revenue_monthly(p_as_of date DEFAULT NULL, p_months integer DEFAULT 12, p_org_id uuid DEFAULT NULL)
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
  month_list AS (
    SELECT g::date AS month
      FROM win, generate_series(win.from_month::timestamp, (win.to_excl - 1)::timestamp, interval '1 month') g
  ),
  -- ── Spend money ──────────────────────────────────────────────────────────
  -- Reconciled spend in our copy of Xero's bank transactions. Transfers
  -- between our own accounts and money received are other types and are not
  -- read. A deleted or voided transaction is not spend.
  txn AS (
    SELECT t.org_id, t.xero_txn_id, t.txn_date,
           date_trunc('month', t.txn_date)::date AS month,
           round(abs(t.sub_total), 2) AS txn_ex,
           CASE WHEN jsonb_array_length(tl.line_items) > 0 THEN tl.line_items END AS lines,
           tl.line_amount_types,
           upper(COALESCE(tl.xero_type, '')) IN ('SPEND-PREPAYMENT', 'SPEND-OVERPAYMENT') AS paid_ahead
      FROM public.xero_bank_transactions t
      LEFT JOIN public.xero_bank_transaction_lines tl
        ON tl.org_id = t.org_id AND tl.xero_txn_id = t.xero_txn_id
     WHERE t.txn_type = 'SPEND'
       AND upper(COALESCE(t.status, '')) NOT IN ('DELETED', 'VOIDED')
       AND (p_org_id IS NULL OR t.org_id = p_org_id)
  ),
  copy_range AS (
    SELECT min(t.txn_date) AS first_date, date_trunc('month', min(t.txn_date))::date AS first_month FROM txn t
  ),
  -- One row per line: its amount without GST (Xero says on the transaction
  -- whether line amounts include it) and the account it was coded to.
  line AS (
    SELECT t.org_id, t.xero_txn_id, t.month, t.paid_ahead,
           round(CASE WHEN jsonb_typeof(l.value -> 'LineAmount') = 'number' THEN
                   (l.value ->> 'LineAmount')::numeric
                   - CASE WHEN lower(COALESCE(t.line_amount_types, '')) = 'inclusive'
                               AND jsonb_typeof(l.value -> 'TaxAmount') = 'number'
                          THEN (l.value ->> 'TaxAmount')::numeric ELSE 0 END
                 END, 2) AS line_ex,
           NULLIF(l.value ->> 'AccountID', '') AS account_id,
           NULLIF(l.value ->> 'AccountCode', '') AS account_code,
           NULLIF(l.value -> 'Tracking' -> 0 ->> 'Option', '') AS tracking_option
      FROM txn t, jsonb_array_elements(t.lines) AS l(value)
     WHERE t.lines IS NOT NULL
       AND t.txn_date >= (SELECT from_month FROM win) AND t.txn_date < (SELECT to_excl FROM win)
  ),
  -- The account by Xero's id, else by its code in the same org. A supplier
  -- prepayment or overpayment is paid ahead whatever account its lines name:
  -- the cost usually arrives again on a supplier bill.
  line_acct AS (
    SELECT l.*, a.code AS acct_code, a.name AS acct_name, a.type AS acct_type, a.class AS acct_class,
           CASE
             WHEN l.paid_ahead THEN 'paid_ahead'
             WHEN a.xero_account_id IS NULL THEN 'account_unknown'
             WHEN upper(COALESCE(a.type, '')) = 'DIRECTCOSTS' THEN 'direct_cost'
             WHEN upper(COALESCE(a.class, '')) = 'EXPENSE' THEN 'overhead'
             WHEN upper(COALESCE(a.class, '')) IN ('ASSET', 'LIABILITY', 'EQUITY') THEN 'not_a_cost'
             WHEN upper(COALESCE(a.class, '')) = 'REVENUE' THEN 'income_account'
             ELSE 'account_unknown'
           END AS kind
      FROM line l
      LEFT JOIN LATERAL (
        SELECT x.* FROM public.xero_accounts x
         WHERE x.org_id = l.org_id
           AND ((l.account_id IS NOT NULL AND x.xero_account_id = l.account_id)
             OR (l.account_code IS NOT NULL AND x.code = l.account_code))
         ORDER BY (x.xero_account_id = l.account_id) DESC NULLS LAST, (upper(COALESCE(x.status, '')) = 'ACTIVE') DESC,
                  x.xero_account_id COLLATE "C"
         LIMIT 1) a ON true
  ),
  txn_lines AS (
    SELECT l.org_id, l.xero_txn_id, sum(COALESCE(l.line_ex, 0)) AS lines_ex,
           count(*) FILTER (WHERE l.line_ex IS NULL) AS unread_lines
      FROM line_acct l GROUP BY l.org_id, l.xero_txn_id
  ),
  spend_txn_month AS (
    SELECT t.month,
           count(*) AS n,
           count(*) FILTER (WHERE t.txn_ex IS NULL) AS amount_unknown,
           COALESCE(sum(t.txn_ex), 0) AS total_ex,
           count(*) FILTER (WHERE t.lines IS NOT NULL) AS with_lines,
           COALESCE(sum(t.txn_ex) FILTER (WHERE t.lines IS NULL), 0) AS no_line_detail_ex,
           COALESCE(sum(t.txn_ex - tl.lines_ex) FILTER (WHERE t.lines IS NOT NULL), 0) AS lines_differ_ex,
           count(*) FILTER (WHERE t.lines IS NOT NULL AND abs(t.txn_ex - tl.lines_ex) > 0.05) AS lines_differ_n,
           COALESCE(sum(tl.unread_lines), 0) AS unread_lines
      FROM txn t
      LEFT JOIN txn_lines tl ON tl.org_id = t.org_id AND tl.xero_txn_id = t.xero_txn_id
     WHERE t.txn_date >= (SELECT from_month FROM win) AND t.txn_date < (SELECT to_excl FROM win)
     GROUP BY t.month
  ),
  spend_kind_month AS (
    SELECT l.month,
           COALESCE(sum(l.line_ex) FILTER (WHERE l.kind = 'direct_cost'), 0) AS direct_cost_ex,
           COALESCE(sum(l.line_ex) FILTER (WHERE l.kind = 'overhead'), 0) AS overhead_ex,
           COALESCE(sum(l.line_ex) FILTER (WHERE l.kind = 'not_a_cost'), 0) AS not_a_cost_ex,
           COALESCE(sum(l.line_ex) FILTER (WHERE l.kind = 'income_account'), 0) AS income_account_ex,
           COALESCE(sum(l.line_ex) FILTER (WHERE l.kind = 'account_unknown'), 0) AS account_unknown_ex,
           count(*) FILTER (WHERE l.kind = 'account_unknown') AS account_unknown_lines,
           COALESCE(sum(l.line_ex) FILTER (WHERE l.kind = 'paid_ahead'), 0) AS paid_ahead_ex,
           count(*) FILTER (WHERE l.kind = 'paid_ahead') AS paid_ahead_lines
      FROM line_acct l GROUP BY l.month
  ),
  spend_account_month AS (
    SELECT s.month,
           jsonb_agg(jsonb_build_object('code', s.code, 'name', s.name, 'kind', s.kind, 'lines', s.n, 'ex', s.ex)
                     ORDER BY s.ex DESC, s.code COLLATE "C", s.kind COLLATE "C") AS doc
      FROM (SELECT l.month, COALESCE(l.acct_code, l.account_code) AS code, l.acct_name AS name, l.kind,
                   count(*) AS n, COALESCE(sum(l.line_ex), 0) AS ex
              FROM line_acct l
             GROUP BY l.month, COALESCE(l.acct_code, l.account_code), l.acct_name, l.kind) s
     GROUP BY s.month
  ),
  spend_direct_tracking AS (
    SELECT s.month,
           jsonb_agg(jsonb_build_object('tracking', s.opt, 'lines', s.n, 'ex', s.ex)
                     ORDER BY s.ex DESC, s.opt COLLATE "C" NULLS LAST) AS doc
      FROM (SELECT l.month, l.tracking_option AS opt, count(*) AS n, COALESCE(sum(l.line_ex), 0) AS ex
              FROM line_acct l WHERE l.kind = 'direct_cost'
             GROUP BY l.month, l.tracking_option) s
     GROUP BY s.month
  ),
  chart AS (
    SELECT count(*) AS n, max(a.synced_at) AS synced_at
      FROM public.xero_accounts a WHERE (p_org_id IS NULL OR a.org_id = p_org_id)
  ),
  lines_cursor AS (
    SELECT min(s.cursor_at) AS read_at
      FROM public.xero_sync_state s
     WHERE s.cursor_at IS NOT NULL
       AND CASE WHEN p_org_id IS NULL THEN starts_with(s.key, 'bank_transactions_full:')
                ELSE starts_with(s.key, 'bank_transactions_full:' || p_org_id::text || ':') END
  ),
  spend_doc AS (
    SELECT ml.month,
           CASE
             WHEN cr.first_month IS NULL OR ml.month < cr.first_month THEN 'not_in_copy'
             WHEN (SELECT n FROM chart) = 0 THEN 'not_yet_read'
             WHEN COALESCE(st.n, 0) = 0 THEN 'read'
             WHEN st.with_lines = 0 THEN 'not_yet_read'
             WHEN st.with_lines < st.n OR COALESCE(sk.account_unknown_lines, 0) > 0 OR st.amount_unknown > 0
                  OR st.unread_lines > 0 OR st.lines_differ_n > 0 THEN 'partial'
             ELSE 'read'
           END AS status,
           st.n, st.amount_unknown, st.total_ex, st.with_lines, st.no_line_detail_ex, st.lines_differ_ex,
           st.lines_differ_n, st.unread_lines,
           sk.direct_cost_ex, sk.overhead_ex, sk.not_a_cost_ex, sk.income_account_ex, sk.account_unknown_ex,
           sk.account_unknown_lines, sk.paid_ahead_ex, sk.paid_ahead_lines, sa.doc AS by_account, sd.doc AS direct_by_tracking
      FROM month_list ml
      CROSS JOIN copy_range cr
      LEFT JOIN spend_txn_month st ON st.month = ml.month
      LEFT JOIN spend_kind_month sk ON sk.month = ml.month
      LEFT JOIN spend_account_month sa ON sa.month = ml.month
      LEFT JOIN spend_direct_tracking sd ON sd.month = ml.month
  ),
  -- ── Customer invoices ────────────────────────────────────────────────────
  inv AS (
    SELECT DISTINCT ON (x.org_id, x.xero_invoice_id)
           x.org_id, x.xero_invoice_id, x.status, x.invoice_date,
           date_trunc('month', x.invoice_date)::date AS month,
           round(x.sub_total, 2) AS inv_ex
      FROM public.xero_invoices x, win
     WHERE x.invoice_type = 'ACCREC'
       AND x.xero_invoice_id IS NOT NULL
       AND x.invoice_date >= win.from_month AND x.invoice_date < win.to_excl
       AND (p_org_id IS NULL OR x.org_id = p_org_id)
     ORDER BY x.org_id, x.xero_invoice_id, (x.status IN ('AUTHORISED', 'PAID')) DESC
  ),
  -- Job Profit's own revenue rows for those invoices: what it counts as
  -- invoiced, per invoice, on a real job and on a holding job. A row is read
  -- in the org of the job it sits on.
  rev AS MATERIALIZED (
    SELECT j.org_id, e.document_id AS xero_invoice_id,
           COALESCE(sum(e.amount_ex) FILTER (WHERE NOT j.hold), 0) AS job_ex,
           COALESCE(sum(e.amount_ex) FILTER (WHERE j.hold), 0) AS hold_ex
      FROM public.v_job_revenue_events e
      JOIN (SELECT jj.id, jj.org_id,
                   lower(COALESCE(jj.metadata ->> 'do_not_schedule', '')) = 'true' AS hold
              FROM public.jobs jj) j ON j.id = e.job_id
     WHERE e.kind = 'invoice_line'
       AND e.counts_as_invoiced
       AND e.document_id IS NOT NULL
       AND e.invoice_date >= (SELECT from_month FROM win) AND e.invoice_date < (SELECT to_excl FROM win)
       AND (p_org_id IS NULL OR j.org_id = p_org_id)
     GROUP BY j.org_id, e.document_id
  ),
  inv_sorted AS (
    SELECT i.month, i.status, i.inv_ex,
           COALESCE(r.job_ex, 0) AS job_ex, COALESCE(r.hold_ex, 0) AS hold_ex,
           i.inv_ex - COALESCE(r.job_ex, 0) - COALESCE(r.hold_ex, 0) AS rest_ex
      FROM inv i
      LEFT JOIN rev r ON r.org_id = i.org_id AND r.xero_invoice_id = i.xero_invoice_id
  ),
  rev_month AS (
    SELECT s.month,
           count(*) FILTER (WHERE s.status IN ('AUTHORISED', 'PAID')) AS n,
           count(*) FILTER (WHERE s.status IN ('AUTHORISED', 'PAID') AND s.inv_ex IS NULL) AS amount_unknown,
           COALESCE(sum(s.inv_ex) FILTER (WHERE s.status IN ('AUTHORISED', 'PAID')), 0) AS total_ex,
           COALESCE(sum(s.job_ex) FILTER (WHERE s.status IN ('AUTHORISED', 'PAID')), 0) AS on_job_ex,
           COALESCE(sum(s.hold_ex) FILTER (WHERE s.status IN ('AUTHORISED', 'PAID')), 0) AS holding_ex,
           COALESCE(sum(GREATEST(s.rest_ex, 0)) FILTER (WHERE s.status IN ('AUTHORISED', 'PAID')), 0) AS not_on_job_ex,
           count(*) FILTER (WHERE s.status IN ('AUTHORISED', 'PAID') AND s.rest_ex > 0) AS not_on_job_n,
           COALESCE(sum(GREATEST(-s.rest_ex, 0)) FILTER (WHERE s.status IN ('AUTHORISED', 'PAID')), 0) AS over_ex,
           count(*) FILTER (WHERE s.status IN ('AUTHORISED', 'PAID') AND s.rest_ex < 0) AS over_n,
           count(*) FILTER (WHERE s.status IN ('DRAFT', 'SUBMITTED')) AS draft_n,
           COALESCE(sum(s.inv_ex) FILTER (WHERE s.status IN ('DRAFT', 'SUBMITTED')), 0) AS draft_ex
      FROM inv_sorted s GROUP BY s.month
  ),
  month_docs AS (
    SELECT ml.month,
           jsonb_build_object(
             'month', to_char(ml.month, 'YYYY-MM'),
             'spend', jsonb_build_object(
               'status', sp.status,
               'ticket', 'TP-08',
               'counted', false,
               'transactions', COALESCE(sp.n, 0),
               'with_line_detail', COALESCE(sp.with_lines, 0),
               'amount_unknown_count', COALESCE(sp.amount_unknown, 0),
               'amount_ex', CASE WHEN sp.status IN ('read', 'partial') THEN COALESCE(sp.total_ex, 0) END,
               'total_ex', CASE WHEN sp.status = 'not_in_copy' THEN NULL ELSE COALESCE(sp.total_ex, 0) END,
               'direct_cost', CASE WHEN sp.status IN ('read', 'partial') THEN jsonb_build_object(
                 'ex', COALESCE(sp.direct_cost_ex, 0),
                 'on_job_ex', NULL,
                 'on_job', 'no_route_yet',
                 'reads', 'Lines coded to a Xero direct cost account. Job Profit does not read spend money, so none of this is on a job yet.',
                 'by_tracking', COALESCE(sp.direct_by_tracking, '[]'::jsonb)) END,
               'overhead_ex', CASE WHEN sp.status IN ('read', 'partial') THEN COALESCE(sp.overhead_ex, 0) END,
               'not_a_cost_ex', CASE WHEN sp.status IN ('read', 'partial') THEN COALESCE(sp.not_a_cost_ex, 0) END,
               'income_account_ex', CASE WHEN sp.status IN ('read', 'partial') THEN COALESCE(sp.income_account_ex, 0) END,
               'account_unknown_ex', CASE WHEN sp.status IN ('read', 'partial') THEN COALESCE(sp.account_unknown_ex, 0) END,
               'account_unknown_lines', COALESCE(sp.account_unknown_lines, 0),
               'paid_ahead_ex', CASE WHEN sp.status IN ('read', 'partial') THEN COALESCE(sp.paid_ahead_ex, 0) END,
               'paid_ahead_lines', COALESCE(sp.paid_ahead_lines, 0),
               'paid_ahead_reads', 'Supplier prepayments and overpayments. The cost usually arrives again on a supplier bill, so these are shown apart and are in no other part.',
               'no_line_detail_ex', CASE WHEN sp.status = 'not_in_copy' THEN NULL ELSE COALESCE(sp.no_line_detail_ex, 0) END,
               'lines_differ_ex', CASE WHEN sp.status IN ('read', 'partial') THEN COALESCE(sp.lines_differ_ex, 0) END,
               'lines_differ_transactions', COALESCE(sp.lines_differ_n, 0),
               'unread_lines', COALESCE(sp.unread_lines, 0),
               'by_account', CASE WHEN sp.status IN ('read', 'partial') THEN COALESCE(sp.by_account, '[]'::jsonb) END,
               'parts_add_up', CASE WHEN sp.status IN ('read', 'partial') THEN
                 (COALESCE(sp.direct_cost_ex, 0) + COALESCE(sp.overhead_ex, 0) + COALESCE(sp.not_a_cost_ex, 0)
                  + COALESCE(sp.income_account_ex, 0) + COALESCE(sp.account_unknown_ex, 0)
                  + COALESCE(sp.paid_ahead_ex, 0)
                  + COALESCE(sp.no_line_detail_ex, 0) + COALESCE(sp.lines_differ_ex, 0) = COALESCE(sp.total_ex, 0))
                 AND COALESCE(sp.lines_differ_n, 0) = 0 END,
               'parts_check', 'each line less its GST, by the account it was coded to (prepayments and overpayments apart), plus transactions with no line detail, against the transactions'' own subtotals; lines_differ is the difference between the two, and the month adds up only when no transaction''s lines differ from its subtotal by more than 5 cents'),
             'revenue', jsonb_build_object(
               'invoices', COALESCE(rv.n, 0),
               'amount_unknown_count', COALESCE(rv.amount_unknown, 0),
               'total_ex', COALESCE(rv.total_ex, 0),
               'on_job_ex', COALESCE(rv.on_job_ex, 0),
               'holding_job_ex', COALESCE(rv.holding_ex, 0),
               'not_on_job_ex', COALESCE(rv.not_on_job_ex, 0),
               'not_on_job_invoices', COALESCE(rv.not_on_job_n, 0),
               'not_on_job_share', CASE WHEN COALESCE(rv.total_ex, 0) > 0
                                        THEN round(LEAST((COALESCE(rv.not_on_job_ex, 0) + COALESCE(rv.holding_ex, 0)) / rv.total_ex, 1), 4) END,
               'over_counted', jsonb_build_object('invoices', COALESCE(rv.over_n, 0), 'ex', COALESCE(rv.over_ex, 0),
                 'reads', 'Job Profit counts more on jobs for these invoices than the invoice holds. Shown, never netted.'),
               'not_counted', jsonb_build_object('draft_or_submitted_invoices', COALESCE(rv.draft_n, 0),
                                                 'draft_or_submitted_ex', COALESCE(rv.draft_ex, 0)),
               'parts_add_up', (COALESCE(rv.on_job_ex, 0) + COALESCE(rv.holding_ex, 0) + COALESCE(rv.not_on_job_ex, 0)
                                - COALESCE(rv.over_ex, 0) = COALESCE(rv.total_ex, 0)),
               'parts_check', 'on a job + on a holding job + not on a job, less anything counted above its invoice, against the invoices read directly from the copy')
           ) AS doc,
           sp.status AS spend_status,
           COALESCE(sp.total_ex, 0) AS spend_total_ex, COALESCE(sp.direct_cost_ex, 0) AS spend_direct_ex,
           COALESCE(rv.total_ex, 0) AS rev_total_ex,
           COALESCE(rv.not_on_job_ex, 0) + COALESCE(rv.holding_ex, 0) AS rev_off_job_ex
      FROM month_list ml
      JOIN spend_doc sp ON sp.month = ml.month
      LEFT JOIN rev_month rv ON rv.month = ml.month
  )
  SELECT jsonb_build_object(
    'as_of', win.as_of,
    'as_of_reads', 'as_of picks the months shown and nothing else. Spend, the chart of accounts, invoices and Job Profit''s revenue rows are read as they are today.',
    'org_id', p_org_id,
    'months_shown', win.months,
    'from_month', win.from_month,
    'basis', 'ex GST, to the cent; spend money by transaction date, customer invoices by invoice date',
    'spend_basis', 'Reconciled spend money in our copy of Xero (card and bank payments entered straight into Xero, supplier prepayments and overpayments among them). Transfers between our own accounts and money received are not spend. A supplier bill paid from the bank is a payment of that bill and is not here. Each line is sorted by the Xero account it was coded to, by Xero''s own account type; the lines of a supplier prepayment or overpayment are shown apart as paid ahead. A transaction unreconciled or removed in Xero after it was copied stays counted.',
    'spend_copy', jsonb_build_object(
      'first_transaction_date', (SELECT first_date FROM copy_range),
      'lines_read_at', (SELECT read_at FROM lines_cursor),
      'chart_accounts', (SELECT n FROM chart),
      'chart_synced_at', (SELECT synced_at FROM chart),
      'synced_at', (SELECT max(t.synced_at) FROM public.xero_bank_transactions t
                     WHERE (p_org_id IS NULL OR t.org_id = p_org_id))),
    'revenue_basis', 'Customer invoices (ACCREC) AUTHORISED or PAID in our copy of Xero. On a job is what Job Profit counts as invoiced for that invoice today (v_job_revenue_events, invoice lines) on a job that is not a holding job. Credits applied are Job Profit''s own rows and are not netted here.',
    'last_6_months', (SELECT jsonb_build_object(
        'from', to_char(win.six_from, 'YYYY-MM'),
        'to', to_char(win.as_of, 'YYYY-MM'),
        'revenue_total_ex', COALESCE(sum(d.rev_total_ex), 0),
        'revenue_not_on_job_ex', COALESCE(sum(d.rev_off_job_ex), 0),
        'revenue_on_job_share', CASE WHEN COALESCE(sum(d.rev_total_ex), 0) > 0
                                     THEN round(GREATEST(1 - sum(d.rev_off_job_ex) / sum(d.rev_total_ex), 0), 4) END,
        'spend_months_read', count(*) FILTER (WHERE d.spend_status IN ('read', 'partial')),
        'spend_total_ex', CASE WHEN count(*) FILTER (WHERE d.spend_status IN ('read', 'partial')) > 0
                               THEN COALESCE(sum(d.spend_total_ex) FILTER (WHERE d.spend_status IN ('read', 'partial')), 0) END,
        'spend_direct_cost_ex', CASE WHEN count(*) FILTER (WHERE d.spend_status IN ('read', 'partial')) > 0
                                     THEN COALESCE(sum(d.spend_direct_ex) FILTER (WHERE d.spend_status IN ('read', 'partial')), 0) END)
      FROM month_docs d WHERE d.month >= win.six_from),
    'months', (SELECT COALESCE(jsonb_agg(d.doc ORDER BY d.month DESC), '[]'::jsonb) FROM month_docs d)
  )
  FROM win
$$;

COMMENT ON FUNCTION public.xero_spend_revenue_monthly(date, integer, uuid) IS
  'TP-08 Xero tie-out, spend money and customer invoices (20261115110000): by month, read only, aggregates only. spend: every reconciled spend money dollar (ex GST) in our copy of Xero''s bank transactions (type SPEND, not deleted or voided; transfers and money received are not spend), each line less its GST sorted by the Xero account it was coded to, read from xero_bank_transaction_lines and sorted by Xero''s own account type and class in xero_accounts: direct_cost (type DIRECTCOSTS), overhead (other EXPENSE class), not_a_cost (ASSET, LIABILITY, EQUITY), income_account (REVENUE), account_unknown (not in our copy of the chart), paid_ahead (every line of a SPEND-PREPAYMENT or SPEND-OVERPAYMENT, whatever its account, because the cost usually arrives again on a supplier bill), with no_line_detail for a transaction copied before its lines were read and lines_differ for the difference between lines and subtotal; parts_add_up needs no transaction whose lines differ from its subtotal by more than 5 cents (lines_differ_transactions 0), so differences that cancel still show. Job Profit has no route from spend money to a job, so direct_cost.on_job_ex is null (no_route_yet), never 0. status: read, partial (some transactions without lines, an unknown account, an unknown amount, a line with no readable amount or a transaction whose lines differ from its subtotal), not_yet_read (no chart or no lines), not_in_copy (before the copy''s first transaction; amounts null). revenue: every AUTHORISED or PAID customer invoice dollar (ex GST) as on a job (what Job Profit counts as invoiced for the invoice in v_job_revenue_events on a job that is not a holding job), on a holding job, or not on a job (the invoice''s remainder); more counted than the invoice holds is over_counted and never netted. Changes no figure elsewhere. p_org_id scopes every read (null reads every org). as_of picks the months only. Service role only.';

REVOKE ALL ON FUNCTION public.xero_spend_revenue_monthly(date, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.xero_spend_revenue_monthly(date, integer, uuid) TO service_role;
