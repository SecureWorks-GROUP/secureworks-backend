-- MakeSafe Reporting Autopilot (Wave 3) -- threaded feedback notes on a make-safe
-- DRAFT (report / intake). The reviewing human leaves a note on a draft; the
-- make-safe routine reads unaddressed human notes, re-runs the draft render in
-- response, marks those notes addressed, and posts an agent-reply note.
--
-- Purpose:
--   A durable, threaded conversation per (job_id, draft_kind) so the human <-> agent
--   loop survives a session boundary. The routine's "what must I respond to?" query
--   is `role='human' AND addressed=false` (the noteIsAddressable filter). After it
--   re-renders, it flips those rows addressed=true and appends its own role='agent'
--   reply note.
--
-- Safety:
--   This migration is ADDITIVE ONLY. No cron. It never sends a message, authorises
--   or voids an invoice, creates a job, or mutates any existing make-safe state.
--   The board stage stays driven off makesafe_job_details.substatus exactly as before.
--
-- NAMESPACE-ISOLATION GUARD (defence in depth):
--   A note body must NEVER be (or begin with) the MAKESAFE_PACK_SENT marker. The
--   send-marker is the irreversible "this pack was emailed" breadcrumb written by
--   makesafe_send_pack into business_events; a draft note must never be confusable
--   with it. The authoritative runtime check is in the ops-api add_draft_note action
--   (rejectIfPackSentMarker, returns 400). This trigger is belt-and-braces: a hard
--   row-level reject so even a direct/service-role insert can never plant a
--   pack-sent marker as a note.

CREATE TABLE IF NOT EXISTS public.draft_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',

  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,

  -- which draft this note belongs to (e.g. 'makesafe_report', 'makesafe_intake').
  -- Lets one job carry independent note threads per draft artifact.
  draft_kind text NOT NULL DEFAULT 'makesafe_report',

  -- the user name (human) or 'MAKESAFE_AGENT_REPLY' / 'MAKESAFE_AGENT' for the routine.
  author text NOT NULL,

  -- 'human' = a reviewer's note (addressable). 'agent' = the routine's reply note.
  role text NOT NULL DEFAULT 'human' CHECK (role IN ('human', 'agent')),

  body text NOT NULL,

  -- human notes: the routine reads `addressed=false AND role='human'` and flips this
  -- true once it has re-rendered + replied. Agent notes stay addressed=false (nothing
  -- to address) and are simply never matched by the addressable filter.
  addressed boolean NOT NULL DEFAULT false,

  created_at timestamptz NOT NULL DEFAULT now()
);

-- The routine's hot query: unaddressed human notes for an org's jobs.
CREATE INDEX IF NOT EXISTS idx_draft_notes_org_job_addressed
  ON public.draft_notes (org_id, job_id, addressed);

-- Thread render for the cockpit: all notes for a job.
CREATE INDEX IF NOT EXISTS idx_draft_notes_job
  ON public.draft_notes (job_id);

ALTER TABLE public.draft_notes ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'draft_notes'
      AND policyname = 'service_role_all_draft_notes'
  ) THEN
    CREATE POLICY "service_role_all_draft_notes"
      ON public.draft_notes FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END$$;

-- ── Namespace-isolation trigger (belt-and-braces; the action enforces it first) ──
-- Reject any note whose body is, or begins with, the MAKESAFE_PACK_SENT marker.
-- A pack-sent marker is the send breadcrumb; it must never live in draft_notes.
CREATE OR REPLACE FUNCTION public.reject_pack_sent_marker_draft_note()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.body IS NOT NULL AND ltrim(NEW.body) LIKE 'MAKESAFE_PACK_SENT%' THEN
    RAISE EXCEPTION 'draft_notes.body must not be a pack-sent marker (namespace isolation)';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_reject_pack_sent_marker_draft_note'
      AND tgrelid = 'public.draft_notes'::regclass
  ) THEN
    CREATE TRIGGER trg_reject_pack_sent_marker_draft_note
      BEFORE INSERT OR UPDATE ON public.draft_notes
      FOR EACH ROW
      EXECUTE FUNCTION public.reject_pack_sent_marker_draft_note();
  END IF;
END$$;

COMMENT ON TABLE public.draft_notes IS
  'Wave 3 threaded feedback notes on a make-safe DRAFT (report/intake), one thread per (job_id, draft_kind). Human notes (role=human, addressed=false) are the routine''s re-run queue; the routine flips them addressed and appends a role=agent reply note. Additive, RLS service_role only. A row-level trigger rejects any body that is a MAKESAFE_PACK_SENT marker (namespace isolation, defence in depth behind the add_draft_note action check). No cron, no sends.';
