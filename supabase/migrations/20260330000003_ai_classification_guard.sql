-- ════════════════════════════════════════════════════════════
-- AI Classification Guard + Quote Versioning
--
-- Adds confidence scoring and quote version tracking to
-- po_communications so the AI can't auto-advance PO status
-- on low-confidence classifications.
-- ════════════════════════════════════════════════════════════

-- Store AI classification results on each inbound email
ALTER TABLE po_communications
  ADD COLUMN IF NOT EXISTS ai_classification text,
  ADD COLUMN IF NOT EXISTS ai_confidence numeric(3,2),
  ADD COLUMN IF NOT EXISTS quote_version int;

-- Index for finding quotes by PO (used for version counting)
CREATE INDEX IF NOT EXISTS idx_po_comms_classification
  ON po_communications(po_id, ai_classification)
  WHERE ai_classification IS NOT NULL;
