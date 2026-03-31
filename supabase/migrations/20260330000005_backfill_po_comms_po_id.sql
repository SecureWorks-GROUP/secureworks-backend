-- Backfill po_id on po_communications rows that were inserted without it.
-- Matches by job_id to the most recent purchase_order for that job.
-- Only affects purchase_order type communications (not council/client).
UPDATE po_communications
SET po_id = (
  SELECT po.id FROM purchase_orders po
  WHERE po.job_id = po_communications.job_id
    AND po.status != 'deleted'
  ORDER BY po.created_at DESC
  LIMIT 1
)
WHERE po_id IS NULL
  AND job_id IS NOT NULL
  AND communication_type = 'purchase_order';
