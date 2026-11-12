-- Contract for 20261111150000_dispatch_v2_order_document_office_delete: the
-- office can delete a supplier PDF Dispatch saved; the memory row stays saved
-- with no job document, so the same file can never be saved again; a saved
-- row still needs its saved time. Synthetic data, writes rolled back.
\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  j1 uuid := 'd1110000-0000-4000-8000-000000000001';
  o1 uuid := 'd1110000-0000-4000-8000-000000000011';
  d1 uuid := 'd1110000-0000-4000-8000-000000000021';
  sha1 text := repeat('a', 64);
  r record;
BEGIN
  INSERT INTO public.jobs (id, org_id, type, status, job_number)
  VALUES (j1, org, 'patio', 'awaiting_supplier', 'ZZTEST-ODD-20261111');
  INSERT INTO public.job_documents (id, job_id, type) VALUES (d1, j1, 'material_order');
  INSERT INTO public.dispatch_v2_order_documents
    (org_id, job_id, order_id, source, kind, content_sha256, state, saved_at, job_document_id)
  VALUES (org, j1, o1, 'supplier_reply', 'invoice', sha1, 'saved', now(), d1);

  -- 1. The office deletes the saved file: the delete goes through.
  DELETE FROM public.job_documents WHERE id = d1;
  IF EXISTS (SELECT 1 FROM public.job_documents WHERE id = d1) THEN
    RAISE EXCEPTION 'contract 1: the job document was not deleted';
  END IF;

  -- 2. The memory row stays saved, with no job document.
  SELECT state, job_document_id, saved_at INTO r
  FROM public.dispatch_v2_order_documents WHERE job_id = j1 AND content_sha256 = sha1;
  IF r.state IS DISTINCT FROM 'saved' OR r.job_document_id IS NOT NULL OR r.saved_at IS NULL THEN
    RAISE EXCEPTION 'contract 2: row after delete is %, %, %', r.state, r.job_document_id, r.saved_at;
  END IF;

  -- 3. The same file on the same job can not be claimed again.
  BEGIN
    INSERT INTO public.dispatch_v2_order_documents (org_id, job_id, order_id, source, kind, content_sha256)
    VALUES (org, j1, o1, 'supplier_reply', 'invoice', sha1);
    RAISE EXCEPTION 'contract 3: a deleted file was claimed again';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- 4. A saved row still needs its saved time.
  BEGIN
    INSERT INTO public.dispatch_v2_order_documents
      (org_id, job_id, order_id, source, kind, content_sha256, state)
    VALUES (org, j1, o1, 'supplier_reply', 'quote', repeat('b', 64), 'saved');
    RAISE EXCEPTION 'contract 4: a saved row with no saved time was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 5. The old check is gone and the new one is in place.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatch_v2_order_documents_saved_has_document')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatch_v2_order_documents_saved_has_time') THEN
    RAISE EXCEPTION 'contract 5: constraints not as expected';
  END IF;
END $$;
ROLLBACK;
