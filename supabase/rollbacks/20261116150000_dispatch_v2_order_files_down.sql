-- Down for 20261116150000_dispatch_v2_order_files.
--
-- Puts the checks and the bucket back to photos only (what 20261023214200
-- and 20261105190000 made).
--
-- The old checks cannot hold while a file row exists, so these go first:
--   * dispatch_v2_order_documents rows with source or kind 'order_file' (the
--     once-only memory only; the files already saved to jobs stay on the
--     jobs, job_documents and the job-documents bucket are not touched);
--   * dispatch_material_photos rows that hold a file, and their ids on any
--     order email that is not sent yet. A SENT email keeps its photo_ids as
--     the record of what went. The file objects stay in the private bucket
--     (harmless; remove them by hand with the storage API if wanted).
-- Roll back the ops-api change as well, or the screen will keep offering
-- files and the uploads will be refused by the old check.
--
-- dispatch_supplier_order_emails_photo_count is left at 10 on purpose: a sent
-- email may already name more than 3 photos (kept as the record of what
-- went), so the old limit of 3 could not be put back without changing sent
-- records. The rolled-back ops-api never puts more than 3 on a new email.

DELETE FROM public.dispatch_v2_order_documents
WHERE source = 'order_file' OR kind = 'order_file';

UPDATE public.dispatch_supplier_order_emails e
SET photo_ids = COALESCE((
  SELECT array_agg(p ORDER BY ord)
  FROM unnest(e.photo_ids) WITH ORDINALITY AS u(p, ord)
  WHERE p NOT IN (
    SELECT f.id FROM public.dispatch_material_photos f
    WHERE f.content_type NOT IN ('image/jpeg', 'image/png', 'image/webp')
  )
), '{}')
WHERE e.status NOT IN ('sent', 'sending', 'send_unknown')
  AND EXISTS (
    SELECT 1 FROM public.dispatch_material_photos f
    WHERE f.id = ANY (e.photo_ids)
      AND f.content_type NOT IN ('image/jpeg', 'image/png', 'image/webp')
  );

DELETE FROM public.dispatch_material_photos
WHERE content_type NOT IN ('image/jpeg', 'image/png', 'image/webp');

ALTER TABLE public.dispatch_material_photos
  DROP CONSTRAINT IF EXISTS dispatch_material_photos_content_type_valid,
  ADD CONSTRAINT dispatch_material_photos_content_type_valid CHECK (
    content_type IN ('image/jpeg', 'image/png', 'image/webp')
  );

COMMENT ON TABLE public.dispatch_material_photos IS
  'Dispatch v2: a photo (e.g. a handwritten materials list) on the draft list or in a supplier box. Bytes live in the private bucket dispatch-material-photos. Staff only, through ops-api.';

DO $bucket$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE $q$UPDATE storage.buckets
    SET allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp']
    WHERE id = 'dispatch-material-photos'$q$;
END $bucket$;

ALTER TABLE public.dispatch_v2_order_documents
  DROP CONSTRAINT IF EXISTS dispatch_v2_order_documents_source_valid,
  ADD CONSTRAINT dispatch_v2_order_documents_source_valid CHECK (
    source IN ('supplier_reply', 'order_sheet', 'order_photo')
  );

ALTER TABLE public.dispatch_v2_order_documents
  DROP CONSTRAINT IF EXISTS dispatch_v2_order_documents_kind_valid,
  ADD CONSTRAINT dispatch_v2_order_documents_kind_valid CHECK (
    kind IN ('order_confirmation', 'invoice', 'quote', 'order_document', 'order_sheet', 'order_photo')
  );

COMMENT ON COLUMN public.dispatch_v2_order_documents.source IS
  'supplier_reply = a PDF from a matched supplier reply; order_sheet = our own one-page Material order sheet; order_photo = a photo that went on our order email (Tweak 5).';
