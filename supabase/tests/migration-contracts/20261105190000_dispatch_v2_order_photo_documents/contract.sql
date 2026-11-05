-- Tweak 5 (5 Nov 2026): a photo that went on an order email can be remembered as saved to the job, once per
-- photo per job, beside the order sheet and supplier PDFs; nothing else the checks allow or refuse changes.
-- Writes rolled back.
\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  j1 uuid := 'd1900000-0000-4000-8000-000000000001';
  o1 uuid := 'd1900000-0000-4000-8000-000000000011';
  sha1 text := repeat('a', 64);
  sha2 text := repeat('b', 64);
  sha3 text := repeat('c', 64);
  n int;
BEGIN
  -- 1. Two photos of one order are claimed, one row each.
  INSERT INTO public.dispatch_v2_order_documents (org_id, job_id, order_id, source, kind, content_sha256)
  VALUES (org, j1, o1, 'order_photo', 'order_photo', sha1),
         (org, j1, o1, 'order_photo', 'order_photo', sha2);
  SELECT count(*) INTO n FROM public.dispatch_v2_order_documents WHERE order_id = o1 AND source = 'order_photo';
  IF n <> 2 THEN RAISE EXCEPTION 'contract 1: % photo rows', n; END IF;
  -- 2. The same photo on the same job again is refused: saved once.
  BEGIN
    INSERT INTO public.dispatch_v2_order_documents (org_id, job_id, order_id, source, kind, content_sha256)
    VALUES (org, j1, o1, 'order_photo', 'order_photo', sha1);
    RAISE EXCEPTION 'contract 2: the same photo saved twice';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- 3. Photos do not use up the order's one order sheet: the sheet still saves beside them.
  INSERT INTO public.dispatch_v2_order_documents (org_id, job_id, order_id, source, kind, content_sha256)
  VALUES (org, j1, o1, 'order_sheet', 'order_sheet', sha3);
  -- 4. An unknown source or kind is still refused.
  BEGIN
    INSERT INTO public.dispatch_v2_order_documents (org_id, job_id, order_id, source, kind, content_sha256)
    VALUES (org, j1, o1, 'order_picture', 'order_photo', repeat('d', 64));
    RAISE EXCEPTION 'contract 4: an unknown source saved';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.dispatch_v2_order_documents (org_id, job_id, order_id, source, kind, content_sha256)
    VALUES (org, j1, o1, 'order_photo', 'photo', repeat('e', 64));
    RAISE EXCEPTION 'contract 4: an unknown kind saved';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- 5. The constraint names are the ones ops-api and the schema checks know.
  SELECT count(*) INTO n FROM pg_constraint
  WHERE conname IN ('dispatch_v2_order_documents_source_valid', 'dispatch_v2_order_documents_kind_valid');
  IF n <> 2 THEN RAISE EXCEPTION 'contract 5: % of the two checks found', n; END IF;
END $$;
ROLLBACK;
