-- Break: the outcome trusts a bill's Xero job link (the #1134 shape #1141 was
-- written to fix) instead of reading the engine. The contract must catch it.
ALTER VIEW public.cfo_bill_cost_outcomes RENAME TO cfo_bill_cost_outcomes_engine;
CREATE VIEW public.cfo_bill_cost_outcomes AS
SELECT o.contract_version, o.subject_kind, o.xero_invoice_id, o.invoice_number, o.contact_name, o.bill_status,
       o.job_id, o.job_number, o.holding_job, o.xero_linked, o.row_source, o.placed_by,
       CASE WHEN o.xero_linked THEN 'counted' ELSE o.counts END AS counts,
       o.reason, o.bill_state, o.held_reason, o.overhead_part, o.not_job_related_mark, o.bill_counted_jobs,
       o.counted_ex, o.placed_ex, o.bill_ex, o.overhead_ex, o.credit_applied_ex, o.evidence_hash
FROM public.cfo_bill_cost_outcomes_engine o;
