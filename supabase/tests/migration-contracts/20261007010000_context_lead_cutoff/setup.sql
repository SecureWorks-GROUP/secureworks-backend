-- Prerequisites for 20261007010000_context_lead_cutoff: none of its own. Every table and column
-- the rule and the bodies it replaces read (jobs.status, quoted_at and accepted_at; quote
-- documents' sent_at and accepted_at; customer invoices' type, status and times; bookings' status,
-- ghost and role; the messages the record layer reads) comes from the earlier registered setups.
SELECT 1;
