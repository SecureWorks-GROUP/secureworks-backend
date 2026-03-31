-- ════════════════════════════════════════════════════════════
-- Migration 015: Receipt Media Support
--
-- Extends job_media to support receipt/docket photos linked
-- to purchase orders. Trades photograph receipts on site.
-- ════════════════════════════════════════════════════════════

-- Add 'receipt' to the phase check constraint
ALTER TABLE job_media DROP CONSTRAINT IF EXISTS job_media_phase_check;
ALTER TABLE job_media ADD CONSTRAINT job_media_phase_check
  CHECK (phase IN ('scope', 'in_progress', 'completion', 'receipt'));

-- Add optional PO reference for receipt photos
ALTER TABLE job_media
  ADD COLUMN IF NOT EXISTS po_id uuid REFERENCES purchase_orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_job_media_po ON job_media(po_id) WHERE po_id IS NOT NULL;
