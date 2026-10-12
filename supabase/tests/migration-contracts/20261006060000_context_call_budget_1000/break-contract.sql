-- Ship without the ruled budget: put the 400-call day back (this migration's
-- own down file: the policy's 400, 300 and 60, every reader's old literal and
-- the 400 bound on reservations). The contract must catch it at call 401.
-- (The record scope, 20261011130000, replaced this migration's vision policy
-- since: when a full stack has it, it is rolled back first, as this down demands.)
SELECT coalesce(obj_description(to_regprocedure('public.context_job_record_timeline(uuid[],timestamptz)'), 'pg_proc'), '')
       LIKE '%(record scope, 20261011130000)%' AS record_scope_live \gset
\if :record_scope_live
\ir ../../../rollbacks/20261011130000_context_record_scope_down.sql
\endif
-- The saved job story replaced the admission after the call budget.
\ir ../../../rollbacks/20261009100000_context_job_story_text_down.sql
\ir ../../../rollbacks/20261006060000_context_call_budget_1000_down.sql
