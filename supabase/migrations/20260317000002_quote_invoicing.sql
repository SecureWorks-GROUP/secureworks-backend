-- Independent quote number sequence
CREATE SEQUENCE IF NOT EXISTS quote_number_seq START WITH 1;

CREATE OR REPLACE FUNCTION next_quote_number()
RETURNS text AS $$
  SELECT 'Q-' || lpad(nextval('quote_number_seq')::text, 4, '0');
$$ LANGUAGE sql;

-- Add quote_number to job_documents
ALTER TABLE job_documents ADD COLUMN IF NOT EXISTS quote_number text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_docs_quote_number
  ON job_documents(quote_number) WHERE quote_number IS NOT NULL;

-- Track which quotes an invoice covers
ALTER TABLE xero_invoices ADD COLUMN IF NOT EXISTS quote_document_ids uuid[];
