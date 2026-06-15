-- Make-safe live-truth: add emails.attachments_settled — an all-or-nothing DONE
-- marker for the resumable/chunked historical backfill.
--
-- WHY: email_attachments.email_id has an FK to emails(post_id), so the email row MUST
-- be written BEFORE its attachments — the email row's existence therefore can't mean
-- "attachments done". The chunked backfill needs a per-post marker that is true ONLY
-- after the email row + ALL its attachments + the pipeline projection are durably
-- written. persistPost sets attachments_settled=true as its LAST write; if an invoke
-- is killed (WORKER_RESOURCE_LIMIT) mid-attachment, the marker stays false and the
-- post is REPROCESSED next invoke — never skipped with PDFs silently missing.
--
-- Purely ADDITIVE (new column, default false). Existing rows get false; the next poll
-- /backfill re-marks them. No data rewrite, cannot fail on current data.

ALTER TABLE public.emails
  ADD COLUMN IF NOT EXISTS attachments_settled boolean NOT NULL DEFAULT false;

-- Partial index to make the backfill done-set lookup (settled rows per mailbox) cheap.
CREATE INDEX IF NOT EXISTS emails_settled_by_mailbox_idx
  ON public.emails (mailbox) WHERE attachments_settled;
