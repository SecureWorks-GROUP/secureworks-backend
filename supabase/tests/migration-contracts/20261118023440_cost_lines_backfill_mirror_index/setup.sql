-- The registered stack supplies the real table. A standalone run needs only
-- the queried columns, with their existing uuid/uuid/text types. No functions.
CREATE TABLE IF NOT EXISTS public.trade_invoices (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  xero_bill_id text
);
