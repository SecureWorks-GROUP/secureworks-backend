-- Ship the ladder without TP-04 (the bodies as they were before it, with the
-- old case-sensitive spelling NOT IN ('true','1')): a job flagged 1 is no
-- candidate and one flagged "TRUE" is. The contract must catch it.
\ir ../../../rollbacks/20261029190000_context_ladder_holding_flag_down.sql
