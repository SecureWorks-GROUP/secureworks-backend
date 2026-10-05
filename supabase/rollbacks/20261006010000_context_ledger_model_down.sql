-- Rollback of 20261006010000_context_ledger_model: drops the ledger tables.
-- Nothing outside the ledger reads them; the fact store is untouched.
-- Refused while the ledger store (20261006013000) or the story (20261006014000)
-- is installed: roll those back first, so the admission never outlives the
-- tables its ledger branch reads.
SET LOCAL lock_timeout = '5s';
DO $guard$
BEGIN
 IF to_regprocedure('public.context_ledger_judge(uuid[])') IS NOT NULL
    OR to_regprocedure('public.context_ledger_evidence_rows(uuid[],timestamptz)') IS NOT NULL
    OR to_regprocedure('public.context_job_story_ledger(uuid,uuid,timestamptz)') IS NOT NULL THEN
  RAISE EXCEPTION 'context_ledger_model_down_refused: roll back 20261006014000_context_job_story and 20261006013000_context_ledger_store first';
 END IF;
END $guard$;
DROP TABLE IF EXISTS public.context_ledger_transitions;
DROP TABLE IF EXISTS public.context_ledger_items;
DROP TABLE IF EXISTS public.context_ledger_generations;
DROP TABLE IF EXISTS public.context_ledger_settings;
