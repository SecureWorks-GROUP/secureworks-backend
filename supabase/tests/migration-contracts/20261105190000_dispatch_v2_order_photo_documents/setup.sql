-- Prerequisites for 20261105190000_dispatch_v2_order_photo_documents: dispatch_v2_order_documents as
-- 20261105161000_dispatch_v2_order_documents made it (that migration has no contract of its own, so this is a
-- narrow stand-in: the columns and checks this migration and its contract use, without the foreign keys to jobs,
-- dispatch_supplier_order_emails and job_documents).
CREATE TABLE IF NOT EXISTS public.dispatch_v2_order_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  job_id uuid NOT NULL,
  order_id uuid NOT NULL,
  supplier_id uuid NULL,
  source text NOT NULL,
  kind text NOT NULL,
  content_sha256 text NOT NULL,
  reply_email_id uuid NULL,
  attachment_id uuid NULL,
  source_file_name text NULL,
  state text NOT NULL DEFAULT 'claimed',
  claimed_at timestamptz NOT NULL DEFAULT now(),
  saved_at timestamptz NULL,
  job_document_id uuid NULL,
  storage_path text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_v2_order_documents_job_file_unique UNIQUE (job_id, content_sha256),
  CONSTRAINT dispatch_v2_order_documents_source_valid CHECK (
    source IN ('supplier_reply', 'order_sheet')
  ),
  CONSTRAINT dispatch_v2_order_documents_kind_valid CHECK (
    kind IN ('order_confirmation', 'invoice', 'quote', 'order_document', 'order_sheet')
  ),
  CONSTRAINT dispatch_v2_order_documents_state_valid CHECK (
    state IN ('claimed', 'saved')
  ),
  CONSTRAINT dispatch_v2_order_documents_sha_valid CHECK (
    content_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT dispatch_v2_order_documents_saved_has_document CHECK (
    state <> 'saved' OR (job_document_id IS NOT NULL AND saved_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_v2_order_documents_one_sheet
  ON public.dispatch_v2_order_documents (order_id)
  WHERE source = 'order_sheet';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatch_v2_order_documents_source_valid') THEN
    RAISE EXCEPTION 'Tweak 5 order photo prerequisites: the source check should exist';
  END IF;
END $$;
