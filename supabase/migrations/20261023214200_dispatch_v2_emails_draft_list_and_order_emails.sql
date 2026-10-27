-- Dispatch v2 (slices 5 and 6): the draft list, supplier boxes, photos and
-- the supplier order emails sent from admin@ through Outlook.
--
-- Contract: docs/dispatch-v2-emails-contract.md. Reader and writer: ops-api's
-- dispatch_v2_* actions (supabase/functions/ops-api/dispatch_v2_store.ts) and
-- nothing else. v2 has no purchase orders; nothing here touches
-- purchase_orders, suppliers, Xero or jobs.
--
-- What changes:
--
-- 1. job_material_lines.supplier_id may now be empty. An empty supplier is
--    the job's DRAFT LIST: lines typed (or suggested from the scope) before
--    they are split to suppliers. Moving a line into a supplier box sets it;
--    moving it back clears it. The existing link to job_material_suppliers
--    still holds for every line that has a supplier (a NULL is not checked).
--    Three optional text fields carry the extra lines of the email template:
--    detail ("Gate: Pedestrian gate 1270mm"), profile and colour.
--    dispatch_order_email_id is stamped when the line goes out on a sent
--    supplier order email; from then on the line is locked.
--
-- 2. job_material_suppliers.is_main_supplier: the tick for the job's MAIN
--    supplier. Fencing standing lines (4 x bags of quickset, Fixings, Post
--    Caps and Screws as necessary) go only on the main supplier's email. With
--    no tick the main supplier is worked out on read (the box holding the
--    panels, else the first box). At most one tick per job.
--
-- 3. dispatch_supplier_order_emails: one row per supplier order email, held
--    first (editable), then sent. The sent_* columns record what Outlook gave
--    back so the reply matcher can find replies:
--      sent_conversation_id      Outlook's thread id. Mail capture stores the
--                                same value as business_events
--                                payload.conversation_id, and as thread_key
--                                'outlook:<sent_conversation_id>'.
--      sent_internet_message_id  The email's Message-ID header. A reply quotes
--                                it in In-Reply-To / References.
--      sent_graph_message_id     The id of the message in admin@ when it was
--                                made. Outlook may give the Sent Items copy a
--                                new id, so match on the two above, not this.
--    A test send (the copy that goes only to admin@) is recorded in the test_*
--    columns and never in the sent_* columns, so a test never looks like an
--    order.
--
-- 4. dispatch_material_photos and the private bucket dispatch-material-photos:
--    a photo on the draft list (supplier_id empty) or in a supplier box. Under
--    3,000,000 bytes each (Outlook takes up to 3 MB per attachment); the
--    screen shrinks a photo before upload, and ops-api refuses a bigger one.
--
-- Row security on with no policy, revoked from the browser roles, as the
-- slice 4 tables are: only ops-api reaches these.
--
-- Rollback: supabase/rollbacks/20261023214200_dispatch_v2_emails_draft_list_and_order_emails_down.sql.

-- ── 3. The supplier order emails (made first: lines point at it) ───────────

CREATE TABLE IF NOT EXISTS public.dispatch_supplier_order_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id),
  -- The supplier's name when the email was made, kept for the record.
  supplier_name text NOT NULL,
  -- The approved entry the To/CC came from (null if it was removed later).
  approved_email_id uuid NULL REFERENCES public.dispatch_approved_supplier_emails(id) ON DELETE SET NULL,
  -- fencing / patio / repair / decking / other, from the job when made.
  work_type text NOT NULL,
  -- Was this the job's main supplier when the email was made.
  is_main_supplier boolean NOT NULL DEFAULT false,
  -- Did the email carry the two fencing standing lines.
  standing_lines_included boolean NOT NULL DEFAULT false,
  -- draft: held, editable. sending: a send is in progress. sent: Outlook took
  -- it. send_unknown: we could not tell whether it went (check admin@ Sent
  -- Items). discarded: thrown away unsent.
  status text NOT NULL DEFAULT 'draft',
  -- The team mailbox added to CC by job type (fencing@, patios@, ses@).
  team_cc_email text NULL,
  to_emails text[] NOT NULL,
  cc_emails text[] NOT NULL DEFAULT ARRAY[]::text[],
  subject text NOT NULL,
  body_text text NOT NULL,
  -- The body exactly as the template built it, so an edit can be seen.
  built_body_text text NOT NULL,
  -- The delivery date the Date: line was built from (null = left blank).
  delivery_date date NULL,
  -- The lines the email was built from: [{ line_id, updated_at, text }].
  -- A send refuses if the box's lines no longer match.
  order_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Photos attached (dispatch_material_photos ids).
  photo_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  -- The last test copy, sent only to admin@.
  test_sent_at timestamptz NULL,
  test_sent_to text NULL,
  test_sent_by_email text NULL,
  test_internet_message_id text NULL,
  test_conversation_id text NULL,
  -- The real send.
  send_claimed_at timestamptz NULL,
  sent_at timestamptz NULL,
  sent_by uuid NULL,
  sent_by_email text NULL,
  sent_from_mailbox text NULL,
  sent_to_emails text[] NULL,
  sent_cc_emails text[] NULL,
  sent_internet_message_id text NULL,
  sent_conversation_id text NULL,
  sent_graph_message_id text NULL,
  last_error text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NULL,
  created_by_email text NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_email text NULL,
  CONSTRAINT dispatch_supplier_order_emails_status_valid CHECK (status IN ('draft', 'sending', 'sent', 'send_unknown', 'discarded')),
  CONSTRAINT dispatch_supplier_order_emails_to_count CHECK (cardinality(to_emails) BETWEEN 1 AND 10),
  CONSTRAINT dispatch_supplier_order_emails_cc_count CHECK (cardinality(cc_emails) <= 12),
  CONSTRAINT dispatch_supplier_order_emails_subject_length CHECK (char_length(subject) BETWEEN 1 AND 250),
  CONSTRAINT dispatch_supplier_order_emails_body_length CHECK (char_length(body_text) BETWEEN 1 AND 20000),
  CONSTRAINT dispatch_supplier_order_emails_photo_count CHECK (cardinality(photo_ids) <= 3),
  CONSTRAINT dispatch_supplier_order_emails_sent_has_time CHECK (status <> 'sent' OR sent_at IS NOT NULL)
);

-- One open email per supplier box. A sent or discarded one never blocks the
-- next order to the same supplier.
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_supplier_order_emails_one_open_idx
  ON public.dispatch_supplier_order_emails (job_id, supplier_id)
  WHERE status IN ('draft', 'sending', 'send_unknown');
CREATE INDEX IF NOT EXISTS dispatch_supplier_order_emails_job_idx
  ON public.dispatch_supplier_order_emails (job_id);
-- The reply matcher looks a reply up by thread, then by Message-ID.
CREATE INDEX IF NOT EXISTS dispatch_supplier_order_emails_conversation_idx
  ON public.dispatch_supplier_order_emails (sent_conversation_id)
  WHERE sent_conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS dispatch_supplier_order_emails_message_id_idx
  ON public.dispatch_supplier_order_emails (sent_internet_message_id)
  WHERE sent_internet_message_id IS NOT NULL;

COMMENT ON TABLE public.dispatch_supplier_order_emails IS
  'Dispatch v2 (docs/dispatch-v2-emails-contract.md): one supplier order email per row, held then sent from admin@secureworkswa.com.au through send-outlook-email. Written only by ops-api dispatch_v2_*. Reply matching uses sent_conversation_id and sent_internet_message_id.';
COMMENT ON COLUMN public.dispatch_supplier_order_emails.sent_conversation_id IS
  'Outlook conversationId of the sent order email. Mail capture stores the same value as business_events payload.conversation_id and thread_key ''outlook:<id>''. Primary key for matching a supplier reply to this order.';
COMMENT ON COLUMN public.dispatch_supplier_order_emails.sent_internet_message_id IS
  'Message-ID header of the sent order email (e.g. <abc@...outlook.com>). Replies quote it in In-Reply-To / References.';
COMMENT ON COLUMN public.dispatch_supplier_order_emails.sent_graph_message_id IS
  'Graph id of the message in admin@ when it was made. Outlook may re-id the Sent Items copy; match replies on sent_conversation_id or sent_internet_message_id instead.';
COMMENT ON COLUMN public.dispatch_supplier_order_emails.test_conversation_id IS
  'Outlook conversationId of the last TEST copy (sent only to admin@). Never an order: the matcher must not treat it as one.';

-- ── 1. The draft list on job_material_lines ────────────────────────────────

ALTER TABLE public.job_material_lines ALTER COLUMN supplier_id DROP NOT NULL;
ALTER TABLE public.job_material_lines ADD COLUMN IF NOT EXISTS detail text NULL;
ALTER TABLE public.job_material_lines ADD COLUMN IF NOT EXISTS profile text NULL;
ALTER TABLE public.job_material_lines ADD COLUMN IF NOT EXISTS colour text NULL;
ALTER TABLE public.job_material_lines ADD COLUMN IF NOT EXISTS dispatch_order_email_id uuid NULL
  REFERENCES public.dispatch_supplier_order_emails(id) ON DELETE SET NULL;

DO $lines$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_material_lines_detail_length') THEN
    ALTER TABLE public.job_material_lines ADD CONSTRAINT job_material_lines_detail_length
      CHECK (detail IS NULL OR char_length(detail) BETWEEN 1 AND 300);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_material_lines_profile_length') THEN
    ALTER TABLE public.job_material_lines ADD CONSTRAINT job_material_lines_profile_length
      CHECK (profile IS NULL OR char_length(profile) BETWEEN 1 AND 80);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_material_lines_colour_length') THEN
    ALTER TABLE public.job_material_lines ADD CONSTRAINT job_material_lines_colour_length
      CHECK (colour IS NULL OR char_length(colour) BETWEEN 1 AND 80);
  END IF;
END $lines$;

COMMENT ON COLUMN public.job_material_lines.supplier_id IS
  'The supplier box the line sits in. Empty = the job''s draft list (Dispatch v2), not yet split to a supplier.';
COMMENT ON COLUMN public.job_material_lines.dispatch_order_email_id IS
  'Dispatch v2: the sent supplier order email this line went out on. Set only by a real (not test) send; the line is locked from then on.';

-- ── 2. The main supplier tick ──────────────────────────────────────────────

ALTER TABLE public.job_material_suppliers ADD COLUMN IF NOT EXISTS is_main_supplier boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS job_material_suppliers_one_main_idx
  ON public.job_material_suppliers (job_id)
  WHERE is_main_supplier;

COMMENT ON COLUMN public.job_material_suppliers.is_main_supplier IS
  'Dispatch v2: ticked = the job''s main supplier (fencing standing lines go only on its email). No tick on the job = worked out on read: the box holding the panels, else the first box.';

-- ── 4. Photos ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.dispatch_material_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  -- Empty = on the draft list; set = in that supplier box.
  supplier_id uuid NULL,
  file_name text NOT NULL,
  content_type text NOT NULL,
  size_bytes integer NOT NULL,
  storage_path text NOT NULL,
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NULL,
  created_by_email text NULL,
  CONSTRAINT dispatch_material_photos_storage_path_key UNIQUE (storage_path),
  CONSTRAINT dispatch_material_photos_supplier_on_job_fkey FOREIGN KEY (job_id, supplier_id)
    REFERENCES public.job_material_suppliers (job_id, supplier_id),
  CONSTRAINT dispatch_material_photos_content_type_valid CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  CONSTRAINT dispatch_material_photos_size_valid CHECK (size_bytes BETWEEN 1 AND 3000000),
  CONSTRAINT dispatch_material_photos_file_name_length CHECK (char_length(file_name) BETWEEN 1 AND 120)
);

CREATE INDEX IF NOT EXISTS dispatch_material_photos_job_idx
  ON public.dispatch_material_photos (job_id);

COMMENT ON TABLE public.dispatch_material_photos IS
  'Dispatch v2: a photo (e.g. a handwritten materials list) on the draft list or in a supplier box. Bytes live in the private bucket dispatch-material-photos. Staff only, through ops-api.';

ALTER TABLE public.dispatch_supplier_order_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispatch_material_photos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.dispatch_supplier_order_emails FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.dispatch_material_photos FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.dispatch_supplier_order_emails TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.dispatch_material_photos TO service_role;

-- The private bucket. Never public: a materials photo can show a client's
-- address and plans.
DO $bucket$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'dispatch-material-photos: storage absent, bucket not created';
    RETURN;
  END IF;
  EXECUTE $q$INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('dispatch-material-photos', 'dispatch-material-photos', false, 3000000,
            ARRAY['image/jpeg', 'image/png', 'image/webp'])
    ON CONFLICT (id) DO NOTHING$q$;
  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'dispatch-material-photos' AND public) THEN
    RAISE EXCEPTION 'dispatch_material_photos_bucket_public: bucket dispatch-material-photos exists and is public';
  END IF;
END $bucket$;
