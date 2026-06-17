-- Slice 0: Add html_url column to job_documents for interactive HTML quote delivery
-- Safe: additive IF NOT EXISTS. Apply to prod BEFORE deploying the backend code
-- that reads/writes this column (ghl-proxy prepare_quote + send-quote /view).
ALTER TABLE job_documents ADD COLUMN IF NOT EXISTS html_url text;
