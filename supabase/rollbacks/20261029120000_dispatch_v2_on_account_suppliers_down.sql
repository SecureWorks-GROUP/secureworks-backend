-- Down for 20261029120000_dispatch_v2_on_account_suppliers. Roll ops-api back first: the
-- pipeline&dispatch=1&board=v2 list read, the dispatch_arrival read, the dispatch_v2_materials
-- read and the Mark paid press name this column. Drops the on_account column only; every approved
-- supplier entry and link stays. With it gone every supplier reads as before the payment step.
ALTER TABLE public.dispatch_approved_supplier_emails
  DROP COLUMN IF EXISTS on_account;
