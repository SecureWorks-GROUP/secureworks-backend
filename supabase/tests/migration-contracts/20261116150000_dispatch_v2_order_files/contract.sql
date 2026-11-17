-- 16 Nov 2026: a supplier box can hold a PDF, Excel, CSV or Word file beside its photos; an order email names up to
-- 10 of them; a file that went on an order can be remembered as saved to the job (order_file). The size, name and
-- unknown-type checks still refuse. Writes rolled back.
\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  j1 uuid := 'd1160000-0000-4000-8000-000000000001';
  o1 uuid := 'd1160000-0000-4000-8000-000000000011';
  s1 uuid := 'd1160000-0000-4000-8000-000000000021';
  t text;
  i int := 0;
  n int;
  ids uuid[] := ARRAY[]::uuid[];
BEGIN
  -- 1. Each photo and file type is taken.
  FOREACH t IN ARRAY ARRAY[
    'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword'
  ] LOOP
    i := i + 1;
    INSERT INTO public.dispatch_material_photos (org_id, job_id, file_name, content_type, size_bytes, storage_path, sha256)
    VALUES (org, j1, 'f' || i, t, 100, j1::text || '/f' || i, repeat('a', 64));
  END LOOP;
  SELECT count(*) INTO n FROM public.dispatch_material_photos WHERE job_id = j1;
  IF n <> 9 THEN RAISE EXCEPTION 'contract 1: % of 9 types taken', n; END IF;
  -- 2. An unknown type is still refused.
  BEGIN
    INSERT INTO public.dispatch_material_photos (org_id, job_id, file_name, content_type, size_bytes, storage_path, sha256)
    VALUES (org, j1, 'x.zip', 'application/zip', 100, j1::text || '/x', repeat('a', 64));
    RAISE EXCEPTION 'contract 2: a zip was taken';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- 3. A file over 3,000,000 bytes is still refused.
  BEGIN
    INSERT INTO public.dispatch_material_photos (org_id, job_id, file_name, content_type, size_bytes, storage_path, sha256)
    VALUES (org, j1, 'big.pdf', 'application/pdf', 3000001, j1::text || '/big', repeat('a', 64));
    RAISE EXCEPTION 'contract 3: a file over 3 MB was taken';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- 4. An order email names 10 photos and files, not 11.
  FOR i IN 1..11 LOOP ids := ids || gen_random_uuid(); END LOOP;
  INSERT INTO public.dispatch_supplier_order_emails (org_id, job_id, supplier_id, supplier_name, subject, photo_ids)
  VALUES (org, j1, s1, 'Solarspan', 'Material Order', ids[1:10]);
  BEGIN
    INSERT INTO public.dispatch_supplier_order_emails (org_id, job_id, supplier_id, supplier_name, subject, photo_ids)
    VALUES (org, j1, s1, 'Solarspan', 'Material Order', ids);
    RAISE EXCEPTION 'contract 4: an email named 11';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- 5. A file on an order is remembered as saved to the job (order_file), once per file per job.
  INSERT INTO public.dispatch_v2_order_documents (org_id, job_id, order_id, source, kind, content_sha256)
  VALUES (org, j1, o1, 'order_file', 'order_file', repeat('b', 64)),
         (org, j1, o1, 'order_photo', 'order_photo', repeat('c', 64));
  BEGIN
    INSERT INTO public.dispatch_v2_order_documents (org_id, job_id, order_id, source, kind, content_sha256)
    VALUES (org, j1, o1, 'order_file', 'order_file', repeat('b', 64));
    RAISE EXCEPTION 'contract 5: the same file saved twice';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- 6. An unknown source or kind is still refused.
  BEGIN
    INSERT INTO public.dispatch_v2_order_documents (org_id, job_id, order_id, source, kind, content_sha256)
    VALUES (org, j1, o1, 'order_attachment', 'order_file', repeat('d', 64));
    RAISE EXCEPTION 'contract 6: an unknown source saved';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.dispatch_v2_order_documents (org_id, job_id, order_id, source, kind, content_sha256)
    VALUES (org, j1, o1, 'order_file', 'file', repeat('e', 64));
    RAISE EXCEPTION 'contract 6: an unknown kind saved';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;
