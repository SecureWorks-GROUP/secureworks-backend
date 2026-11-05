-- Down for 20261105172000_dispatch_v2_job_supplier_refs. Roll back ops-api first
-- (dispatch_v2_replies_store.ts writes with ON CONFLICT on job_id, order_id, ref,
-- and dispatch_v2_replies.ts writes job-alone numbers).
--
-- Numbers kept against a job alone (order_id null) are removed: the older
-- table cannot hold them. Numbers kept against an order stay as they are.
DELETE FROM public.dispatch_v2_supplier_order_refs WHERE order_id IS NULL;
ALTER TABLE public.dispatch_v2_supplier_order_refs
  DROP CONSTRAINT IF EXISTS dispatch_v2_supplier_order_refs_job_order_ref_key;
ALTER TABLE public.dispatch_v2_supplier_order_refs
  ALTER COLUMN order_id SET NOT NULL;
