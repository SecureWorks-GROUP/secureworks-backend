-- Down for 20261118153000_dispatch_v2_reply_dismiss. Roll back ops-api first
-- (dispatch_v2_replies.ts and dispatch_board.ts read and write these columns).
--
-- Who dismissed which supplier reply, and when, is lost; the replies
-- themselves are unchanged. Nothing else changes.
ALTER TABLE public.dispatch_v2_supplier_emails
  DROP CONSTRAINT IF EXISTS dispatch_v2_supplier_emails_dismissed_shape,
  DROP CONSTRAINT IF EXISTS dispatch_v2_supplier_emails_dismissed_source_valid,
  DROP CONSTRAINT IF EXISTS dispatch_v2_supplier_emails_dismissed_by_fkey;
ALTER TABLE public.dispatch_v2_supplier_emails
  DROP COLUMN IF EXISTS dismissed_source,
  DROP COLUMN IF EXISTS dismissed_by_email,
  DROP COLUMN IF EXISTS dismissed_by,
  DROP COLUMN IF EXISTS dismissed_at;
