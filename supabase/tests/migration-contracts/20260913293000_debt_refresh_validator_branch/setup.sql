-- Additive surface for the Debt validator branch. Earlier Refresh contracts
-- already install drivers, receipts and Dispatch fixtures. Keep this setup
-- from inventing debt_source_version or debt_assess_commands; those remain
-- Debt-owned and are created only inside the rolled-back contract.
SELECT 1;

CREATE TABLE IF NOT EXISTS public.xero_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  xero_invoice_id text NOT NULL,
  invoice_type text NOT NULL DEFAULT 'ACCREC',
  status text,
  amount_due numeric(12,2),
  amount_paid numeric(12,2),
  UNIQUE (org_id, xero_invoice_id)
);
GRANT SELECT, INSERT ON public.xero_invoices TO service_role;
