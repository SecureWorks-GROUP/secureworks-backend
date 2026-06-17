-- MakeSafe Reporting Autopilot (Wave 2) -- durable SEND-state table for the
-- resumable make-safe report-pack send state machine (makesafe_send_pack).
--
-- Purpose:
--   Hold the per-job, per-pack-kind SEND lifecycle so a partial failure (Xero
--   authorised but email not sent, marker not written, close not applied) leaves
--   a recoverable row a later resume can re-enter at the right step. This table
--   holds SEND state ONLY. The make-safe BOARD stage stays driven off
--   makesafe_job_details.substatus (admin_to_send_report / ready_to_invoice /
--   complete) exactly as before -- this row never replaces that.
--
-- Idempotency:
--   UNIQUE (job_id, pack_kind). The send state machine takes an atomic send-lock
--   by conditional UPDATE on this row, so two concurrent sends cannot both fire.
--
-- Safety:
--   This migration is additive only. It does not create jobs, send messages,
--   authorise/void invoices, or alter any existing make-safe state. No cron.

CREATE TABLE IF NOT EXISTS public.makesafe_report_packs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',

  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  -- pack_kind is the idempotency dimension alongside job_id. 'main' is the
  -- report + invoice close-out pack; future kinds (e.g. 'photo') reuse the row
  -- shape without colliding with the main pack's send state.
  pack_kind text NOT NULL DEFAULT 'main',

  -- Explicit SEND lifecycle. Every failure mode after the irreversible Xero
  -- authorise is a distinct recoverable state so a resume knows where to pick up:
  --   drafted              -- pack row exists, nothing irreversible done yet
  --   admin_to_send_report -- mirrors the board substatus; ready for a human send
  --   sending              -- atomic send-lock held (the in-flight guard)
  --   authorised_not_sent  -- invoice AUTHORISED but the email send failed (resume: re-send, do NOT re-authorise)
  --   sent_marker_failed   -- email sent but the MAKESAFE_PACK_SENT marker write failed (resume: write marker, do NOT re-email)
  --   sent_not_closed      -- marker written but the make-safe close (substatus=complete) failed (resume: close only)
  --   sent                 -- terminal success: emailed + marker + closed
  --   close_failed         -- close attempt errored after a confirmed send (recoverable like sent_not_closed)
  --   failed               -- a pre-irreversible failure (preflight/lock); no money or comms occurred
  status text NOT NULL DEFAULT 'drafted'
    CHECK (status IN (
      'drafted', 'admin_to_send_report', 'sending',
      'authorised_not_sent', 'sent_marker_failed', 'sent_not_closed',
      'sent', 'close_failed', 'failed'
    )),

  xero_invoice_id text,
  invoice_status text,
  report_doc_id uuid,
  invoice_doc_id uuid,
  swms_doc_id uuid,
  last_render_hash text,

  approver_id uuid,
  approved_at timestamptz,
  send_started_at timestamptz,
  sent_at timestamptz,

  failed_step text,
  retry_count int NOT NULL DEFAULT 0,
  error_detail text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (job_id, pack_kind)
);

CREATE INDEX IF NOT EXISTS idx_makesafe_report_packs_org_status
  ON public.makesafe_report_packs (org_id, status);

CREATE INDEX IF NOT EXISTS idx_makesafe_report_packs_job
  ON public.makesafe_report_packs (job_id);

ALTER TABLE public.makesafe_report_packs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'makesafe_report_packs'
      AND policyname = 'service_role_all_makesafe_report_packs'
  ) THEN
    CREATE POLICY "service_role_all_makesafe_report_packs"
      ON public.makesafe_report_packs FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END$$;

COMMENT ON TABLE public.makesafe_report_packs IS
  'Durable SEND-state for the make-safe report-pack send state machine (makesafe_send_pack). One row per (job_id, pack_kind). Holds the resumable lifecycle so a partial failure (authorised-not-sent / sent-not-closed) is recoverable; the board stage stays on makesafe_job_details.substatus. Additive, RLS service_role only, never mutated by clients.';
