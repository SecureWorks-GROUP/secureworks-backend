-- P2-01.8: one org-scoped lookup for a bounded bill page's mirror ids.
-- Existing main has no index on (org_id, xero_bill_id). No data or caller changes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
CREATE INDEX IF NOT EXISTS trade_invoices_org_xero_bill_idx
  ON public.trade_invoices (org_id, xero_bill_id);
