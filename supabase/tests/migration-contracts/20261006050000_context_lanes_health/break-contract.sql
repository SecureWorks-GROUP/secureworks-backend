\ir ../../../rollbacks/20261030192929_context_capture_excludes_evaluation_down.sql
-- Restore the 6 October preimage before planting the original historical fault.
\ir ../20261030144532_context_email_sweep_continuation/pre-sweep-health.sql
-- Ship without the fix: the five status bodies back to the live ones of
-- 6 Oct 2026 and EM2's ledger. The monitor-inbox handover, the retired cache
-- copier and the agent action log alarm again; the contract must catch it.
\ir ../../../rollbacks/20261006050000_context_lanes_health_down.sql
