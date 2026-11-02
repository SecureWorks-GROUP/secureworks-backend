DO $$ BEGIN IF to_regprocedure('public.context_job_story_ledger_sig(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'ledger witness rollback retained helper'; END IF; END $$;
\ir ../20261030184000_context_ledger_edit_story_refresh/contract.sql
