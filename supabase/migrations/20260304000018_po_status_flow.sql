-- ════════════════════════════════════════════════════════════
-- PO Status Flow Enhancement
--
-- Adds new PO statuses for the two-mode material ordering flow:
--   quote_requested → draft → approved → sent → confirmed → delivered
--
-- The purchase_orders table uses a text status column (no enum),
-- so we just need to update the check constraint if one exists.
-- ════════════════════════════════════════════════════════════

-- Drop existing check constraint on status if it exists
DO $$
BEGIN
  -- Try to drop the constraint (may not exist)
  ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_status_check;
EXCEPTION WHEN OTHERS THEN
  NULL; -- Ignore if constraint doesn't exist
END
$$;

-- Add new check constraint with expanded status values
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_status_check
  CHECK (status IN ('quote_requested', 'draft', 'approved', 'submitted', 'authorised', 'sent', 'confirmed', 'delivered', 'billed', 'deleted'));

-- Add comment documenting the flow
COMMENT ON COLUMN purchase_orders.status IS 'PO status: quote_requested → draft → approved → sent → confirmed → delivered (or legacy: submitted/authorised/billed)';
