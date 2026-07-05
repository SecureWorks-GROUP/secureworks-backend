-- Finance review email send-ledger (M4 U3).
--
-- Mission profit-trade-invoice-intelligence-2026-07-03 (campaign
-- profitability-job-costing, M4). Wiki issue #112. When generate_trade_invoice
-- flags a make-safe invoice, U3 records ONE review email per flagged invoice in
-- this ledger, keyed by trade_invoice_id + a hash of the flagged-line set. The
-- ledger is the idempotency + audit spine (finding #1):
--   • a resubmission with an UNCHANGED flag set records/sends nothing (the
--     partial unique index below refuses a duplicate active row);
--   • a resubmission with a CHANGED flag set supersedes the prior active row and
--     records ONE update (is_update = true, supersedes_id set);
--   • a wrongly-sent email is corrected by a follow-up correction row
--     (status='correction', correction_of set) to the same inbox.
--
-- v1 records the rendered email but does NOT send it: status stays 'recorded'
-- until the transport is enabled (env FINANCE_REVIEW_EMAIL_SEND=on) AFTER Marnin
-- approves the exact draft at CP2, at which point the send flips status to 'sent'
-- and stamps sent_at. This table never pays, holds, or mutates money.
--
-- HAND-APPLIED: applied manually by the orchestrator, not by CI auto-migrate,
-- and only after CP2 + Marnin approval. Additive and idempotent (safe to re-run).

CREATE TABLE IF NOT EXISTS public.finance_review_emails (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_invoice_id   uuid NOT NULL,
  invoice_number     text,
  flag_set_hash      text NOT NULL,
  flagged_line_count integer NOT NULL DEFAULT 0,
  recipient          text NOT NULL,
  subject            text,
  body_text          text,
  body_html          text,
  -- recorded (built, not yet sent) | sent | superseded | correction
  status             text NOT NULL DEFAULT 'recorded',
  is_update          boolean NOT NULL DEFAULT false,
  supersedes_id      uuid,           -- the ledger row this update replaces
  correction_of      uuid,           -- the ledger row a correction row fixes
  send_error         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  sent_at            timestamptz
);

COMMENT ON TABLE public.finance_review_emails IS
  'M4 U3 send-ledger: one finance review email per flagged trade invoice, keyed by trade_invoice_id + flag_set_hash. Idempotency + audit spine; v1 records (status=recorded) but does not send until CP2-gated. Never mutates money.';

CREATE INDEX IF NOT EXISTS finance_review_emails_invoice_idx
  ON public.finance_review_emails (trade_invoice_id);

-- Exactly-one ACTIVE row per (invoice, flag-set): enforces the idempotency
-- contract at the DB level too, so even a concurrent double-submit cannot land
-- two live notices for the same flag set. Superseded/correction rows are exempt
-- (they are history), so an update after a real change still inserts cleanly.
CREATE UNIQUE INDEX IF NOT EXISTS finance_review_emails_active_uidx
  ON public.finance_review_emails (trade_invoice_id, flag_set_hash)
  WHERE status IN ('recorded', 'sent');
