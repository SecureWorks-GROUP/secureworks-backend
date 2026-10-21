-- Prerequisites for 20261015100000_context_held_notes: none of its own. It reads business_events, jobs,
-- feature_flags and the context ledger tables, which the earlier registered setups and migrations create.
SELECT 1;
