-- Dispatch v2 (Shaun, 16 Nov 2026): files on a supplier order, not only photos.
--
-- A supplier box could hold JPEG, PNG or WebP photos, and each went on the
-- order email as an attachment (Tweak 5). From now on it can also hold a PDF,
-- an Excel sheet (.xlsx, .xls), a CSV or a Word document (.docx, .doc), for
-- example a supplier's own order form. They go on the order email the same
-- way. Shaun's rules: 3 MB a file (unchanged), up to 10 photos and files on
-- one email, and a file saved to the job afterwards is office only (photos
-- stay crew-visible). ops-api checks the kind from the bytes.
--
-- What this changes, and nothing else:
--   1. dispatch_material_photos_content_type_valid: the six file types join
--      the three photo types. Size and name checks are unchanged.
--   2. The private bucket dispatch-material-photos: the same nine types in
--      allowed_mime_types. It stays private and stays 3,000,000 bytes a file;
--      the "never public" guard is kept.
--   3. dispatch_v2_order_documents source and kind: 'order_file' joins
--      'order_photo', for a file that went on our order email and was saved
--      to the job (office only).
--   4. dispatch_supplier_order_emails_photo_count: an order email may name
--      up to 10 photos and files (it was 3 photos).
-- No row is touched.
--
-- Safe before or after the ops-api deploy: before it, ops-api still only
-- takes photos; after the ops-api deploy and before this runs, a file upload
-- is refused by the old table check (a plain error on the screen, nothing
-- stored) and a file's save to the job is refused by the old document check
-- (logged, nothing saved; the order and its crew line are unaffected).
--
-- Rollback: supabase/rollbacks/20261116150000_dispatch_v2_order_files_down.sql.

ALTER TABLE public.dispatch_material_photos
  DROP CONSTRAINT IF EXISTS dispatch_material_photos_content_type_valid,
  ADD CONSTRAINT dispatch_material_photos_content_type_valid CHECK (
    content_type IN (
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/csv',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword'
    )
  );

COMMENT ON TABLE public.dispatch_material_photos IS
  'Dispatch v2: a photo (e.g. a handwritten materials list) or, from 16 Nov 2026, a PDF, Excel, CSV or Word file, on the draft list or in a supplier box. Bytes live in the private bucket dispatch-material-photos. Staff only, through ops-api.';

DO $bucket$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'dispatch-material-photos: storage absent, bucket not changed';
    RETURN;
  END IF;
  EXECUTE $q$UPDATE storage.buckets
    SET allowed_mime_types = ARRAY[
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/csv',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword'
    ]
    WHERE id = 'dispatch-material-photos'$q$;
  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'dispatch-material-photos' AND public) THEN
    RAISE EXCEPTION 'dispatch_material_photos_bucket_public: bucket dispatch-material-photos exists and is public';
  END IF;
END $bucket$;

ALTER TABLE public.dispatch_v2_order_documents
  DROP CONSTRAINT IF EXISTS dispatch_v2_order_documents_source_valid,
  ADD CONSTRAINT dispatch_v2_order_documents_source_valid CHECK (
    source IN ('supplier_reply', 'order_sheet', 'order_photo', 'order_file')
  );

ALTER TABLE public.dispatch_v2_order_documents
  DROP CONSTRAINT IF EXISTS dispatch_v2_order_documents_kind_valid,
  ADD CONSTRAINT dispatch_v2_order_documents_kind_valid CHECK (
    kind IN ('order_confirmation', 'invoice', 'quote', 'order_document', 'order_sheet', 'order_photo', 'order_file')
  );

ALTER TABLE public.dispatch_supplier_order_emails
  DROP CONSTRAINT IF EXISTS dispatch_supplier_order_emails_photo_count,
  ADD CONSTRAINT dispatch_supplier_order_emails_photo_count CHECK (
    cardinality(photo_ids) <= 10
  );

COMMENT ON COLUMN public.dispatch_v2_order_documents.source IS
  'supplier_reply = a PDF from a matched supplier reply; order_sheet = our own one-page Material order sheet; order_photo = a photo that went on our order email (Tweak 5); order_file = a PDF, Excel, CSV or Word file that went on our order email (16 Nov 2026), saved office only.';
