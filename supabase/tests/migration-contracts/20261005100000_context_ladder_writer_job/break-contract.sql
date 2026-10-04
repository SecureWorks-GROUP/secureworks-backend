-- Ship the ladder without L1e (L1d's bodies, as before this migration): a
-- payment record whose writer named its job but no match_method lands on no
-- job. The contract must catch it.
\ir ../../../rollbacks/20261005100000_context_ladder_writer_job_down.sql
