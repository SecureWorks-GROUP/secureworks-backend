-- Deliberately put the earlier bodies back (this migration's own rollback: the record loops, the
-- story read, the assembler and the judge as 20261006040000 and 20261006014000 left them, and the
-- rule dropped). contract.sql must then fail on its first check, R7 of a lead 29 days after its
-- quote, which reads only a body that exists before this migration: the contract fails first on
-- the earlier bodies.
-- (The scoping pipeline, 20261009133000, replaced four of these bodies since: its rollback goes
-- first, as this one refuses while a later body is live.)
SELECT to_regprocedure('public.context_lead_window_hours(text)') IS NOT NULL AS scoping_pipeline_live \gset
\if :scoping_pipeline_live
\ir ../../../rollbacks/20261009133000_context_scoping_pipeline_down.sql
\endif
SELECT to_regprocedure('public.context_ledger_row_unread(timestamptz,boolean,timestamptz)') IS NOT NULL AS notes_freshness_live \gset
\if :notes_freshness_live
\ir ../../../rollbacks/20261009132000_context_notes_freshness_down.sql
\endif
\ir ../../../rollbacks/20261007010000_context_lead_cutoff_down.sql
