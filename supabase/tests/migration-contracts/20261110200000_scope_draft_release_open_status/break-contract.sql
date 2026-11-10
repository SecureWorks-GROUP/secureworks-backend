-- Put back the old rule (release only while jobs.status is exactly
-- 'accepted'). The contract must notice that a card moved straight to Deposit
-- can no longer release its work order.
\ir ../../../rollbacks/20261110200000_scope_draft_release_open_status_down.sql
