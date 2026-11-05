-- After the down: an order photo can no longer be remembered; the PDFs and the order sheet still can. Writes
-- rolled back.
\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  j1 uuid := 'd1900000-0000-4000-8000-000000000001';
  o1 uuid := 'd1900000-0000-4000-8000-000000000011';
BEGIN
  BEGIN
    INSERT INTO public.dispatch_v2_order_documents (org_id, job_id, order_id, source, kind, content_sha256)
    VALUES (org, j1, o1, 'order_photo', 'order_photo', repeat('a', 64));
    RAISE EXCEPTION 'rollback still takes order photos';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO public.dispatch_v2_order_documents (org_id, job_id, order_id, source, kind, content_sha256)
  VALUES (org, j1, o1, 'order_sheet', 'order_sheet', repeat('b', 64)),
         (org, j1, o1, 'supplier_reply', 'order_confirmation', repeat('c', 64));
END $$;
ROLLBACK;
