-- Prerequisites for 20261116150000_dispatch_v2_order_files: dispatch_material_photos and the photo_ids column of
-- dispatch_supplier_order_emails as 20261023214200 made them (that migration has no contract of its own, so this is
-- a narrow stand-in: the columns and checks this migration and its contract use, without the foreign keys to jobs and
-- job_material_suppliers). dispatch_v2_order_documents comes from the 20261105190000 case's setup, already widened
-- to order_photo by that migration. No storage schema here, so the bucket step only raises its notice.
CREATE TABLE IF NOT EXISTS public.dispatch_material_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  job_id uuid NOT NULL,
  supplier_id uuid NULL,
  file_name text NOT NULL,
  content_type text NOT NULL,
  size_bytes integer NOT NULL,
  storage_path text NOT NULL,
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_material_photos_storage_path_key UNIQUE (storage_path),
  CONSTRAINT dispatch_material_photos_content_type_valid CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  CONSTRAINT dispatch_material_photos_size_valid CHECK (size_bytes BETWEEN 1 AND 3000000),
  CONSTRAINT dispatch_material_photos_file_name_length CHECK (char_length(file_name) BETWEEN 1 AND 120)
);
ALTER TABLE public.dispatch_supplier_order_emails
  ADD COLUMN IF NOT EXISTS photo_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[];
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatch_supplier_order_emails_photo_count') THEN
    ALTER TABLE public.dispatch_supplier_order_emails
      ADD CONSTRAINT dispatch_supplier_order_emails_photo_count CHECK (cardinality(photo_ids) <= 3);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatch_v2_order_documents_source_valid') THEN
    RAISE EXCEPTION 'order files prerequisites: the order documents source check should exist';
  END IF;
END $$;
