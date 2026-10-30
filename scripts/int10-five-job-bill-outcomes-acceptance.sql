-- INT-10 acceptance: five real jobs, every bill the job card should list set
-- against the bills it does list (context_job_bill_outcomes), both ways.
--
-- READ ONLY. Run it after 20261029170000 and 20261029170100 are applied, as
-- the service role, then compare each row with the bill in Xero (its number,
-- status and ex GST total) and with Job Profit for that job. It writes
-- nothing: the transaction is read only, capped at 30 s, with JIT off
-- (compiling the engine plan costs seconds), and ends when the session does.
-- The SELECT is the final result set.
--
-- Which five jobs (fixed in advance, never picked for a good result): every
-- job Job Profit reads (legacy IS NOT TRUE) that is not a holding job, by the
-- Job Profit engine's own rule (v_job_profit.holding_job:
-- lower(do_not_schedule) = 'true'), and has at least one supplier bill placed
-- on it (an ACCPAY Xero link, or an actual allocation row in
-- job_materials_facts), ordered by md5('int-10-acceptance-v1:' || job id),
-- first five. The order is a fixed shuffle of the ids: it does not look at
-- bill counts, states or amounts, and anyone re-running it gets the same five
-- while the set of jobs with bills is the same.
--
-- The expected bills of a picked job (step expected): every bill placed on it
-- (its Xero link, or an actual allocation row) and every bill the engine
-- counts on it (v_job_cost_events' actual supplier rows on that job), whether
-- or not the card lists it. One exclusion, made in its own step
-- (mirror_excluded) and shown on its row: a trade-app mirror bill (the
-- engine's mirror test, as CFO's view restates it: a trade invoice's Xero bill,
-- or a line described '| SW - <trade>') that no person placed on any job
-- (no manual_queue or manual_split allocation row). CFO's view lists such a
-- bill nowhere, because its cost counts through the trade app's own lines, so
-- the card is right to leave it out; it is listed here as excluded, and it is
-- a failure only if the card shows it.
--
-- One row per picked job and bill, expected or on the card (a full join), and
-- one row for a picked job that has neither, so all five jobs always show:
--   proof: on_card (expected and listed), missing_from_card (expected, the
--     card leaves it out), extra_on_card (listed, not expected, or an
--     excluded mirror the card shows), excluded_mirror (expected by placement,
--     left out on purpose, see above), job_has_no_rows (a picked job with no
--     expected bill and nothing on the card);
--   failure: true for missing_from_card, extra_on_card and job_has_no_rows;
--   job_failures: the failures on that job;
--   expected_because: xero_link, actual_row, engine_counts (any of them);
--   mirror_exclusion: why a bill is excluded, else null;
--   job_number, invoice_number, supplier, xero_invoice_id, xero_status,
--   xero_ex (Xero's ex GST total, to check against Xero), line_amount_types;
--   engine_counted_here / engine_counted_here_ex: the engine's actual supplier
--   rows of this bill on this job (the rows v_job_profit sums);
--   engine_counted_elsewhere: the other jobs Job Profit reads (not legacy)
--   that the engine counts it on, as job_number=amount ex GST;
--   card_where_counted, card_counts, card_reason, card_bill_state,
--   card_mirror_bill, card_other_jobs: the card's read, as served;
--   agrees: for a bill on the card, whether its where_counted matches the
--   engine rows. Null where the card says held, unknown or trade_app (those
--   are not a count, and the person checking decides them against Xero) and
--   on a row that is not on the card.
BEGIN;
SET TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL jit = off;
SET LOCAL ROLE service_role;
WITH placed AS (
  SELECT x.job_id, x.xero_invoice_id, 'xero_link'::text AS why FROM public.xero_invoices x
   WHERE x.invoice_type = 'ACCPAY' AND x.job_id IS NOT NULL AND x.xero_invoice_id IS NOT NULL
  UNION
  SELECT f.job_id, f.xero_invoice_id, 'actual_row' FROM public.job_materials_facts f
   WHERE f.kind = 'actual' AND f.job_id IS NOT NULL AND f.xero_invoice_id IS NOT NULL
), picked AS (
  SELECT j.id AS job_id, j.job_number
    FROM public.jobs j
   WHERE j.legacy IS NOT TRUE
     AND lower(COALESCE(j.metadata ->> 'do_not_schedule', '')) <> 'true'
     AND EXISTS (SELECT 1 FROM placed p WHERE p.job_id = j.id)
   ORDER BY md5('int-10-acceptance-v1:' || j.id::text)
   LIMIT 5
), card AS (
  SELECT k.job_id, b.value ->> 'xero_invoice_id' AS xero_invoice_id, b.value AS bill
    FROM picked k
    CROSS JOIN LATERAL jsonb_array_elements(public.context_job_bill_outcomes(k.job_id) -> 'bills') b
), engine AS (
  -- the engine's actual supplier rows, per bill and job, for every bill that
  -- touches a picked job (counted on it, placed on it, or on its card)
  SELECT e.document_id AS xero_invoice_id, e.job_id, sum(e.amount_ex) AS counted_ex
    FROM public.v_job_cost_events e
    JOIN public.jobs ej ON ej.id = e.job_id AND ej.legacy IS NOT TRUE
   WHERE e.is_actual AND e.party_kind = 'supplier'
     AND e.source IN ('supplier_bill', 'materials_fact', 'supplier_credit',
                      'installer_bill_unconfirmed', 'installer_bill_not_job_related')
     AND e.document_id IS NOT NULL
     AND (e.job_id IN (SELECT k.job_id FROM picked k)
          OR e.document_id IN (SELECT p.xero_invoice_id FROM placed p JOIN picked k ON k.job_id = p.job_id)
          OR e.document_id IN (SELECT c.xero_invoice_id FROM card c))
   GROUP BY e.document_id, e.job_id
), expected_raw AS (
  SELECT p.job_id, p.xero_invoice_id, p.why FROM placed p JOIN picked k ON k.job_id = p.job_id
  UNION
  SELECT g.job_id, g.xero_invoice_id, 'engine_counts' FROM engine g JOIN picked k ON k.job_id = g.job_id
), mirror_excluded AS (
  -- the one deliberate exclusion: a trade-app mirror no person placed on any job
  SELECT DISTINCT x.xero_invoice_id
    FROM public.xero_invoices x
   WHERE x.invoice_type = 'ACCPAY'
     AND x.xero_invoice_id IN (SELECT r.xero_invoice_id FROM expected_raw r)
     AND (EXISTS (SELECT 1 FROM public.trade_invoices t WHERE t.xero_bill_id = x.xero_invoice_id)
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(x.line_items) = 'array' THEN x.line_items ELSE '[]'::jsonb END) li
                      WHERE li.value ->> 'Description' ~ '\| SW - [A-Z]'))
     AND NOT EXISTS (SELECT 1 FROM public.job_materials_facts f
                      WHERE f.xero_invoice_id = x.xero_invoice_id AND f.kind = 'actual' AND f.job_id IS NOT NULL
                        AND f.automation_source IN ('manual_queue', 'manual_split'))
), expected AS (
  SELECT r.job_id, r.xero_invoice_id,
         string_agg(r.why, ', ' ORDER BY r.why COLLATE "C") AS expected_because,
         (m.xero_invoice_id IS NOT NULL) AS mirror_excluded
    FROM expected_raw r
    LEFT JOIN mirror_excluded m ON m.xero_invoice_id = r.xero_invoice_id
   GROUP BY r.job_id, r.xero_invoice_id, m.xero_invoice_id
), joined AS (
  SELECT COALESCE(e.job_id, c.job_id) AS job_id,
         COALESCE(e.xero_invoice_id, c.xero_invoice_id) AS xero_invoice_id,
         e.expected_because, COALESCE(e.mirror_excluded, false) AS mirror_excluded,
         (e.job_id IS NOT NULL) AS expected, (c.job_id IS NOT NULL) AS on_card, c.bill
    FROM expected e
    FULL OUTER JOIN card c ON c.job_id = e.job_id AND c.xero_invoice_id IS NOT DISTINCT FROM e.xero_invoice_id
), judged AS (
  SELECT k.job_id, k.job_number, j.xero_invoice_id, j.expected_because, j.mirror_excluded, j.on_card, j.bill,
         CASE
           WHEN j.job_id IS NULL THEN 'job_has_no_rows'
           WHEN j.expected AND j.mirror_excluded AND NOT j.on_card THEN 'excluded_mirror'
           WHEN j.expected AND j.mirror_excluded THEN 'extra_on_card'
           WHEN j.expected AND j.on_card THEN 'on_card'
           WHEN j.expected THEN 'missing_from_card'
           ELSE 'extra_on_card'
         END AS proof
    FROM picked k
    LEFT JOIN joined j ON j.job_id = k.job_id
), compared AS (
  SELECT d.job_number, d.job_id, d.proof,
         d.proof IN ('missing_from_card', 'extra_on_card', 'job_has_no_rows') AS failure,
         d.expected_because,
         CASE WHEN d.mirror_excluded THEN 'trade-app mirror bill no person placed on any job: CFO''s view lists it nowhere (its cost counts through the trade app''s lines)' END AS mirror_exclusion,
         COALESCE(d.bill ->> 'invoice_number', x.invoice_number) AS invoice_number,
         COALESCE(d.bill ->> 'supplier', x.contact_name) AS supplier,
         d.xero_invoice_id,
         x.status AS xero_status,
         round(x.sub_total, 2) AS xero_ex,
         x.raw_json ->> 'LineAmountTypes' AS line_amount_types,
         (h.counted_ex IS NOT NULL) AS engine_counted_here,
         round(h.counted_ex, 2) AS engine_counted_here_ex,
         (SELECT string_agg(coalesce(oj.job_number, o.job_id::text) || '=' || round(o.counted_ex, 2)::text, ', '
                            ORDER BY coalesce(oj.job_number, o.job_id::text) COLLATE "C")
            FROM engine o LEFT JOIN public.jobs oj ON oj.id = o.job_id
           WHERE o.xero_invoice_id = d.xero_invoice_id AND o.job_id <> d.job_id) AS engine_counted_elsewhere,
         EXISTS (SELECT 1 FROM engine o WHERE o.xero_invoice_id = d.xero_invoice_id AND o.job_id <> d.job_id)
           AS engine_any_elsewhere,
         d.on_card,
         d.bill ->> 'where_counted' AS card_where_counted,
         d.bill #>> '{here,counts}' AS card_counts,
         d.bill #>> '{here,reason}' AS card_reason,
         d.bill ->> 'bill_state' AS card_bill_state,
         d.bill ->> 'mirror_bill' AS card_mirror_bill,
         (SELECT string_agg(concat(oj.value ->> 'job_number', ':', oj.value ->> 'counts'), ', '
                            ORDER BY oj.value ->> 'job_number' COLLATE "C")
            FROM jsonb_array_elements(d.bill -> 'other_jobs') oj) AS card_other_jobs
    FROM judged d
    LEFT JOIN LATERAL (SELECT x1.* FROM public.xero_invoices x1
                        WHERE x1.xero_invoice_id = d.xero_invoice_id AND x1.invoice_type = 'ACCPAY'
                        ORDER BY x1.updated_at DESC NULLS LAST LIMIT 1) x ON true
    LEFT JOIN engine h ON h.xero_invoice_id = d.xero_invoice_id AND h.job_id = d.job_id
)
SELECT job_number, proof, failure,
       count(*) FILTER (WHERE failure) OVER (PARTITION BY job_id) AS job_failures,
       expected_because, mirror_exclusion,
       invoice_number, supplier, xero_invoice_id, xero_status, xero_ex, line_amount_types,
       engine_counted_here, engine_counted_here_ex, engine_counted_elsewhere,
       card_where_counted, card_counts, card_reason, card_bill_state, card_mirror_bill, card_other_jobs,
       CASE WHEN on_card IS NOT TRUE OR card_where_counted IN ('held', 'unknown', 'trade_app') THEN NULL
            ELSE card_where_counted = CASE
                   WHEN engine_counted_here AND engine_any_elsewhere THEN 'here_and_elsewhere'
                   WHEN engine_counted_here THEN 'here'
                   WHEN engine_any_elsewhere THEN 'elsewhere'
                   ELSE 'no_job' END
       END AS agrees
  FROM compared
 ORDER BY job_number COLLATE "C", failure DESC, invoice_number COLLATE "C" NULLS FIRST, xero_invoice_id COLLATE "C" NULLS FIRST;
