-- Deliberately put the earlier bodies back (this migration's own rollback: the record loops, the
-- story read, the assembler and the judge as 20261006040000 and 20261006014000 left them, and the
-- rule dropped). contract.sql must then fail on its first check, R7 of a lead 29 days after its
-- quote, which reads only a body that exists before this migration: the contract fails first on
-- the earlier bodies.
-- (The notes freshness, 20261009132000, replaced this migration's judge since; its down goes first,
-- as this migration's refuses while a later body is live.)
SELECT coalesce(obj_description(to_regprocedure('public.context_ledger_row_unread(timestamptz,boolean,timestamptz)'), 'pg_proc'), '')
       LIKE 'Notes freshness (20261009132000)%' AS notes_freshness_live \gset
\if :notes_freshness_live
\ir ../../../rollbacks/20261009132000_context_notes_freshness_down.sql
\endif
\ir ../../../rollbacks/20261007010000_context_lead_cutoff_down.sql
