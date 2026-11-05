-- After the down: order_id is required again, the job key is gone, the older order key holds. Writes rolled back.
\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatch_v2_supplier_order_refs_job_order_ref_key') THEN
    RAISE EXCEPTION 'rollback left the job key';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatch_v2_supplier_order_refs_unique') THEN
    RAISE EXCEPTION 'rollback lost the order key';
  END IF;
  BEGIN
    INSERT INTO public.dispatch_v2_supplier_order_refs (org_id, order_id, job_id, ref, linked_via)
    VALUES (org, NULL, 'f4000000-0000-4000-8000-000000000001', '11041784', 'certain_match');
    RAISE EXCEPTION 'rollback left order_id optional';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;
END $$;
ROLLBACK;
