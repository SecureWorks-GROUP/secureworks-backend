-- Ship the ladder without L1g (L1f's body, as before this migration): a row a
-- contact rule placed before the customer's second job (then a draft) went
-- live leaves its job with the rules on. The contract must catch it.
-- TP-04 (20261029190000) and unplaced stage 1 (20261014170000) come off first.
\ir ../20261029190000_context_ladder_holding_flag/roll_back_successors.sql
\ir ../../../rollbacks/20261006035000_context_ladder_held_live_job_down.sql
