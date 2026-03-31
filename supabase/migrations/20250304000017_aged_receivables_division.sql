-- Add job_type and reference to aged_receivables view for division filtering
-- This enables the CEO dashboard to filter AR by division (Patios/Fencing/Decking)
-- Must DROP + CREATE because Postgres can't add columns via CREATE OR REPLACE VIEW

DROP VIEW IF EXISTS aged_receivables;

CREATE VIEW aged_receivables AS
SELECT
  xi.org_id,
  xi.xero_contact_id,
  xi.contact_name,
  xi.invoice_number,
  xi.invoice_date,
  xi.due_date,
  xi.amount_due,
  xi.reference,
  j.type AS job_type,
  CASE
    WHEN xi.due_date >= CURRENT_DATE THEN 'current'
    WHEN xi.due_date >= CURRENT_DATE - INTERVAL '30 days' THEN '1-30'
    WHEN xi.due_date >= CURRENT_DATE - INTERVAL '60 days' THEN '31-60'
    WHEN xi.due_date >= CURRENT_DATE - INTERVAL '90 days' THEN '61-90'
    ELSE '90+'
  END AS age_bucket
FROM xero_invoices xi
LEFT JOIN jobs j ON xi.job_id = j.id
WHERE xi.invoice_type = 'ACCREC'
  AND xi.status IN ('AUTHORISED', 'SUBMITTED')
  AND xi.amount_due > 0;
