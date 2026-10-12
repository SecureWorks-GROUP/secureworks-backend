-- Deliberately put the earlier bodies back (this migration's own rollback: the lead rule, the judge
-- and the due list as 20261009133000 left them, and the wake function dropped). contract.sql must
-- then fail on its first check, the rule as of Mon 12 Oct 2026 10:00 Perth, which reads only a
-- function that exists before this migration: the earlier rule calls every finished job not_quoted,
-- whatever its customer wrote.
\ir ../../../rollbacks/20261012093500_context_finished_wake_down.sql
