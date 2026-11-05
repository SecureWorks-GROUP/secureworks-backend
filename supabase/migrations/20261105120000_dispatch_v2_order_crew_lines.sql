-- Dispatch v2, Tweak 1 (Shaun, 4 Nov 2026): the crew pickup line written once
-- a supplier order is confirmed. One table.
--
-- When a person presses Accept on a supplier reply's date, or moves a supplier
-- box's material stage to Order confirmed, ops-api writes ONE note in the
-- job's crew thread (job_events, event_type 'note', internal only, Office tag,
-- never sent to the client, never synced to GHL), for example
-- "Stratco pickup Tue 3 Nov · from Neerabup · ref 123456". When the date
-- changes later it writes one more short line ("Stratco pickup moved to
-- Thu 5 Nov"). This table remembers each line written for each order, so the
-- same line is never written twice, even when two people press at once.
--
--   seq       1 for the first line on an order, 2 for the next, and so on.
--             Unique per order: a second press racing the first claims the
--             same seq and is refused, so only one note is written.
--   line_date the day the line names (null = ASAP or no date yet).
--
-- Rules: supabase/functions/ops-api/dispatch_v2_order_confirmed.ts. Writer:
-- dispatch_v2_order_confirmed_write.ts. Contract:
-- docs/dispatch-v2-board-contract.md section 3e. Only ops-api writes this
-- table. Row security on with no policy, revoked from the browser roles, as
-- the other dispatch_v2_* tables are.
--
-- No job, job status, supplier (suppliers is never written), Xero, GHL, send
-- or existing row is touched by this migration. No backfill: orders confirmed
-- before it get no line.
--
-- Rollback: supabase/rollbacks/20261105120000_dispatch_v2_order_crew_lines_down.sql.

CREATE TABLE IF NOT EXISTS public.dispatch_v2_order_crew_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  -- The supplier order email (dispatch_supplier_order_emails.id).
  order_id uuid NOT NULL
    REFERENCES public.dispatch_supplier_order_emails(id) ON DELETE CASCADE,
  supplier_id uuid NULL,
  seq integer NOT NULL,
  line_kind text NOT NULL,
  fulfilment text NOT NULL,
  line_date date NULL,
  branch text NULL,
  supplier_ref text NULL,
  line_text text NOT NULL,
  -- What wrote it: Accept on a reply, a stage press, or a by-hand date press.
  trigger text NOT NULL,
  -- The note in the crew thread (job_events.id); null only while it is being
  -- written.
  job_event_id uuid NULL,
  created_by_email text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_v2_order_crew_lines_seq_unique UNIQUE (order_id, seq),
  CONSTRAINT dispatch_v2_order_crew_lines_seq_positive CHECK (seq >= 1),
  CONSTRAINT dispatch_v2_order_crew_lines_kind_valid CHECK (
    line_kind IN ('confirmed', 'moved')
  ),
  CONSTRAINT dispatch_v2_order_crew_lines_fulfilment_valid CHECK (
    fulfilment IN ('pickup', 'delivery')
  ),
  CONSTRAINT dispatch_v2_order_crew_lines_trigger_valid CHECK (
    trigger IN ('accept', 'stage_set', 'date_set')
  )
);

CREATE INDEX IF NOT EXISTS dispatch_v2_order_crew_lines_job_idx
  ON public.dispatch_v2_order_crew_lines (job_id);
CREATE INDEX IF NOT EXISTS dispatch_v2_order_crew_lines_created_idx
  ON public.dispatch_v2_order_crew_lines (created_at);

COMMENT ON TABLE public.dispatch_v2_order_crew_lines IS
  'Dispatch v2 Tweak 1: each crew pickup / delivery line written to a job''s crew thread when a supplier order is confirmed (and when its date moves). One row per line; unique (order_id, seq) so a line is written once.';
COMMENT ON COLUMN public.dispatch_v2_order_crew_lines.line_date IS
  'The day the line names; null = ASAP or no date yet.';
COMMENT ON COLUMN public.dispatch_v2_order_crew_lines.job_event_id IS
  'The job_events note the crew sees; null only while the note is being written.';

ALTER TABLE public.dispatch_v2_order_crew_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.dispatch_v2_order_crew_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.dispatch_v2_order_crew_lines TO service_role;
