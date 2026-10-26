-- Deposit advance for fencing and patio jobs (captain, 26 Oct 2026).
--
-- The pipeline moves a fencing or patio job along by its deposit: a job whose deposit
-- invoice went out lands in Awaiting Deposit, and a job where every paying party has a
-- deposit and every live deposit invoice is paid in full moves to Order Materials (patio:
-- Approvals while council is needed or not decided). The rule is supabase/functions/_shared/job_deposit_paid.ts; the reads,
-- moves, the client text and the flag are supabase/functions/ops-api/job_deposit_advance.ts;
-- the contract is docs/job-deposit-advance-v1.md. This migration ships only the switch and
-- the per-job record, the switch OFF:
--
--   1. job_closeout_settings.deposit_advance_mode  'off' (seeded): nothing is read, moved,
--      texted or logged. 'dry_run' (watch only): each move that would happen is one
--      job_events row deposit_advance_dry_run; nothing moves and nobody is texted.
--      'live': jobs move, and an automatic move to Order Materials texts the client once.
--      The database switch alone decides.
--   2. job_deposit_advance_state: one row per job the deposit advance moved or flagged:
--      the move (when, from, to, the deposit invoices that counted), the once-only client
--      text claim (text_status is claimed before the send), and the flag a person decides
--      on when a deposit is voided or no longer paid after the move (flag, cleared by a
--      person through ops-api clear_job_deposit_flag).
--
-- Turn on, in this order (each one an UPDATE, never a DELETE):
--   a. UPDATE public.job_closeout_settings SET deposit_advance_mode = 'dry_run', ...
--      and read the deposit_advance_dry_run job_events rows for a week.
--   b. UPDATE public.job_closeout_settings SET deposit_advance_mode = 'live', ...
--      (Shaun switches it live.)
--
-- Rollback: supabase/rollbacks/20261026160000_job_deposit_advance_down.sql. Roll back the
-- matching ops-api and xero-sync first: they read this column and this table.

-- ── 1. The switch ────────────────────────────────────────────────────────────
ALTER TABLE public.job_closeout_settings
  ADD COLUMN IF NOT EXISTS deposit_advance_mode text NOT NULL DEFAULT 'off';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.job_closeout_settings'::regclass
       AND conname = 'job_closeout_settings_deposit_advance_mode_check'
  ) THEN
    ALTER TABLE public.job_closeout_settings
      ADD CONSTRAINT job_closeout_settings_deposit_advance_mode_check
      CHECK (deposit_advance_mode IN ('off', 'dry_run', 'live'));
  END IF;
END $$;

COMMENT ON COLUMN public.job_closeout_settings.deposit_advance_mode IS
  'Deposit advance (20261026160000): off | dry_run | live. live: a fencing or patio job whose deposit invoice was emailed moves accepted -> awaiting_deposit, and one where every paying party has a deposit and every live deposit invoice is paid in full moves accepted or awaiting_deposit -> order_materials (patio: approvals unless council_required is false), texting the client once on a move to order_materials (ops-api job_deposit_advance.ts). dry_run: one job_events row deposit_advance_dry_run per move that would happen, nothing moved or sent. The database switch alone decides. Change with UPDATE.';

-- ── 2. The per-job record ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.job_deposit_advance_state (
  job_id              uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
  moved_at            timestamptz,
  moved_from          text,
  moved_to            text,
  moved_source        text,
  counted_invoice_ids text[] NOT NULL DEFAULT '{}',
  last_paid_on        date,
  text_status         text CHECK (text_status IN ('claimed', 'sent', 'refused', 'unconfirmed', 'no_contact', 'prior_send_unreadable', 'already_sent')),
  text_at             timestamptz,
  text_message_id     text,
  text_error          text,
  flag                text CHECK (flag IN ('deposit_voided', 'deposit_unpaid')),
  flag_at             timestamptz,
  flag_invoice_id     text,
  flag_invoice_number text,
  flag_invoice_status text,
  flag_cleared_at     timestamptz,
  flag_cleared_by     text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_deposit_advance_state_open_flag
  ON public.job_deposit_advance_state (job_id)
  WHERE flag IS NOT NULL AND flag_cleared_at IS NULL;

COMMENT ON TABLE public.job_deposit_advance_state IS
  'Deposit advance (20261026160000): per fencing or patio job, the automatic paid-deposit move (moved_at, moved_from, moved_to, counted_invoice_ids: the deposit invoices that counted), the once-only client text (text_status claimed before the send, then sent | refused | unconfirmed | no_contact | prior_send_unreadable | already_sent; never re-sent), and the open flag a person decides on when a deposit is voided (deposit_voided) or no longer paid in full (deposit_unpaid) after the job moved on; the job is never moved back. Written only by ops-api job_deposit_advance.ts.';

ALTER TABLE public.job_deposit_advance_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.job_deposit_advance_state FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.job_deposit_advance_state TO service_role;
DROP POLICY IF EXISTS job_deposit_advance_state_service_role_all ON public.job_deposit_advance_state;
CREATE POLICY job_deposit_advance_state_service_role_all ON public.job_deposit_advance_state
  FOR ALL TO service_role USING (true) WITH CHECK (true);
