-- INT-10 acceptance: five real jobs, each placed bill's engine count beside
-- what the job card's bill read (context_job_bill_outcomes) says.
--
-- READ ONLY. Run it after 20261029170000 and 20261029170100 are applied, as
-- the service role, then compare each row with the bill in Xero (its number,
-- status and ex GST total) and with Job Profit for that job. It writes
-- nothing: the transaction is read only, capped at 30 s, with JIT off
-- (compiling the engine plan costs seconds), and ends when the session does.
-- The SELECT is the final result set.
--
-- Which five jobs (fixed in advance, never picked for a good result): every
-- job Job Profit reads (legacy IS NOT TRUE) that is not a holding job
-- (metadata.do_not_schedule not true) and has at least one supplier bill
-- placed on it (an ACCPAY Xero link, or an actual allocation row in
-- job_materials_facts), ordered by md5('int-10-acceptance-v1:' || job id),
-- first five. The order is a fixed shuffle of the ids: it does not look at
-- bill counts, states or amounts, and anyone re-running it gets the same five
-- while the set of jobs with bills is the same.
--
-- One row per job and bill on the card:
--   job_number, invoice_number, supplier, xero_status, xero_ex (Xero's ex GST
--   total, to check against Xero), line_amount_types;
--   engine_counted_here / engine_counted_here_ex: v_job_cost_events' actual
--   supplier rows of this bill on this job (the rows v_job_profit sums);
--   engine_counted_elsewhere: the other jobs Job Profit reads (not legacy)
--   that the engine counts it on, as job_number=amount ex GST;
--   card_where_counted, card_counts, card_reason, card_bill_state,
--   card_mirror_bill, card_other_jobs: the card's read, as served;
--   agrees: whether the card's where_counted matches the engine rows. Null
--   where the card says held, unknown or trade_app: those are not a count,
--   and the person checking decides them against Xero.
BEGIN;
SET TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL jit = off;
SET LOCAL ROLE service_role;
WITH placed AS (
  SELECT x.job_id, x.xero_invoice_id FROM public.xero_invoices x
   WHERE x.invoice_type = 'ACCPAY' AND x.job_id IS NOT NULL AND x.xero_invoice_id IS NOT NULL
  UNION
  SELECT f.job_id, f.xero_invoice_id FROM public.job_materials_facts f
   WHERE f.kind = 'actual' AND f.job_id IS NOT NULL AND f.xero_invoice_id IS NOT NULL
), picked AS (
  SELECT j.id AS job_id, j.job_number
    FROM public.jobs j
   WHERE j.legacy IS NOT TRUE
     AND coalesce(j.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1')
     AND EXISTS (SELECT 1 FROM placed p WHERE p.job_id = j.id)
   ORDER BY md5('int-10-acceptance-v1:' || j.id::text)
   LIMIT 5
), card AS (
  SELECT k.job_id, k.job_number, b.value AS bill
    FROM picked k
    CROSS JOIN LATERAL jsonb_array_elements(public.context_job_bill_outcomes(k.job_id) -> 'bills') b
), engine AS (
  SELECT e.document_id AS xero_invoice_id, e.job_id, sum(e.amount_ex) AS counted_ex
    FROM public.v_job_cost_events e
    JOIN public.jobs ej ON ej.id = e.job_id AND ej.legacy IS NOT TRUE
   WHERE e.is_actual AND e.party_kind = 'supplier'
     AND e.source IN ('supplier_bill', 'materials_fact', 'supplier_credit',
                      'installer_bill_unconfirmed', 'installer_bill_not_job_related')
     AND e.document_id IN (SELECT c.bill ->> 'xero_invoice_id' FROM card c)
   GROUP BY e.document_id, e.job_id
), compared AS (
  SELECT c.job_number,
         c.bill ->> 'invoice_number' AS invoice_number,
         c.bill ->> 'supplier' AS supplier,
         c.bill ->> 'xero_invoice_id' AS xero_invoice_id,
         x.status AS xero_status,
         round(x.sub_total, 2) AS xero_ex,
         x.raw_json ->> 'LineAmountTypes' AS line_amount_types,
         (h.counted_ex IS NOT NULL) AS engine_counted_here,
         round(h.counted_ex, 2) AS engine_counted_here_ex,
         (SELECT string_agg(coalesce(oj.job_number, o.job_id::text) || '=' || round(o.counted_ex, 2)::text, ', '
                            ORDER BY coalesce(oj.job_number, o.job_id::text) COLLATE "C")
            FROM engine o LEFT JOIN public.jobs oj ON oj.id = o.job_id
           WHERE o.xero_invoice_id = c.bill ->> 'xero_invoice_id' AND o.job_id <> c.job_id) AS engine_counted_elsewhere,
         EXISTS (SELECT 1 FROM engine o WHERE o.xero_invoice_id = c.bill ->> 'xero_invoice_id' AND o.job_id <> c.job_id)
           AS engine_any_elsewhere,
         c.bill ->> 'where_counted' AS card_where_counted,
         c.bill #>> '{here,counts}' AS card_counts,
         c.bill #>> '{here,reason}' AS card_reason,
         c.bill ->> 'bill_state' AS card_bill_state,
         c.bill ->> 'mirror_bill' AS card_mirror_bill,
         (SELECT string_agg(concat(oj.value ->> 'job_number', ':', oj.value ->> 'counts'), ', '
                            ORDER BY oj.value ->> 'job_number' COLLATE "C")
            FROM jsonb_array_elements(c.bill -> 'other_jobs') oj) AS card_other_jobs
    FROM card c
    LEFT JOIN LATERAL (SELECT x1.* FROM public.xero_invoices x1
                        WHERE x1.xero_invoice_id = c.bill ->> 'xero_invoice_id' AND x1.invoice_type = 'ACCPAY'
                        ORDER BY x1.updated_at DESC NULLS LAST LIMIT 1) x ON true
    LEFT JOIN engine h ON h.xero_invoice_id = c.bill ->> 'xero_invoice_id' AND h.job_id = c.job_id
)
SELECT job_number, invoice_number, supplier, xero_invoice_id, xero_status, xero_ex, line_amount_types,
       engine_counted_here, engine_counted_here_ex, engine_counted_elsewhere,
       card_where_counted, card_counts, card_reason, card_bill_state, card_mirror_bill, card_other_jobs,
       CASE WHEN card_where_counted IN ('held', 'unknown', 'trade_app') THEN NULL
            ELSE card_where_counted = CASE
                   WHEN engine_counted_here AND engine_any_elsewhere THEN 'here_and_elsewhere'
                   WHEN engine_counted_here THEN 'here'
                   WHEN engine_any_elsewhere THEN 'elsewhere'
                   ELSE 'no_job' END
       END AS agrees
  FROM compared
 ORDER BY job_number COLLATE "C", invoice_number COLLATE "C", xero_invoice_id COLLATE "C";
