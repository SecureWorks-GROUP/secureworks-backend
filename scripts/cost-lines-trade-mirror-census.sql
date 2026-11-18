-- Follow-up 66, mirror rule cutover check. Count only: how many supplier bill
-- cost lines already written are for a bill a trade invoice holds, by how the
-- old and new rules read it. Run before and after 20261119999900 (placeholder,
-- the keeper stamps it) and before any clean-up of those lines; the migration
-- leaves them where they are.
-- Read only: SELECTs on job_cost_lines and trade_invoices. Writes nothing.
-- Counts only: no bill ids, job ids, names or amounts.
-- Sent as one request (supabase db query --linked -f <this file>), the
-- statements share one implicit transaction: it is made read only and capped
-- at 30 seconds, and the SELECT is the last statement, so its rows return.
--
-- How the bill is held (one row each; a bill counts once, in its first match):
--   same_org_exact         this organisation's trade invoice, exact id: the old
--                          rule already skipped these, so expect 0;
--   same_org_case_or_space this organisation's, only trimmed or case-insensitive:
--                          the old rule missed it, the new rule skips it;
--   no_org                 only a trade invoice with no organisation: the old
--                          rule missed it, the new rule stops it;
--   other_org_only         only another organisation's: not ours, unchanged.
-- Columns:
--   bills / lines: the bills and their cost lines (every state);
--   counted_lines: lines a total reads today (state set, not_counted_reason null);
--   waiting_lines: lines waiting for a person (state needs_person).
SET TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

WITH bill_lines AS (
  SELECT l.org_id, l.document_id, l.state, l.not_counted_reason
    FROM public.job_cost_lines l
   WHERE l.document_kind = 'xero_bill'
), bills AS (
  SELECT DISTINCT org_id, document_id FROM bill_lines
), held AS (
  SELECT b.org_id, b.document_id,
    CASE
      WHEN EXISTS (SELECT 1 FROM public.trade_invoices t
                    WHERE t.org_id = b.org_id AND t.xero_bill_id = b.document_id) THEN 'same_org_exact'
      WHEN EXISTS (SELECT 1 FROM public.trade_invoices t
                    WHERE t.org_id = b.org_id AND t.xero_bill_id IS NOT NULL
                      AND lower(btrim(t.xero_bill_id)) = lower(btrim(b.document_id))) THEN 'same_org_case_or_space'
      WHEN EXISTS (SELECT 1 FROM public.trade_invoices t
                    WHERE t.org_id IS NULL AND t.xero_bill_id IS NOT NULL
                      AND lower(btrim(t.xero_bill_id)) = lower(btrim(b.document_id))) THEN 'no_org'
      WHEN EXISTS (SELECT 1 FROM public.trade_invoices t
                    WHERE t.org_id IS DISTINCT FROM b.org_id AND t.xero_bill_id IS NOT NULL
                      AND lower(btrim(t.xero_bill_id)) = lower(btrim(b.document_id))) THEN 'other_org_only'
    END AS held_as
  FROM bills b
)
SELECT h.held_as,
       count(DISTINCT (h.org_id, h.document_id)) AS bills,
       count(*) AS lines,
       count(*) FILTER (WHERE l.state IS NOT NULL AND l.not_counted_reason IS NULL) AS counted_lines,
       count(*) FILTER (WHERE l.state = 'needs_person') AS waiting_lines
  FROM held h
  JOIN bill_lines l ON l.org_id = h.org_id AND l.document_id = h.document_id
 WHERE h.held_as IS NOT NULL
 GROUP BY h.held_as
 ORDER BY h.held_as COLLATE "C";
