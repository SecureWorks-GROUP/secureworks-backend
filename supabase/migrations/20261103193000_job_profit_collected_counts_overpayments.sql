-- Finish line C5 (3 Nov 2026): Job Profit's "collected" counts an overpayment or prepayment applied to an invoice.
--
-- v_job_profit's collected CTE counted xero_invoices.amount_paid only. Xero records money settled from an earlier
-- overpayment or prepayment as an allocation (raw_json Overpayments / Prepayments, AppliedAmount), not in
-- AmountPaid, so a fully settled invoice looked partly unpaid on the Job Profit page. Example SWP-26320 INV-1619:
-- total 4,222.90, paid 3,932.06, overpayment applied 290.84, Xero due 0.00; the page implied 264.40 ex GST not
-- collected. Credit notes are not money received and stay out (they already reduce invoiced through
-- v_job_revenue_events). On 3 Nov 2 customer invoices carry an overpayment allocation and none a prepayment.
--
-- Change: in the collected CTE, amount_paid becomes amount_paid plus the AppliedAmount of the invoice's Overpayments
-- and Prepayments. Everything else in the view is byte for byte the live definition.
-- Guard: v_job_profit must be the 20261103171500 definition (md5 4ab42d7d..., pg_get_viewdef(..., true), UTC).
-- Rehearsed on production 3 Nov 07:29Z (rolled back): 2 of 2,008 jobs change, collected only (SWP-26320 6,645.80 to
-- 6,910.20, SW1797 5,748.77 to 5,793.00); profit, invoiced and margin unchanged; md5 after ae9981a2...; the undo
-- returns 4ab42d7d.
-- Rollback: supabase/rollbacks/20261103193000_job_profit_collected_counts_overpayments_down.sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL TimeZone = 'UTC';

DO $mig$
DECLARE
  v_def text := pg_get_viewdef('public.v_job_profit'::regclass, true);
  v_old text := $o$                    WHEN COALESCE(x.total, 0::numeric) <> 0::numeric THEN x.amount_paid * x.sub_total / x.total
                    ELSE x.amount_paid
                END) AS collected_ex$o$;
  v_new text := $n$                    WHEN COALESCE(x.total, 0::numeric) <> 0::numeric THEN (x.amount_paid + COALESCE(( SELECT sum((a.value ->> 'AppliedAmount')::numeric) AS sum
                       FROM jsonb_array_elements(COALESCE(x.raw_json -> 'Overpayments', '[]'::jsonb) || COALESCE(x.raw_json -> 'Prepayments', '[]'::jsonb)) a(value)
                      WHERE jsonb_typeof(a.value) = 'object'::text), 0::numeric)) * x.sub_total / x.total
                    ELSE x.amount_paid + COALESCE(( SELECT sum((a.value ->> 'AppliedAmount')::numeric) AS sum
                       FROM jsonb_array_elements(COALESCE(x.raw_json -> 'Overpayments', '[]'::jsonb) || COALESCE(x.raw_json -> 'Prepayments', '[]'::jsonb)) a(value)
                      WHERE jsonb_typeof(a.value) = 'object'::text), 0::numeric)
                END) AS collected_ex$n$;
BEGIN
  IF strpos(v_def, 'Overpayments') > 0 THEN
    RAISE NOTICE 'v_job_profit already counts overpayment and prepayment allocations as collected';
    RETURN;
  END IF;
  IF md5(v_def) <> '4ab42d7dda7e77b8e3dfc984833a5265' THEN
    RAISE EXCEPTION 'v_job_profit is not the definition this migration was written against (md5 %)', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'v_job_profit: the collected rule is not there exactly once';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_profit AS ' || replace(v_def, v_old, v_new);
  IF md5(pg_get_viewdef('public.v_job_profit'::regclass, true)) <> 'ae9981a2bfeed9e88cb9f270a4c8bf2f' THEN
    RAISE EXCEPTION 'v_job_profit after the change is not the rehearsed definition (md5 %)', md5(pg_get_viewdef('public.v_job_profit'::regclass, true));
  END IF;
END
$mig$;
