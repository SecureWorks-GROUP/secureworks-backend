SELECT to_regprocedure('public.context_job_story_ledger_sig(uuid)') IS NOT NULL AS has_story_ledger_witness \gset
\if :has_story_ledger_witness
\ir ../../../rollbacks/20261030185500_context_story_ledger_witness_down.sql
\endif
\ir ../../../rollbacks/20261030184000_context_ledger_edit_story_refresh_down.sql
