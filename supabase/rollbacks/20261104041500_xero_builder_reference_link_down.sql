-- Down for 20261104041500_xero_builder_reference_link.sql. Before this existed there was no candidate read, no stamp
-- function, no trigger and no job_linked_at column; this returns to exactly that.
-- Revert xero-sync's builder_reference_match.ts first (or leave it: with the read gone it links nothing by that rule).
-- Dropping the column discards every link time stamped since 4 Nov 2026; copy it out first if it is still wanted:
--   CREATE TABLE xero_invoices_job_linked_at_keep AS SELECT id, job_linked_at FROM public.xero_invoices WHERE job_linked_at IS NOT NULL;
SET LOCAL lock_timeout = '5s';
DROP TRIGGER IF EXISTS xero_invoices_job_linked_at ON public.xero_invoices;
DROP FUNCTION IF EXISTS public.xero_invoices_stamp_job_linked_at();
ALTER TABLE public.xero_invoices DROP COLUMN IF EXISTS job_linked_at;
DROP FUNCTION IF EXISTS public.xero_builder_reference_candidates(text[]);
