-- After the down: a box takes photos only again and an order file can no longer be remembered; photos and the
-- order photo memory still work. Writes rolled back.
\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  j1 uuid := 'd1160000-0000-4000-8000-000000000001';
  o1 uuid := 'd1160000-0000-4000-8000-000000000011';
BEGIN
  BEGIN
    INSERT INTO public.dispatch_material_photos (org_id, job_id, file_name, content_type, size_bytes, storage_path, sha256)
    VALUES (org, j1, 'f.pdf', 'application/pdf', 100, j1::text || '/f', repeat('a', 64));
    RAISE EXCEPTION 'rollback still takes a PDF';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO public.dispatch_material_photos (org_id, job_id, file_name, content_type, size_bytes, storage_path, sha256)
  VALUES (org, j1, 'p.jpg', 'image/jpeg', 100, j1::text || '/p', repeat('a', 64));
  BEGIN
    INSERT INTO public.dispatch_v2_order_documents (org_id, job_id, order_id, source, kind, content_sha256)
    VALUES (org, j1, o1, 'order_file', 'order_file', repeat('b', 64));
    RAISE EXCEPTION 'rollback still takes order files';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO public.dispatch_v2_order_documents (org_id, job_id, order_id, source, kind, content_sha256)
  VALUES (org, j1, o1, 'order_photo', 'order_photo', repeat('c', 64));
END $$;
ROLLBACK;
