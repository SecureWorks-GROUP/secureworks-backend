-- No new tables: the migration writes only to tables earlier cases already create
-- (jobs, xero_invoices, trade_invoices, materials_reconciliation_queue, job_materials_facts,
-- job_events) and calls allocate_bill_split (20261020181800). In the stack the migration runs on
-- an empty bill list and must write nothing; contract.sql replays it on fixtures inside a
-- rolled-back transaction.
SELECT 1;
