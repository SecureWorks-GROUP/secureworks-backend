-- Pre-migration surface for the reconciliation decisions store. Every table and column it
-- reads (business_events with candidate_job_ids and the attribution columns, jobs, job_contacts,
-- xero_invoices, users, context_ledger_generations and context_ledger_items) is already created
-- by earlier registered setups and migrations, and the migration adds no column to any of them.
SELECT 1;
