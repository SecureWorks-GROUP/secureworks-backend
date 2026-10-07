-- Deliberately put the earlier bodies back (this migration's own rollback: the record loops, the
-- story read, the assembler and the judge as 20261006040000 and 20261006014000 left them, and the
-- rule dropped). contract.sql must then fail on its first check, R7 of a lead 29 days after its
-- quote, which reads only a body that exists before this migration: the contract fails first on
-- the earlier bodies.
\ir ../../../rollbacks/20261007010000_context_lead_cutoff_down.sql
