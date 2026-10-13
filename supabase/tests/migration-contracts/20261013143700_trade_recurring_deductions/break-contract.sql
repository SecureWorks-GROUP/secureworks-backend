-- Deliberately undo the promise that a deduction is taken once per invoice
-- week: drop the index under it. contract.sql must notice.
DROP INDEX public.trade_invoices_one_recurring_deduction_per_week;
