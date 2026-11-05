-- Dispatch v2, Tweak 2 piece 3 (Shaun, 5 Nov 2026): learn the supplier's own
-- order number.
--
-- Once a supplier email is tied to one of our jobs or orders, the reply scan
-- remembers the supplier's own numbers in it (Fencing Warehouse "Customer
-- Order 11041784", CMI "Sales Order 240272", Metroll "SO#1056395", Oxworks
-- "W2SO 92250", a supplier's Xero "INV-91320") in
-- dispatch_v2_supplier_order_refs, so a later email quoting the same number
-- matches that job or order by itself. Until now a number could be kept only
-- against an ORDER; an email tied to a job with no order for that supplier
-- (matched by the job number alone, or picked by hand without an order)
-- taught nothing.
--
-- This migration:
--   * lets order_id be null: the number was seen on the job when it had no
--     order for that supplier;
--   * adds one key for every link, job + order (or none) + number, with
--     NULLS NOT DISTINCT so a job-alone number is kept once per job. The
--     older key (order_id, ref) stays for order links.
--
-- Conservative rules live in ops-api (dispatch_v2_replies_rules.ts): never a
-- number with fewer than 5 digits, never our own job number, and a number
-- seen on two jobs is not used to match. No existing row changes. No
-- backfill.
--
-- Contract: docs/dispatch-v2-board-contract.md section 3f.3.
-- Rollback: supabase/rollbacks/20261105172000_dispatch_v2_job_supplier_refs_down.sql.

ALTER TABLE public.dispatch_v2_supplier_order_refs
  ALTER COLUMN order_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'dispatch_v2_supplier_order_refs_job_order_ref_key'
       AND conrelid = 'public.dispatch_v2_supplier_order_refs'::regclass
  ) THEN
    ALTER TABLE public.dispatch_v2_supplier_order_refs
      ADD CONSTRAINT dispatch_v2_supplier_order_refs_job_order_ref_key
      UNIQUE NULLS NOT DISTINCT (job_id, order_id, ref);
  END IF;
END $$;

COMMENT ON COLUMN public.dispatch_v2_supplier_order_refs.order_id IS
  'The Dispatch order the supplier number belongs to. Null (Tweak 2 piece 3): seen on the job when it had no order for that supplier; a later email quoting it matches the job.';
COMMENT ON CONSTRAINT dispatch_v2_supplier_order_refs_job_order_ref_key ON public.dispatch_v2_supplier_order_refs IS
  'One link per job, order (or none) and supplier number. ops-api writes with ON CONFLICT on these three columns (Tweak 2 piece 3).';
