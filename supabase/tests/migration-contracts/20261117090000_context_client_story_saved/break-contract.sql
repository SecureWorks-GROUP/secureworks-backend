-- Remove the promised behaviour: put story safety's body back, which builds a job story for each
-- of the client's newest 20 jobs, so the contract's no-build check must fail.
\ir ../../../rollbacks/20261117090000_context_client_story_saved_down.sql
