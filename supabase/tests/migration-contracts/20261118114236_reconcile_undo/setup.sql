-- Only an isolated contract needs the earlier slices' setup.
SELECT to_regprocedure('public.match_apply_stop(text)') IS NULL AS needs_matcher \gset
\if :needs_matcher
\ir ../20261118112924_match_apply/setup.sql
\ir ../../../migrations/20261118112924_match_apply.sql
\endif
SELECT to_regprocedure('public.reconcile_decide(uuid,text,text,jsonb,text,boolean,uuid)') IS NULL AS needs_decide \gset
\if :needs_decide
\ir ../20261118073318_reconcile_decide/setup.sql
\ir ../../../migrations/20261118073318_reconcile_decide.sql
\endif
