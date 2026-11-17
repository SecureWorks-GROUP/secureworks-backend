-- Existing production indexes omitted by the narrow historical setups.
CREATE INDEX IF NOT EXISTS idx_po_job ON public.purchase_orders(job_id) WHERE job_id IS NOT NULL;
SELECT 1;
