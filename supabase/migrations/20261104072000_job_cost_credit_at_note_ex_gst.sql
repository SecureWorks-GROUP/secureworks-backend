-- (Job Profit, finish-line row A6, 3 Nov 2026) Rule 3 of 3: a supplier credit is taken at the credit note's own
-- ex-GST amount (its line amounts and tax as Xero states them), never recomputed from the inc-GST total.
--
-- Found by verify/scripts/a6_live_costs.py (3 Nov 11:50Z): Bunnings credit note 2435/01472242 is 91.32 ex GST
-- (100.44 inc, tax 9.12) applied in full to bill 2435/01472242 on SWMS-26893; Job Profit took 100.44 / 148.15 of
-- each bill line and rounded each line, -91.31.
-- Change, in v_job_cost_events only:
--   * a bill's credit share is the credit in ex-GST terms over the bill's ex-GST sub total: each listed credit
--     note's applied amount at that note's own rate (sub total / total, job_cost_credit_ex), the bill's rate only
--     when our copy does not hold the note; the share Bookkeeping's ledger places elsewhere is taken off at the
--     same rate. Bills with no readable credit-note list (AmountCredited only) keep the existing rule;
--   * the credit-note path (a credit our copy of the bill does not show) takes each allocation at the note's own
--     rate too (job_cost_credit_note_part_ex);
--   * a bill's credit rows are rounded as a running total (each row's cents = rounded running total less the
--     rounded running total before it), so one bill's rows add up to the credit's own cents.
--
-- Guard: v_job_cost_events must be the definition this was written against (md5 8f9de7093e1998941320e088eab39ff0,
-- pg_get_viewdef(..., true)); after the change it must be 25143b7d28aae47cd44a16323fa99389. Re-running it is a no-op (also
-- once a later migration of this set, 20261104070000 to 20261104072000, has changed the view).
-- Rollback: supabase/rollbacks/20261104072000_job_cost_credit_at_note_ex_gst_down.sql (embeds the exact earlier definition).
-- Rehearsed 3 Nov 2026 on production, rolled back (CIO helper, Claude): 8 jobs move by one cent, net -0.04, each
-- onto its credit notes' own ex-GST share (8 of 8 checked by hand): SWMS-26893 253.37 to 253.36 (Bunnings
-- 2435/01472242), SW1895, SWF-26033, SWF-261132, SWF-261600, SWF-26179, SWF-26824, SWF-26997. Margins 355 to 355.
-- All three together: 15 jobs, total job cost (v_job_profit) 778,077.27 to 778,367.63; v_job_cost_events actual
-- 789,002.90 to 789,293.25.

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.job_cost_credit_ex(p_credit_inc numeric, p_credit_note_id text, p_xero_invoice_id text)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- An amount (inc GST) of a supplier credit note, ex GST at the credit note's own rate (its sub total over its
  -- total, as Xero states them); the bill's own rate only when our copy does not hold the credit note.
  SELECT COALESCE(
    (SELECT p_credit_inc * n.sub_total / n.total FROM public.xero_supplier_credit_notes n
      WHERE n.xero_credit_note_id = p_credit_note_id AND n.total > 0 AND n.sub_total IS NOT NULL
      ORDER BY n.org_id LIMIT 1),
    (SELECT p_credit_inc * x.sub_total / x.total FROM public.xero_invoices x
      WHERE x.xero_invoice_id = p_xero_invoice_id AND x.invoice_type = 'ACCPAY' AND x.total > 0 AND x.sub_total IS NOT NULL
      ORDER BY x.org_id LIMIT 1))
$function$;

CREATE OR REPLACE FUNCTION public.job_cost_credit_note_part_ex(p_row_ex numeric, p_allocation_inc numeric, p_credit_note_id text, p_xero_invoice_id text)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- One bill row's share (unrounded) of a credit note allocation: the allocation ex GST at the credit note's own
  -- rate, shared by the row's ex-GST amount over the bill's ex-GST sub total.
  SELECT CASE
    WHEN b.sub_total > 0 THEN p_row_ex * public.job_cost_credit_ex(p_allocation_inc, p_credit_note_id, p_xero_invoice_id) / b.sub_total
    WHEN b.total > 0 THEN p_row_ex * p_allocation_inc / b.total
  END
  FROM (SELECT (SELECT x.sub_total FROM public.xero_invoices x WHERE x.xero_invoice_id = p_xero_invoice_id AND x.invoice_type = 'ACCPAY' ORDER BY x.org_id LIMIT 1) AS sub_total,
               (SELECT x.total FROM public.xero_invoices x WHERE x.xero_invoice_id = p_xero_invoice_id AND x.invoice_type = 'ACCPAY' ORDER BY x.org_id LIMIT 1) AS total) b
$function$;
REVOKE ALL ON FUNCTION public.job_cost_credit_ex(numeric, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_cost_credit_note_part_ex(numeric, numeric, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_cost_credit_ex(numeric, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.job_cost_credit_note_part_ex(numeric, numeric, text, text) TO service_role;

DO $mig$
DECLARE
  v_def text;
  o1 text := $o1$         SELECT a.xero_invoice_id,
            sum(a.amount * l.share_placed) AS applied_moved
           FROM v_supplier_credit_allocations a
             JOIN ledger_cn_note l ON l.xero_credit_note_id = a.xero_credit_note_id
          WHERE a.state = 'bill_live'::text AND (a.bill_side = ANY (ARRAY['counts_it'::text, 'amount_credited'::text]))
          GROUP BY a.xero_invoice_id
        ), $o1$;
  n1 text := $n1$         SELECT a.xero_invoice_id,
            sum(a.amount * l.share_placed) AS applied_moved,
            sum(job_cost_credit_ex(a.amount * l.share_placed, a.xero_credit_note_id, a.xero_invoice_id)) AS applied_moved_ex
           FROM v_supplier_credit_allocations a
             JOIN ledger_cn_note l ON l.xero_credit_note_id = a.xero_credit_note_id
          WHERE a.state = 'bill_live'::text AND (a.bill_side = ANY (ARRAY['counts_it'::text, 'amount_credited'::text]))
          GROUP BY a.xero_invoice_id
        ), bill_credit AS (
         SELECT x.xero_invoice_id,
                CASE
                    WHEN x.sub_total > 0::numeric AND cn.listed THEN GREATEST(LEAST(GREATEST(cn.applied_ex / x.sub_total, 0::numeric), 1::numeric) - COALESCE(m.applied_moved_ex, 0::numeric) / x.sub_total, 0::numeric)
                    ELSE GREATEST(job_cost_credit_share(x.raw_json, x.total) - COALESCE(m.applied_moved, 0::numeric) / NULLIF(x.total, 0::numeric), 0::numeric)
                END AS credit_share
           FROM xero_invoices x
             LEFT JOIN ledger_cn_bill m ON m.xero_invoice_id = x.xero_invoice_id
             CROSS JOIN LATERAL ( SELECT count(*) > 0 AND bool_and(job_profit_num(c.value -> 'AppliedAmount'::text) IS NOT NULL) AS listed,
                    sum(job_cost_credit_ex(job_profit_num(c.value -> 'AppliedAmount'::text), COALESCE(c.value ->> 'CreditNoteID'::text, c.value ->> 'ID'::text), x.xero_invoice_id)) AS applied_ex
                   FROM jsonb_array_elements(
                        CASE
                            WHEN jsonb_typeof(x.raw_json -> 'CreditNotes'::text) = 'array'::text THEN x.raw_json -> 'CreditNotes'::text
                            ELSE '[]'::jsonb
                        END) c(value)) cn
          WHERE x.invoice_type = 'ACCPAY'::text AND job_cost_credit_share(x.raw_json, x.total) > 0::numeric
        ), $n1$;
  o2 text := $o2$                    GREATEST(job_cost_credit_share(x.raw_json, x.total) - COALESCE(( SELECT m.applied_moved
                           FROM ledger_cn_bill m
                          WHERE m.xero_invoice_id = x.xero_invoice_id), 0::numeric) / NULLIF(x.total, 0::numeric), 0::numeric) AS credit_share
$o2$;
  n2 text := $n2$                    COALESCE(( SELECT c.credit_share
                           FROM bill_credit c
                          WHERE c.xero_invoice_id = x.xero_invoice_id
                         LIMIT 1), 0::numeric) AS credit_share
$n2$;
  o3 text := $o3$            GREATEST(job_cost_credit_share(x.raw_json, x.total) - COALESCE(( SELECT m.applied_moved
                   FROM ledger_cn_bill m
                  WHERE m.xero_invoice_id = x.xero_invoice_id), 0::numeric) / NULLIF(x.total, 0::numeric), 0::numeric) AS credit_share,
$o3$;
  n3 text := $n3$            COALESCE(( SELECT c.credit_share
                   FROM bill_credit c
                  WHERE c.xero_invoice_id = x.xero_invoice_id
                 LIMIT 1), 0::numeric) AS credit_share,
$n3$;
  o4 text := $o4$            - round(s.amount_ex * b.credit_share, 2) AS amount_ex,
$o4$;
  n4 text := $n4$            - (round(sum(s.amount_ex * b.credit_share) OVER (PARTITION BY b.xero_invoice_id ORDER BY s.source_id ROWS UNBOUNDED PRECEDING), 2) - COALESCE(round(sum(s.amount_ex * b.credit_share) OVER (PARTITION BY b.xero_invoice_id ORDER BY s.source_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 2), 0::numeric)) AS amount_ex,
$n4$;
  o5 text := $o5$            - round(f.amount_ex * f.credit_share, 2) AS amount_ex,
$o5$;
  n5 text := $n5$            - (round(sum(f.amount_ex * f.credit_share) OVER (PARTITION BY f.document_id ORDER BY f.source_id ROWS UNBOUNDED PRECEDING), 2) - COALESCE(round(sum(f.amount_ex * f.credit_share) OVER (PARTITION BY f.document_id ORDER BY f.source_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 2), 0::numeric)) AS amount_ex,
$n5$;
  o6 text := $o6$            - job_cost_credit_note_part(s.amount_ex, a.amount * (1::numeric - COALESCE(( SELECT l.share_placed
                   FROM ledger_cn_note l
                  WHERE l.xero_credit_note_id = a.xero_credit_note_id), 0::numeric)), a.bill_total) AS amount_ex,
$o6$;
  n6 text := $n6$            - (round(sum(job_cost_credit_note_part_ex(s.amount_ex, a.amount * (1::numeric - COALESCE(( SELECT l.share_placed FROM ledger_cn_note l WHERE l.xero_credit_note_id = a.xero_credit_note_id), 0::numeric)), a.xero_credit_note_id, a.xero_invoice_id)) OVER (PARTITION BY s.document_id, a.xero_credit_note_id, a.allocation_n ORDER BY s.source_id ROWS UNBOUNDED PRECEDING), 2) - COALESCE(round(sum(job_cost_credit_note_part_ex(s.amount_ex, a.amount * (1::numeric - COALESCE(( SELECT l.share_placed FROM ledger_cn_note l WHERE l.xero_credit_note_id = a.xero_credit_note_id), 0::numeric)), a.xero_credit_note_id, a.xero_invoice_id)) OVER (PARTITION BY s.document_id, a.xero_credit_note_id, a.allocation_n ORDER BY s.source_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 2), 0::numeric)) AS amount_ex,
$n6$;
BEGIN
  v_def := pg_get_viewdef('public.v_job_cost_events'::regclass, true);
  IF md5(v_def) IN ('25143b7d28aae47cd44a16323fa99389') THEN
    RAISE NOTICE 'v_job_cost_events already has 20261104072000 (or a later change of this set)';
    RETURN;
  END IF;
  IF md5(v_def) <> '8f9de7093e1998941320e088eab39ff0' THEN
    RAISE EXCEPTION 'v_job_cost_events is not the definition this migration was written against (md5 %)', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, o1, ''))) / length(o1) <> 1 THEN
    RAISE EXCEPTION 'v_job_cost_events: change 1 of 6 does not find its text exactly once';
  END IF;
  v_def := replace(v_def, o1, n1);
  IF (length(v_def) - length(replace(v_def, o2, ''))) / length(o2) <> 1 THEN
    RAISE EXCEPTION 'v_job_cost_events: change 2 of 6 does not find its text exactly once';
  END IF;
  v_def := replace(v_def, o2, n2);
  IF (length(v_def) - length(replace(v_def, o3, ''))) / length(o3) <> 1 THEN
    RAISE EXCEPTION 'v_job_cost_events: change 3 of 6 does not find its text exactly once';
  END IF;
  v_def := replace(v_def, o3, n3);
  IF (length(v_def) - length(replace(v_def, o4, ''))) / length(o4) <> 1 THEN
    RAISE EXCEPTION 'v_job_cost_events: change 4 of 6 does not find its text exactly once';
  END IF;
  v_def := replace(v_def, o4, n4);
  IF (length(v_def) - length(replace(v_def, o5, ''))) / length(o5) <> 1 THEN
    RAISE EXCEPTION 'v_job_cost_events: change 5 of 6 does not find its text exactly once';
  END IF;
  v_def := replace(v_def, o5, n5);
  IF (length(v_def) - length(replace(v_def, o6, ''))) / length(o6) <> 1 THEN
    RAISE EXCEPTION 'v_job_cost_events: change 6 of 6 does not find its text exactly once';
  END IF;
  v_def := replace(v_def, o6, n6);
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_cost_events AS ' || v_def;
  IF md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true)) <> '25143b7d28aae47cd44a16323fa99389' THEN
    RAISE EXCEPTION 'v_job_cost_events after the change is not the rehearsed definition (md5 %)', md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true));
  END IF;
END
$mig$;
