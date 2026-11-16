-- Down for 20261116080000_context_job_evidence_for_bills: drop the read and its helpers. Nothing
-- else changed and nothing was written.
DROP FUNCTION IF EXISTS public.context_job_evidence_for_bills(text[], boolean);
DROP FUNCTION IF EXISTS public.context_job_evidence_is_statement(text);
DROP FUNCTION IF EXISTS public.context_job_evidence_text_numbers(text);
DROP FUNCTION IF EXISTS public.context_job_evidence_number_key(text);
DROP FUNCTION IF EXISTS public.context_job_evidence_policy();
