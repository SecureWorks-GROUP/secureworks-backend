-- Make-safe live-truth: add 'skipped' to email_attachments.status.
--
-- 'skipped' is a TERMINAL, NON-BLOCKING record for an attachment we deliberately do
-- NOT capture (inline images / signatures, and non-PDF files under the PDF-only
-- policy). It exists purely for audit — the email + raw event already record that
-- the message had attachments; this lets ops SEE what non-PDF files a builder sent
-- without storing them.
--
-- WHY: previously these benign attachments were recorded as 'needs_review', which
-- monitor.refreshSyncState + ops-api reconcile both count as the unresolved backlog.
-- Every make-safe email carries a logo/photo, so the board was permanently DEGRADED
-- and the verified gate could NEVER go true. With 'skipped' excluded from the
-- backlog (and 'needs_review' STILL blocking for genuine problems — a missing PDF, a
-- reference/item link that could hide a WO, an empty list despite hasAttachments),
-- the board can reach OK while real gaps still block.
--
-- Purely ADDITIVE: widens the CHECK. No existing row changes; cannot fail on current
-- data (no row currently holds 'skipped').

ALTER TABLE public.email_attachments
  DROP CONSTRAINT IF EXISTS email_attachments_status_check;

ALTER TABLE public.email_attachments
  ADD CONSTRAINT email_attachments_status_check
  CHECK (status IN ('pending', 'uploaded', 'failed', 'needs_review', 'purged', 'skipped'));
