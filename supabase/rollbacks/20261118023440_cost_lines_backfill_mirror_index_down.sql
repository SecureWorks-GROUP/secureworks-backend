-- P2-01.8: remove only the additive mirror lookup index.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
DROP INDEX IF EXISTS public.trade_invoices_org_xero_bill_idx;
