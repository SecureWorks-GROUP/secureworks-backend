-- Trade invoice time entries (owner, 12 Oct 2026).
--
-- Every invoice line that bills a trade's time records the day it was worked
-- and the start and finish time, and those entries are readable per job.
--
--   1. trade_invoice_lines gains work_date, start_time, finish_time and
--      break_minutes. All four are NULL on every existing row and stay NULL:
--      no backfill, no invented times.
--   2. persist_weekly_trade_invoice_v2 wraps the v1 persist (unchanged) and
--      stamps the four fields on the lines it inserted, in the same
--      transaction. ops-api calls v2; v1 keeps every guard it has.
--   3. View job_trade_time_entries: who, which day, start, finish, hours and
--      which invoice, per job. Drafts are not in it.
--   4. Feature flag trade_invoice_time_entry_required_v1, seeded OFF. While
--      off, ops-api stores the fields when sent and refuses nothing for a
--      missing entry; when on, a time line without them is refused
--      `time_entry_required`. Turned on only on the owner's word, after the
--      trade app screens are live.
--   5. Table job_assignment_logged_times: the times a trade typed when they
--      logged a job card's hours on the job view (ops-api log_my_job_hours),
--      one row per card. The Weekly Invoice card opens on them and
--      job_detail lists them against the job until that day is billed; they
--      are never copied onto an invoice line. It is
--      its own table, not columns on job_assignments, because every
--      job_assignments column is inside the make-safe fact hash
--      (stamp_makesafe_fact_identity_v1): new columns there would move the
--      fact version of every make-safe card on its next write.
--
-- start_time and finish_time are text 'HH:MM' (24-hour, Perth local), held to
-- that shape by a CHECK, so every `select *` read of a line already answers
-- the trade app's contract form; a `time` column would answer 'HH:MM:SS'.
-- The view also gives the two instants as timestamptz.
--
-- Rule owner: supabase/functions/ops-api/trade_invoice_time_entry.ts.
-- Contract: docs/trade-invoice-time-entries-2026-10-12.md.
-- Safe to apply twice.

-- ── 1. The four fields on a time line ───────────────────────────────────────
ALTER TABLE public.trade_invoice_lines
  ADD COLUMN IF NOT EXISTS work_date date,
  ADD COLUMN IF NOT EXISTS start_time text,
  ADD COLUMN IF NOT EXISTS finish_time text,
  ADD COLUMN IF NOT EXISTS break_minutes integer;

COMMENT ON COLUMN public.trade_invoice_lines.work_date IS
  'The Perth calendar day this time line was worked. NULL on lines that are not time and on every line saved before 12 Oct 2026.';
COMMENT ON COLUMN public.trade_invoice_lines.start_time IS
  'Start of the shift, HH:MM 24-hour Perth local time. NULL as work_date.';
COMMENT ON COLUMN public.trade_invoice_lines.finish_time IS
  'End of the shift, HH:MM 24-hour Perth local time, after start_time on the same work_date. NULL as work_date.';
COMMENT ON COLUMN public.trade_invoice_lines.break_minutes IS
  'Unpaid break inside the shift, whole minutes. Hours are (finish_time - start_time) - break_minutes.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'trade_invoice_lines_time_entry_check'
      AND conrelid = 'public.trade_invoice_lines'::regclass
  ) THEN
    -- A draft may hold a half-filled entry, so no field requires another.
    -- COLLATE "C": the database collation is ICU, and these are compared as
    -- fixed-width digit strings.
    ALTER TABLE public.trade_invoice_lines
      ADD CONSTRAINT trade_invoice_lines_time_entry_check CHECK (
        (start_time IS NULL OR start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
        AND (finish_time IS NULL OR finish_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
        AND (break_minutes IS NULL OR break_minutes >= 0)
        AND (
          start_time IS NULL OR finish_time IS NULL
          OR finish_time COLLATE "C" > start_time COLLATE "C"
        )
      );
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_trade_invoice_lines_job_work_date
  ON public.trade_invoice_lines (job_id, work_date)
  WHERE work_date IS NOT NULL;

-- ── 2. The dated draft persist stamps the fields ────────────────────────────
-- v1 inserts a fixed column list. Rather than restate its 580 lines, v2 calls
-- it and then stamps the lines it just wrote, matched by the same
-- line_position v1 assigned. One transaction: a failed stamp saves nothing.
CREATE OR REPLACE FUNCTION public.persist_weekly_trade_invoice_v2(
  p_invoice jsonb,
  p_lines jsonb,
  p_requested_prior_draft_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_invoice_id uuid;
BEGIN
  v_invoice_id := public.persist_weekly_trade_invoice_v1(
    p_invoice, p_lines, p_requested_prior_draft_id
  );

  UPDATE public.trade_invoice_lines AS stored
  SET work_date = NULLIF(input.line->>'work_date', '')::date,
      start_time = NULLIF(input.line->>'start_time', ''),
      finish_time = NULLIF(input.line->>'finish_time', ''),
      break_minutes = NULLIF(input.line->>'break_minutes', '')::integer
  FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS input(line, ordinality)
  WHERE stored.trade_invoice_id = v_invoice_id
    AND stored.line_position = COALESCE(
      NULLIF(input.line->>'line_position', '')::integer,
      input.ordinality::integer - 1
    )
    AND (
      NULLIF(input.line->>'work_date', '') IS NOT NULL
      OR NULLIF(input.line->>'start_time', '') IS NOT NULL
      OR NULLIF(input.line->>'finish_time', '') IS NOT NULL
    );

  RETURN v_invoice_id;
END;
$$;

REVOKE ALL ON FUNCTION public.persist_weekly_trade_invoice_v2(jsonb, jsonb, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_weekly_trade_invoice_v2(jsonb, jsonb, uuid)
  TO service_role;

COMMENT ON FUNCTION public.persist_weekly_trade_invoice_v2(jsonb, jsonb, uuid) IS
  'Trade invoice time entries (20261012180000): persist_weekly_trade_invoice_v1 unchanged, then stamps work_date, start_time, finish_time and break_minutes on the lines it inserted, in one transaction.';

-- ── 3. The per-job list ─────────────────────────────────────────────────────
-- One row per submitted time line that says when it was worked. `hours` is
-- the hours the line billed. A draft is a working copy, never a record
-- against the job. The invoice status rides along so a reader can tell an
-- approved entry from one the office rejected. A later change APPENDS columns
-- last: CREATE OR REPLACE VIEW refuses a mid-list insert.
CREATE OR REPLACE VIEW public.job_trade_time_entries
WITH (security_invoker = true) AS
SELECT
  line.id AS trade_invoice_line_id,
  line.job_id,
  line.job_number,
  invoice.user_id,
  trade.name AS user_name,
  line.work_date,
  line.start_time,
  line.finish_time,
  COALESCE(line.break_minutes, 0) AS break_minutes,
  line.total_hours AS hours,
  ((line.work_date + line.start_time::time) AT TIME ZONE 'Australia/Perth') AS started_at,
  ((line.work_date + line.finish_time::time) AT TIME ZONE 'Australia/Perth') AS finished_at,
  line.line_type,
  line.trade_invoice_id,
  invoice.invoice_number,
  invoice.status AS invoice_status,
  invoice.submitted_at
FROM public.trade_invoice_lines AS line
JOIN public.trade_invoices AS invoice
  ON invoice.id = line.trade_invoice_id
LEFT JOIN public.users AS trade
  ON trade.id = invoice.user_id
WHERE line.job_id IS NOT NULL
  AND line.work_date IS NOT NULL
  AND line.start_time IS NOT NULL
  AND line.finish_time IS NOT NULL
  AND invoice.status <> 'draft';

REVOKE ALL ON public.job_trade_time_entries FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.job_trade_time_entries TO service_role;

COMMENT ON VIEW public.job_trade_time_entries IS
  'Trade invoice time entries (20261012180000): per job, who worked which day, from when to when (Perth), the hours billed and the invoice. Submitted invoices only; drafts are left out. Read by ops-api job_detail, which lists times saved on the job view (job_assignment_logged_times) beside it; the context job record may read it the same way.';

-- ── 4. The enforcement flag, off ────────────────────────────────────────────
-- A missing or unreadable flag also reads as off.
INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT
  'trade_invoice_time_entry_required_v1',
  false,
  'Trade invoice time entries: when on, ops-api refuses a trade invoice line that bills time without work_date, start_time and finish_time (time_entry_required). Off: the fields are stored when sent and nothing is refused for a missing entry. Turn on only on the owner''s word, after the trade app screens are live.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.feature_flags
  WHERE flag_name = 'trade_invoice_time_entry_required_v1'
);

-- ── 5. Times saved on the job view ──────────────────────────────────────────
-- One row per job card. `hours` is the hours those times make; ops-api uses
-- the row only while it still equals the card's hours_worked and only for the
-- trade who saved it (user_id), so a later change to the hours by any other
-- writer, or a card handed to another trade, never rides stale times.
CREATE TABLE IF NOT EXISTS public.job_assignment_logged_times (
  assignment_id uuid PRIMARY KEY
    REFERENCES public.job_assignments(id) ON DELETE CASCADE,
  job_id uuid NOT NULL,
  user_id uuid NOT NULL,
  work_date date NOT NULL,
  start_time text NOT NULL,
  finish_time text NOT NULL,
  break_minutes integer NOT NULL DEFAULT 0,
  hours numeric NOT NULL,
  source text,
  logged_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_assignment_logged_times_entry_check CHECK (
    start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND finish_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND finish_time COLLATE "C" > start_time COLLATE "C"
    AND break_minutes >= 0
    AND hours > 0
  )
);

CREATE INDEX IF NOT EXISTS idx_job_assignment_logged_times_job
  ON public.job_assignment_logged_times (job_id, work_date);

ALTER TABLE public.job_assignment_logged_times ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_assignment_logged_times FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_assignment_logged_times TO service_role;

COMMENT ON TABLE public.job_assignment_logged_times IS
  'Trade invoice time entries (20261012180000): the date worked, start and finish time (HH:MM, Perth) and break a trade typed when logging a job card''s hours on the job view (ops-api log_my_job_hours). One row per job card, replaced on a re-log. Read by ops-api my_hours as logged_time_entry and by job_detail as a job''s unbilled time entries; never copied onto an invoice line. Service role only.';
