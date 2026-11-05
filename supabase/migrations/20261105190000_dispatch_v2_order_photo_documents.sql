-- Dispatch v2 Tweak 5 (Shaun, 5 Nov 2026): an order that is just a photo.
--
-- When a supplier confirms an order but sends no PDF, ops-api already saves
-- our own one-page Material order sheet to the job, so the crew can see what
-- was ordered (Tweak 1, contract section 3e.3). From Tweak 5 it also saves the
-- photos that went on our order email ("Stratco order photo 1", "2", ...),
-- crew-visible, once per photo. A photo-only order gets its photos INSTEAD of
-- the sheet, because a sheet with no lines says nothing. See
-- docs/dispatch-v2-board-contract.md section 3e.4.
--
-- Each saved photo is remembered in dispatch_v2_order_documents, the same
-- once-only memory the PDFs use (one row per file per job, by its SHA-256),
-- so a photo is never saved to a job twice. That table only allows two
-- sources ('supplier_reply', 'order_sheet') and five kinds today. This
-- migration adds 'order_photo' to both lists. The constraint names do not
-- change, nothing else about the table changes, and no row is touched.
--
-- Safe to run before or after the ops-api deploy: until it runs, a photo's
-- claim is refused by the old check, ops-api logs it and saves nothing (the
-- order and its crew line are unaffected).
--
-- Rollback: supabase/rollbacks/20261105190000_dispatch_v2_order_photo_documents_down.sql.

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
