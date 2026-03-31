-- ════════════════════════════════════════════════════════════
-- Migration: Email Threading + Tracking on po_communications
--
-- Adds threading columns (message_id, in_reply_to, thread_id),
-- council linking, delivery tracking, and read status.
-- ════════════════════════════════════════════════════════════

-- Threading columns
ALTER TABLE po_communications ADD COLUMN IF NOT EXISTS message_id text;
ALTER TABLE po_communications ADD COLUMN IF NOT EXISTS in_reply_to text;
ALTER TABLE po_communications ADD COLUMN IF NOT EXISTS thread_id text;

-- Council linking
ALTER TABLE po_communications ADD COLUMN IF NOT EXISTS council_submission_id uuid;
ALTER TABLE po_communications ADD COLUMN IF NOT EXISTS council_step_index int;

-- Delivery + read tracking
ALTER TABLE po_communications ADD COLUMN IF NOT EXISTS delivery_status text;
ALTER TABLE po_communications ADD COLUMN IF NOT EXISTS read_at timestamptz;

-- Compose metadata
ALTER TABLE po_communications ADD COLUMN IF NOT EXISTS cc_emails jsonb;
ALTER TABLE po_communications ADD COLUMN IF NOT EXISTS created_by uuid;

-- Indexes for threading and inbox queries
CREATE INDEX IF NOT EXISTS idx_po_comms_thread ON po_communications(thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_po_comms_message ON po_communications(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_po_comms_unread ON po_communications(direction, read_at) WHERE direction = 'inbound' AND read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_po_comms_council ON po_communications(council_submission_id, council_step_index) WHERE council_submission_id IS NOT NULL;

-- Create po-attachments storage bucket if not exists (referenced by receive-po-email but never created)
-- Note: This must be done via edge function or dashboard, not SQL. Handled in receive-po-email fix.
