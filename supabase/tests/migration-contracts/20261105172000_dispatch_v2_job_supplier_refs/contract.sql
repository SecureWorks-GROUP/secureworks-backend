-- Tweak 2 piece 3 (5 Nov 2026): a supplier's own number can be kept against a job with no order, once per job,
-- and the write ops-api makes (ON CONFLICT on job_id, order_id, ref DO NOTHING) never makes a second copy.
-- Numbers from the examples Shaun gave (Fencing Warehouse Customer Order 11041784). Writes rolled back.
\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  j1 uuid := 'd1720000-0000-4000-8000-000000000001';
  j2 uuid := 'd1720000-0000-4000-8000-000000000002';
  o1 uuid := 'd1720000-0000-4000-8000-000000000011';
  n int;
BEGIN
  -- 1. A number seen on a job with no order saves with order_id null.
  INSERT INTO public.dispatch_v2_supplier_order_refs (org_id, order_id, job_id, supplier_key, ref, linked_via)
  VALUES (org, NULL, j1, 'fencingwarehousewa', '11041784', 'certain_match');
  -- 2. The same number on the same job alone again: ops-api's write keeps one; a plain insert is refused.
  INSERT INTO public.dispatch_v2_supplier_order_refs (org_id, order_id, job_id, supplier_key, ref, linked_via)
  VALUES (org, NULL, j1, 'fencingwarehousewa', '11041784', 'assigned')
  ON CONFLICT (job_id, order_id, ref) DO NOTHING;
  SELECT count(*) INTO n FROM public.dispatch_v2_supplier_order_refs WHERE job_id = j1 AND ref = '11041784';
  IF n <> 1 THEN RAISE EXCEPTION 'contract 2: % job-alone copies', n; END IF;
  BEGIN
    INSERT INTO public.dispatch_v2_supplier_order_refs (org_id, order_id, job_id, ref, linked_via)
    VALUES (org, NULL, j1, '11041784', 'assigned');
    RAISE EXCEPTION 'contract 2: a second job-alone copy saved';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- 3. The same number on another job saves (ops-api then knows it is on two jobs and stops using it).
  INSERT INTO public.dispatch_v2_supplier_order_refs (org_id, order_id, job_id, ref, linked_via)
  VALUES (org, NULL, j2, '11041784', 'certain_match');
  -- 4. An order link, and the same order link again through ops-api's write: one row, as before.
  INSERT INTO public.dispatch_v2_supplier_order_refs (org_id, order_id, job_id, ref, linked_via)
  VALUES (org, o1, j1, '240272', 'certain_match')
  ON CONFLICT (job_id, order_id, ref) DO NOTHING;
  INSERT INTO public.dispatch_v2_supplier_order_refs (org_id, order_id, job_id, ref, linked_via)
  VALUES (org, o1, j1, '240272', 'confirmed_guess')
  ON CONFLICT (job_id, order_id, ref) DO NOTHING;
  SELECT count(*) INTO n FROM public.dispatch_v2_supplier_order_refs WHERE order_id = o1;
  IF n <> 1 THEN RAISE EXCEPTION 'contract 4: % order copies', n; END IF;
  -- 5. The older key still holds for order links.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatch_v2_supplier_order_refs_unique') THEN
    RAISE EXCEPTION 'contract 5: the order key went';
  END IF;
END $$;
ROLLBACK;
