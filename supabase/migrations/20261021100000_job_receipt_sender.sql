-- Paid-invoice receipt for fencing and patio jobs (captain, 20 Oct 2026).
--
-- When a client sales invoice of a fencing or patio job turns PAID, Xero emails that paid
-- invoice to its Xero contact (POST /Invoices/{InvoiceID}/Email): Xero's paid invoice
-- email, "View Invoice", no Pay button, $0.00 due. Every paid invoice, deposits included,
-- once ever. The sender is supabase/functions/ops-api/job_receipt.ts; the contract is
-- docs/job-receipt-v1.md. This migration ships only the switch and the claims, OFF:
--
--   1. job_closeout_settings.receipt_sender_mode  'off' (seeded): nothing is emailed or
--      logged. 'dry_run': each invoice that would be emailed (or refused) gets one
--      job_events row receipt_dry_run naming the invoice number and Xero contact; nothing
--      is sent. 'live': Xero emails the paid invoice. The database switch alone decides
--      (captain, 20 Oct 2026): there is no env lock.
--   2. job_closeout_settings.receipt_sender_mode_since  the instant the current mode
--      began, stamped by trigger whenever the mode changes and never writable by hand.
--      Only invoices paid after it are in scope, so no history is ever caught up and a
--      live switch never sends for invoices paid during the dry run.
--   3. job_receipt_claims: one row per Xero invoice, inserted BEFORE the Xero call; its id
--      is the Idempotency-Key. An invoice is never emailed twice by this system.
--
-- Turn on, in this order (each one an UPDATE, never a DELETE):
--   a. UPDATE public.job_closeout_settings SET receipt_sender_mode = 'dry_run', ...
--      and read the receipt_dry_run job_events rows.
--   b. Open Xero > Settings > Email settings and read the default invoice email template
--      (it is what the customer gets, for a paid invoice too).
--   c. Tell staff to stop sending receipts by hand from Xero.
--   d. UPDATE public.job_closeout_settings SET receipt_sender_mode = 'live', ...
--
-- Rollback: supabase/rollbacks/20261021100000_job_receipt_sender_down.sql. Roll back the
-- matching ops-api and xero-sync first: they read these columns and this table.

-- ── 1 and 2. The switch and its start instant ────────────────────────────────
ALTER TABLE public.job_closeout_settings
  ADD COLUMN IF NOT EXISTS receipt_sender_mode text NOT NULL DEFAULT 'off';
ALTER TABLE public.job_closeout_settings
  ADD COLUMN IF NOT EXISTS receipt_sender_mode_since timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.job_closeout_settings'::regclass
       AND conname = 'job_closeout_settings_receipt_sender_mode_check'
  ) THEN
    ALTER TABLE public.job_closeout_settings
      ADD CONSTRAINT job_closeout_settings_receipt_sender_mode_check
      CHECK (receipt_sender_mode IN ('off', 'dry_run', 'live'));
  END IF;
END $$;

COMMENT ON COLUMN public.job_closeout_settings.receipt_sender_mode IS
  'Paid-invoice receipt (20261021100000): off | dry_run | live. live: Xero emails each newly paid client sales invoice of a fencing or patio job, once (ops-api job_receipt.ts). The database switch alone decides. Change with UPDATE.';
COMMENT ON COLUMN public.job_closeout_settings.receipt_sender_mode_since IS
  'Paid-invoice receipt (20261021100000): when the current receipt_sender_mode began. Stamped by trigger job_closeout_settings_receipt_mode_since on every mode change and kept otherwise; only invoices paid after it are emailed. Null reads as off.';

CREATE OR REPLACE FUNCTION public.job_closeout_settings_receipt_mode_since()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.receipt_sender_mode_since := CASE
      WHEN NEW.receipt_sender_mode = 'off' THEN NULL ELSE now() END;
  ELSIF NEW.receipt_sender_mode IS DISTINCT FROM OLD.receipt_sender_mode THEN
    NEW.receipt_sender_mode_since := now();
  ELSE
    -- Never set by hand: an earlier instant would catch up history.
    NEW.receipt_sender_mode_since := OLD.receipt_sender_mode_since;
  END IF;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.job_closeout_settings_receipt_mode_since() IS
  'Paid-invoice receipt (20261021100000): stamps job_closeout_settings.receipt_sender_mode_since with now() when receipt_sender_mode changes, and keeps it otherwise.';

DROP TRIGGER IF EXISTS job_closeout_settings_receipt_mode_since ON public.job_closeout_settings;
CREATE TRIGGER job_closeout_settings_receipt_mode_since
  BEFORE INSERT OR UPDATE ON public.job_closeout_settings
  FOR EACH ROW EXECUTE FUNCTION public.job_closeout_settings_receipt_mode_since();

-- ── 3. The per-invoice receipt claim ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.job_receipt_claims (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  xero_invoice_id text NOT NULL UNIQUE,
  job_id          uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  invoice_number  text,
  xero_contact_id text,
  status          text NOT NULL CHECK (status IN ('claimed', 'sent', 'refused', 'unconfirmed')),
  trigger         text NOT NULL,
  error           text,
  claimed_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_job_receipt_claims_job ON public.job_receipt_claims (job_id);

COMMENT ON TABLE public.job_receipt_claims IS
  'Paid-invoice receipt (20261021100000): one claim per Xero invoice, inserted before Xero is asked to email it (the id is the Idempotency-Key), so no invoice is emailed twice by this system. status claimed (in flight) | sent (Xero accepted) | refused (Xero answered 4xx: nothing went out; for staff, never retried) | unconfirmed (it may have gone; never retried). A claim is removed only when Xero provably never took the request (rate limit, cooldown, auth). Written only by ops-api job_receipt.ts.';

ALTER TABLE public.job_receipt_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.job_receipt_claims FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.job_receipt_claims TO service_role;
DROP POLICY IF EXISTS job_receipt_claims_service_role_all ON public.job_receipt_claims;
CREATE POLICY job_receipt_claims_service_role_all ON public.job_receipt_claims
  FOR ALL TO service_role USING (true) WITH CHECK (true);
