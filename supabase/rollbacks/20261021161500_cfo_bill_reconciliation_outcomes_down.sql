-- Down for 20261021161500_cfo_bill_reconciliation_outcomes (job profit H7).
-- The view is the whole migration and nothing depends on it inside this repo.
-- Context reads it; drop only after Context stops reading it.
DROP VIEW IF EXISTS public.cfo_bill_reconciliation_outcomes;
