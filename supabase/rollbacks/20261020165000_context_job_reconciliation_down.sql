-- Down for 20261020165000_context_job_reconciliation: drops the two read-only functions. Writes no
-- row; the decision store and its functions (20261020140000) are untouched.
DROP FUNCTION IF EXISTS public.context_recon_job_items(uuid);
DROP FUNCTION IF EXISTS public.context_job_mail(uuid, int, text[]);
