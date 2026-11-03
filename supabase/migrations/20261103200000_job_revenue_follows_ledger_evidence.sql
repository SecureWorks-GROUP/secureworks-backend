-- Job Profit revenue follows Bookkeeping's ledger when an invoice has no job link (finish line A3, 3 Nov 2026).
--
-- Found by context-system/verify/scripts/a3_division_months.py (division x month against Xero's profit and loss,
-- read 3 Nov 2026 06:45Z): 41 customer-invoice lines on 23 invoices, $41,033.12 ex GST dated July to October, are
-- placed on a job by Bookkeeping's current revenue evidence (revision 20261102-ledger-revenue-r4) but our Xero copy
-- holds no job link for the invoice (xero_invoices.job_id is null: builder-claim invoices such as INV-1670
-- SWR-261572 $9,840, INV-1787 SWF-261359 $7,250, INV-1688 SWR-261574 $4,372.50). Job Profit read revenue only from
-- that link, so these jobs showed no revenue and the division totals fell short of Xero (Insurance Work, October:
-- $32,499.62). Costs already follow the ledger for bills with no job link (#1243); revenue now does the same.
--
-- Rule (r57 revenue placement): a customer-invoice line on an invoice with no job link counts on the job
-- Bookkeeping's current evidence names for that line (allocation job, evidenced, a known job). A linked invoice
-- is unchanged; the ledger never moves a line off a linked job here. The invoice-level figures (credit applied,
-- collected) follow only when every line with an amount is evidenced to one and the same job; otherwise they stay
-- off any job, as before. Four objects change together so the job page, the R57 checks and v_job_profit agree:
--   v_job_revenue_events  invoice lines and credit applied, as above;
--   v_job_profit          collected (amount paid) for such an invoice, on the same job;
--   job_profit_line_evidence_many  those lines are the job's own invoice lines (no longer "not carried");
--   job_profit_line_evidence_score a job can be a Verified candidate through such lines.
-- Nothing else moves: no table, no data write, no change for any invoice that has a job link.
--
-- Guards: each object must be the exact definition this was written against (md5 below, read 3 Nov 2026); every
-- replaced fragment must be there exactly once; afterwards each object must be the rehearsed definition.
-- Rehearsed on a throwaway local PostgreSQL 17 built from the live definitions (context-system evidence
-- 20261103-a3/rehearse), never on production.
-- Rollback: supabase/rollbacks/20261103200000_job_revenue_follows_ledger_evidence_down.sql (the exact earlier definitions).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- v_job_profit's text carries a timestamp, which prints in the session's time zone; the md5 guards are taken in UTC.
SET LOCAL TimeZone = 'UTC';

DO $mig$
DECLARE
  d_rev text := pg_get_viewdef('public.v_job_revenue_events'::regclass, true);
  d_vjp text := pg_get_viewdef('public.v_job_profit'::regclass, true);
  d_many text := pg_get_functiondef('public.job_profit_line_evidence_many(uuid[])'::regprocedure);
  d_score text := pg_get_functiondef('public.job_profit_line_evidence_score(date,date)'::regprocedure);
  o_rev1 text := $orev1$ SELECT x.job_id,
    'invoice_line'::text AS kind,$orev1$;
  n_rev1 text := $nrev1$ SELECT COALESCE(x.job_id, ev.job_id) AS job_id,
    'invoice_line'::text AS kind,$nrev1$;
  o_rev2 text := $orev2$        END) WITH ORDINALITY li(value, n)
  WHERE x.invoice_type = 'ACCREC'::text AND x.job_id IS NOT NULL AND (x.status <> ALL (ARRAY['VOIDED'::text, 'DELETED'::text]))$orev2$;
  n_rev2 text := $nrev2$        END) WITH ORDINALITY li(value, n)
     LEFT JOIN v_bookkeeping_line_evidence_current ev ON x.job_id IS NULL AND ev.xero_invoice_id = x.xero_invoice_id AND ev.xero_line_item_id = (li.value ->> 'LineItemID'::text) AND ev.allocation = 'job'::text AND ev.evidenced AND ev.job_id IS NOT NULL
  WHERE x.invoice_type = 'ACCREC'::text AND COALESCE(x.job_id, ev.job_id) IS NOT NULL AND (x.status <> ALL (ARRAY['VOIDED'::text, 'DELETED'::text]))$nrev2$;
  o_rev3 text := $orev3$ SELECT x.job_id,
    'credit_applied'::text AS kind,$orev3$;
  n_rev3 text := $nrev3$ SELECT COALESCE(x.job_id, inv_ev.job_id) AS job_id,
    'credit_applied'::text AS kind,$nrev3$;
  o_rev4 text := $orev4$   FROM xero_invoices x
  WHERE x.invoice_type = 'ACCREC'::text AND x.job_id IS NOT NULL AND (x.status = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text])) AND job_cost_credit_share$orev4$;
  n_rev4 text := $nrev4$   FROM xero_invoices x
     LEFT JOIN LATERAL ( SELECT CASE WHEN count(*) > 0 AND count(*) = count(e.job_id) AND count(DISTINCT e.job_id) = 1 THEN (array_agg(e.job_id))[1] ELSE NULL::uuid END AS job_id FROM jsonb_array_elements(CASE WHEN jsonb_typeof(x.line_items) = 'array'::text THEN x.line_items ELSE '[]'::jsonb END) l(value) LEFT JOIN v_bookkeeping_line_evidence_current e ON e.xero_invoice_id = x.xero_invoice_id AND e.xero_line_item_id = (l.value ->> 'LineItemID'::text) AND e.allocation = 'job'::text AND e.evidenced AND e.job_id IS NOT NULL WHERE COALESCE(job_profit_num(l.value -> 'LineAmount'::text), 0::numeric) <> 0::numeric) inv_ev ON x.job_id IS NULL
  WHERE x.invoice_type = 'ACCREC'::text AND COALESCE(x.job_id, inv_ev.job_id) IS NOT NULL AND (x.status = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text])) AND job_cost_credit_share$nrev4$;
  o_vjp1 text := $ovjp1$        ), collected AS (
         SELECT x.job_id,
$ovjp1$;
  n_vjp1 text := $nvjp1$        ), collected AS (
         SELECT COALESCE(x.job_id, inv_ev.job_id) AS job_id,
$nvjp1$;
  o_vjp2 text := $ovjp2$           FROM xero_invoices x
          WHERE x.invoice_type = 'ACCREC'::text AND x.job_id IS NOT NULL AND (x.status = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text]))
          GROUP BY x.job_id
        ), super_unknown_lines AS ($ovjp2$;
  n_vjp2 text := $nvjp2$           FROM xero_invoices x
             LEFT JOIN LATERAL ( SELECT CASE WHEN count(*) > 0 AND count(*) = count(e.job_id) AND count(DISTINCT e.job_id) = 1 THEN (array_agg(e.job_id))[1] ELSE NULL::uuid END AS job_id FROM jsonb_array_elements(CASE WHEN jsonb_typeof(x.line_items) = 'array'::text THEN x.line_items ELSE '[]'::jsonb END) l(value) LEFT JOIN v_bookkeeping_line_evidence_current e ON e.xero_invoice_id = x.xero_invoice_id AND e.xero_line_item_id = (l.value ->> 'LineItemID'::text) AND e.allocation = 'job'::text AND e.evidenced AND e.job_id IS NOT NULL WHERE COALESCE(job_profit_num(l.value -> 'LineAmount'::text), 0::numeric) <> 0::numeric) inv_ev ON x.job_id IS NULL
          WHERE x.invoice_type = 'ACCREC'::text AND COALESCE(x.job_id, inv_ev.job_id) IS NOT NULL AND (x.status = ANY (ARRAY['AUTHORISED'::text, 'PAID'::text]))
          GROUP BY (COALESCE(x.job_id, inv_ev.job_id))
        ), super_unknown_lines AS ($nvjp2$;
  o_many1 text := $omany1$  SELECT l.invoice_job_id AS job_id, 'invoice_line'::text AS kind,$omany1$;
  n_many1 text := $nmany1$  SELECT COALESCE(l.invoice_job_id, CASE WHEN e.allocation = 'job' AND e.evidenced THEN e.job_id END) AS job_id, 'invoice_line'::text AS kind,$nmany1$;
  o_many2 text := $omany2$  WHERE l.invoice_type = 'ACCREC' AND l.invoice_job_id IN (SELECT j.job_id FROM jobs_in j)$omany2$;
  n_many2 text := $nmany2$  WHERE l.invoice_type = 'ACCREC'
    AND COALESCE(l.invoice_job_id, CASE WHEN e.allocation = 'job' AND e.evidenced THEN e.job_id END) IN (SELECT j.job_id FROM jobs_in j)$nmany2$;
  o_many3 text := $omany3$    AND NOT (l.invoice_type = 'ACCREC' AND l.invoice_job_id IS NOT DISTINCT FROM e.job_id)$omany3$;
  n_many3 text := $nmany3$    AND NOT (l.invoice_type = 'ACCREC' AND COALESCE(l.invoice_job_id, e.job_id) IS NOT DISTINCT FROM e.job_id)$nmany3$;
  o_score1 text := $oscore1$  SELECT x.invoice_job_id AS job_id
  FROM xl x WHERE x.invoice_type = 'ACCREC' AND x.invoice_job_id IS NOT NULL
  GROUP BY x.invoice_job_id
  HAVING bool_and(coalesce(x.evidenced, false) AND x.allocation = 'job' AND x.ev_job_id = x.invoice_job_id)$oscore1$;
  n_score1 text := $nscore1$  SELECT COALESCE(x.invoice_job_id, CASE WHEN x.evidenced AND x.allocation = 'job' THEN x.ev_job_id END) AS job_id
  FROM xl x WHERE x.invoice_type = 'ACCREC'
    AND COALESCE(x.invoice_job_id, CASE WHEN x.evidenced AND x.allocation = 'job' THEN x.ev_job_id END) IS NOT NULL
  GROUP BY 1
  HAVING bool_and(coalesce(x.evidenced, false) AND x.allocation = 'job' AND x.ev_job_id = COALESCE(x.invoice_job_id, x.ev_job_id))$nscore1$;
  o_score2 text := $oscore2$  'jobs_with_invoice_lines', (SELECT count(DISTINCT invoice_job_id) FROM xl WHERE invoice_type = 'ACCREC' AND invoice_job_id IS NOT NULL),$oscore2$;
  n_score2 text := $nscore2$  'jobs_with_invoice_lines', (SELECT count(DISTINCT COALESCE(invoice_job_id, CASE WHEN evidenced AND allocation = 'job' THEN ev_job_id END)) FROM xl
                              WHERE invoice_type = 'ACCREC' AND COALESCE(invoice_job_id, CASE WHEN evidenced AND allocation = 'job' THEN ev_job_id END) IS NOT NULL),$nscore2$;
BEGIN
  IF md5(d_rev) = 'aeb851cd8d3d6e807cd7a5d620e020a8' AND md5(d_vjp) = '986aefcd415e62150ea7376a1c21fc17' AND md5(d_many) = 'fa520b9d6721716868c5f2048a367ae5' AND md5(d_score) = '669fe32f975cb22739d8d941e8b61b52' THEN
    RAISE NOTICE 'revenue already follows the ledger for invoices with no job link';
    RETURN;
  END IF;
  IF md5(d_rev) <> 'ac208427bcf489ec12086cc08e3b9289' THEN RAISE EXCEPTION 'v_job_revenue_events is not the definition this was written against (md5 %)', md5(d_rev); END IF;
  IF md5(d_vjp) <> '4ab42d7dda7e77b8e3dfc984833a5265' THEN RAISE EXCEPTION 'v_job_profit is not the definition this was written against (md5 %)', md5(d_vjp); END IF;
  IF md5(d_many) <> 'e7b5a2cdfd91d2f2fb551c304e264e9e' THEN RAISE EXCEPTION 'job_profit_line_evidence_many is not the definition this was written against (md5 %)', md5(d_many); END IF;
  IF md5(d_score) <> 'a41b54e38ca038a8595eb1aac158d1c4' THEN RAISE EXCEPTION 'job_profit_line_evidence_score is not the definition this was written against (md5 %)', md5(d_score); END IF;
  IF (length(d_rev) - length(replace(d_rev, o_rev1, ''))) / length(o_rev1) <> 1 THEN
    RAISE EXCEPTION 'v_job_revenue_events: fragment 1 is not there exactly once';
  END IF;
  IF (length(d_rev) - length(replace(d_rev, o_rev2, ''))) / length(o_rev2) <> 1 THEN
    RAISE EXCEPTION 'v_job_revenue_events: fragment 2 is not there exactly once';
  END IF;
  IF (length(d_rev) - length(replace(d_rev, o_rev3, ''))) / length(o_rev3) <> 1 THEN
    RAISE EXCEPTION 'v_job_revenue_events: fragment 3 is not there exactly once';
  END IF;
  IF (length(d_rev) - length(replace(d_rev, o_rev4, ''))) / length(o_rev4) <> 1 THEN
    RAISE EXCEPTION 'v_job_revenue_events: fragment 4 is not there exactly once';
  END IF;
  IF (length(d_vjp) - length(replace(d_vjp, o_vjp1, ''))) / length(o_vjp1) <> 1 THEN
    RAISE EXCEPTION 'v_job_profit: fragment 1 is not there exactly once';
  END IF;
  IF (length(d_vjp) - length(replace(d_vjp, o_vjp2, ''))) / length(o_vjp2) <> 1 THEN
    RAISE EXCEPTION 'v_job_profit: fragment 2 is not there exactly once';
  END IF;
  IF (length(d_many) - length(replace(d_many, o_many1, ''))) / length(o_many1) <> 1 THEN
    RAISE EXCEPTION 'job_profit_line_evidence_many: fragment 1 is not there exactly once';
  END IF;
  IF (length(d_many) - length(replace(d_many, o_many2, ''))) / length(o_many2) <> 1 THEN
    RAISE EXCEPTION 'job_profit_line_evidence_many: fragment 2 is not there exactly once';
  END IF;
  IF (length(d_many) - length(replace(d_many, o_many3, ''))) / length(o_many3) <> 1 THEN
    RAISE EXCEPTION 'job_profit_line_evidence_many: fragment 3 is not there exactly once';
  END IF;
  IF (length(d_score) - length(replace(d_score, o_score1, ''))) / length(o_score1) <> 1 THEN
    RAISE EXCEPTION 'job_profit_line_evidence_score: fragment 1 is not there exactly once';
  END IF;
  IF (length(d_score) - length(replace(d_score, o_score2, ''))) / length(o_score2) <> 1 THEN
    RAISE EXCEPTION 'job_profit_line_evidence_score: fragment 2 is not there exactly once';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_revenue_events AS ' || replace(replace(replace(replace(d_rev, o_rev1, n_rev1), o_rev2, n_rev2), o_rev3, n_rev3), o_rev4, n_rev4);
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_profit AS ' || replace(replace(d_vjp, o_vjp1, n_vjp1), o_vjp2, n_vjp2);
  EXECUTE replace(replace(replace(d_many, o_many1, n_many1), o_many2, n_many2), o_many3, n_many3);
  EXECUTE replace(replace(d_score, o_score1, n_score1), o_score2, n_score2);
  IF md5(pg_get_viewdef('public.v_job_revenue_events'::regclass, true)) <> 'aeb851cd8d3d6e807cd7a5d620e020a8' THEN RAISE EXCEPTION 'v_job_revenue_events after the change is not the rehearsed definition (md5 %)', md5(pg_get_viewdef('public.v_job_revenue_events'::regclass, true)); END IF;
  IF md5(pg_get_viewdef('public.v_job_profit'::regclass, true)) <> '986aefcd415e62150ea7376a1c21fc17' THEN RAISE EXCEPTION 'v_job_profit after the change is not the rehearsed definition (md5 %)', md5(pg_get_viewdef('public.v_job_profit'::regclass, true)); END IF;
  IF md5(pg_get_functiondef('public.job_profit_line_evidence_many(uuid[])'::regprocedure)) <> 'fa520b9d6721716868c5f2048a367ae5' THEN RAISE EXCEPTION 'job_profit_line_evidence_many after the change is not the rehearsed definition (md5 %)', md5(pg_get_functiondef('public.job_profit_line_evidence_many(uuid[])'::regprocedure)); END IF;
  IF md5(pg_get_functiondef('public.job_profit_line_evidence_score(date,date)'::regprocedure)) <> '669fe32f975cb22739d8d941e8b61b52' THEN RAISE EXCEPTION 'job_profit_line_evidence_score after the change is not the rehearsed definition (md5 %)', md5(pg_get_functiondef('public.job_profit_line_evidence_score(date,date)'::regprocedure)); END IF;
END
$mig$;
