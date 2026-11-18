-- Dispatch v2 items 17 and 5 (Shaun, 18 Nov 2026): a supplier reply is
-- flagged until someone dismisses it.
--
-- Today the Supplier replied chip only counts a reply that carries a delivery
-- date, or a box at Quote received. A reply with no date (R&R's standard
-- acknowledgement on Ian Tan SWF-261631, Stratco's questions on Breeanna Moran
-- SWF-261656) was never flagged. From now on every supplier reply matched to a
-- job shows under Supplier replied ("Read R&R reply") until a person presses
-- Dismiss on it in the job's Emails (Shaun: Q1 b, a button on each reply,
-- named Dismiss on 18 Nov; Q2 a, every reply, acknowledgements included). Accepting or dismissing that reply's date
-- also dismisses it, and so does putting it on a job from the tray.
--
-- What this changes:
--   1. dispatch_v2_supplier_emails gains dismissed_at, dismissed_by, dismissed_by_email and
--      dismissed_source ('button', 'suggestion', 'tray' or 'backfill'). Who and when
--      always go together; only the backfill has no person.
--   2. The backfill, so the old replies do not flood the chip:
--        a. a reply a person already put on a job from the tray (decision
--           assigned or confirmed) is dismissed then, by them (source 'tray');
--        b. every reply received before 16 Nov 2026 00:00 Perth
--           (2026-11-15T16:00:00Z), or with no received time, is dismissed now
--           (source 'backfill').
--      Replies from 16 Nov on stay flagged: on 18 Nov that was 46 replies on 21
--      jobs, 42 of them on 18 jobs at a Dispatch stage (Ian Tan and Breeanna
--      Moran among them).
-- No other table and no other column is touched.
--
-- Safe before the ops-api deploy: the old ops-api neither reads nor writes
-- these columns. The deploy workflow applies this before ops-api deploys, and
-- the new ops-api needs it (scripts/edge-function-schema-requirements.txt).
--
-- Rules and caller: supabase/functions/ops-api/dispatch_v2_replies.ts
-- (dispatch_v2_replies_dismiss) and dispatch_board.ts (the board's replies).
--
-- Rollback: supabase/rollbacks/20261118153000_dispatch_v2_reply_dismiss_down.sql.

ALTER TABLE public.dispatch_v2_supplier_emails
  ADD COLUMN IF NOT EXISTS dismissed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS dismissed_by uuid NULL,
  ADD COLUMN IF NOT EXISTS dismissed_by_email text NULL,
  ADD COLUMN IF NOT EXISTS dismissed_source text NULL;

ALTER TABLE public.dispatch_v2_supplier_emails
  DROP CONSTRAINT IF EXISTS dispatch_v2_supplier_emails_dismissed_by_fkey,
  ADD CONSTRAINT dispatch_v2_supplier_emails_dismissed_by_fkey
    FOREIGN KEY (dismissed_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.dispatch_v2_supplier_emails
  DROP CONSTRAINT IF EXISTS dispatch_v2_supplier_emails_dismissed_source_valid,
  ADD CONSTRAINT dispatch_v2_supplier_emails_dismissed_source_valid CHECK (
    dismissed_source IS NULL OR dismissed_source IN ('button', 'suggestion', 'tray', 'backfill')
  );

-- Dismissed has a when and a how, or neither; a person's press also names them.
ALTER TABLE public.dispatch_v2_supplier_emails
  DROP CONSTRAINT IF EXISTS dispatch_v2_supplier_emails_dismissed_shape,
  ADD CONSTRAINT dispatch_v2_supplier_emails_dismissed_shape CHECK (
    (dismissed_at IS NULL) = (dismissed_source IS NULL)
    AND (dismissed_at IS NOT NULL OR (dismissed_by IS NULL AND dismissed_by_email IS NULL))
    AND (dismissed_source IS NULL OR dismissed_source = 'backfill' OR dismissed_by_email IS NOT NULL)
  );

-- 2a. Put on a job by a person from the tray: dismissed then, by them.
UPDATE public.dispatch_v2_supplier_emails
   SET dismissed_at = decided_at,
       dismissed_by = decided_by,
       dismissed_by_email = decided_by_email,
       dismissed_source = 'tray'
 WHERE dismissed_at IS NULL
   AND decision IN ('assigned', 'confirmed')
   AND decided_at IS NOT NULL
   AND decided_by_email IS NOT NULL;

-- 2b. Received before 16 Nov 2026 (Perth), or with no received time: dismissed.
UPDATE public.dispatch_v2_supplier_emails
   SET dismissed_at = now(),
       dismissed_source = 'backfill'
 WHERE dismissed_at IS NULL
   AND (received_at IS NULL OR received_at < '2026-11-15T16:00:00Z');

COMMENT ON COLUMN public.dispatch_v2_supplier_emails.dismissed_at IS
  'When a person dismissed this supplier reply from the Dispatch Supplier replied chip (18 Nov 2026). Null on a matched reply: it shows under Supplier replied.';
COMMENT ON COLUMN public.dispatch_v2_supplier_emails.dismissed_source IS
  'How it was dismissed: button (Dismiss in the job''s Emails), suggestion (its date accepted or dismissed), tray (put on a job from the tray) or backfill (received before 16 Nov 2026).';
