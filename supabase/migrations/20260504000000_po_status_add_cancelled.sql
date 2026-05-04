-- ════════════════════════════════════════════════════════════
-- Add 'cancelled' to purchase_orders.status check constraint
--
-- Discovered during MCP Loop 5 canary sweep: sw_update_po failed when called
-- with status='cancelled' because the existing constraint did not include it.
-- Existing valid values were: quote_requested, draft, approved, submitted,
-- authorised, sent, confirmed, delivered, billed, deleted.
--
-- 'deleted' is a soft-delete marker (filtered by list_pos via .neq); 'cancelled'
-- expresses a different lifecycle state — the PO was created but the work was
-- cancelled before fulfilment. Some agent dispatches need this for cleanup.
--
-- Backfill is a no-op: there are no existing rows that would need migration.
-- ════════════════════════════════════════════════════════════

ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_status_check;

ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_status_check
  CHECK (status IN (
    'quote_requested',
    'draft',
    'approved',
    'submitted',
    'authorised',
    'sent',
    'confirmed',
    'delivered',
    'billed',
    'cancelled',
    'deleted'
  ));

COMMENT ON COLUMN purchase_orders.status IS 'PO status: quote_requested → draft → approved → sent → confirmed → delivered (or legacy: submitted/authorised/billed). Soft-deletes set status=deleted; cancelled means created-but-not-fulfilled.';
