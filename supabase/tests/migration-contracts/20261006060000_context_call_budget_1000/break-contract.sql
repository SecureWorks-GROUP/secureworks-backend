-- Ship without the ruled budget: put the 400-call day back (this migration's
-- own down file: the policy's 400, 300 and 60, every reader's old literal and
-- the 400 bound on reservations). The contract must catch it at call 401.
-- (The record scope, 20261011130000, replaced this migration's vision policy
-- since: when a full stack has it, it is rolled back first, as this down demands.)
-- (The call cap setting, 20261013100000, replaced the admission, the ledger budget, the vision
-- admission and the heartbeat core after all of these: when a full stack has it, it goes first.)
SELECT to_regprocedure('public.context_cadence_policy_today()') IS NOT NULL AS call_cap_setting_live \gset
\if :call_cap_setting_live
-- Roll back the later daily recheck before the body this proof needs.
SELECT (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_core_status()')) = 'bf6a84ad3b2fdcc0f9f1ba2f253b72a2' AS rc_later_live \gset
\if :rc_later_live
\ir ../../../rollbacks/20261014034549_context_recheck_messages_first_down.sql
\endif
\ir ../../../rollbacks/20261013100000_context_call_cap_setting_down.sql
\endif
SELECT coalesce(obj_description(to_regprocedure('public.context_job_record_timeline(uuid[],timestamptz)'), 'pg_proc'), '')
       LIKE '%(record scope, 20261011130000)%' AS record_scope_live \gset
\if :record_scope_live
\ir ../../../rollbacks/20261011130000_context_record_scope_down.sql
\endif
-- The saved job story replaced the admission after the call budget.
\ir ../../../rollbacks/20261009100000_context_job_story_text_down.sql
\ir ../../../rollbacks/20261006060000_context_call_budget_1000_down.sql
