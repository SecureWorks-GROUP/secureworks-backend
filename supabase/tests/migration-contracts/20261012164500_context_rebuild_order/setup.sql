-- Prerequisites for 20261012164500_context_rebuild_order: none of its own. Every table, column and
-- function the due list reads (jobs, business_events, old-inbox mail, the ledger's tables, the
-- judge and the record layer's message helper) comes from the earlier registered setups.
SELECT 1;
