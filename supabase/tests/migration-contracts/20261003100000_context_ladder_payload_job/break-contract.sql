-- Ship the ladder without step 1b (P4's bodies, as before this migration):
-- a contact rule places a row on another job than the one its payload names,
-- and the revision store then refuses it. The contract must catch it.
\ir ../../../rollbacks/20261003100000_context_ladder_payload_job_down.sql
