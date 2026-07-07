-- ════════════════════════════════════════════════════════════
-- MAKE-SAFE HYBRID LOOP — schema (W3-A, 2026-07-08 overnight)
-- Mission: makesafe-system wave-3-hybrid-loop-2026-07-08 (M-E standing loop)
-- ════════════════════════════════════════════════════════════
--
-- The hybrid standing reconciliation loop (DESIGN.md): a cheap backend pass runs
-- continuously and emits the story verdicts it can HONESTLY reach from backend
-- evidence, and stamps the cards whose expensive legs (portal / deeper mail) still
-- need an agent into the EXISTING W2-C portal-recheck queue. This migration adds
-- the two backend surfaces the pass needs:
--
--   1. emails.folder — folder tag so the SAME email store can hold BOTH the ses@
--      inbound group mirror (folder NULL, unchanged) AND the admin@ Sent-Items
--      mirror (folder = 'sentitems'), which unlocks backend send-attribution.
--      `mailbox` stays the primary discriminator; `folder` sub-tags within it.
--
--   2. makesafe_card_story — the cheap-pass output: one row per ACTIVE make-safe
--      card that the pass gave a backend-honest verdict, with the evidence gaps
--      and the delta fingerprint that drives incremental recompute.
--
-- Safety: ADDITIVE ONLY. No existing rows altered, no data destroyed, no sends,
-- no invoice changes, no substatus advancement (item-14 guard is law — the pass
-- that writes these tables never advances a card). Apply via the standard
-- migration-approval gate before prod. INERT on apply: no cron is started here
-- (the companion 20260709000002 registers the schedules, still gated by
-- makesafe_cron_enabled()).

-- ── 1) emails.folder — Sent-Items mirror tag (backend send-attribution) ──
ALTER TABLE public.emails
  ADD COLUMN IF NOT EXISTS folder text;

COMMENT ON COLUMN public.emails.folder IS
  'Mail-folder tag WITHIN a mailbox. NULL = the ses@ inbound group mirror (unchanged, the only historical writer). ''sentitems'' = the admin@ Sent-Items mirror (W3-A) that carries our outbound make-safe pack sends, enabling backend send-attribution. mailbox stays the primary discriminator; folder sub-tags within it.';

-- Lookup index for the Sent-Items send-attribution scan (mailbox + folder scan of
-- outbound pack sends within a recent window).
CREATE INDEX IF NOT EXISTS idx_emails_mailbox_folder
  ON public.emails (mailbox, folder, received_at DESC);

-- ── 2) makesafe_card_story — cheap-pass verdict cache (additive) ──
-- One row per ACTIVE make-safe card the cheap pass gave a backend-honest verdict.
-- Cleanly-closed cards (complete + corroborated send/paid) get NO row — the fix
-- list only ever carries cards with something to reconcile. story_verdict is
-- limited to what backend evidence can honestly support:
--   NOT-STARTED / CANCELLED / CANCELLED-CONFLICT / SENT-UNRECORDED /
--   DECISION_NEEDED / UNVERIFIED-needs-agent
-- The pass NEVER writes a GENUINELY-UNSENT / DONE verdict (those need the portal +
-- full-mailbox legs only an agent can prove) — such cards fail closed to
-- UNVERIFIED-needs-agent and are stamped into the W2-C recheck queue.
CREATE TABLE IF NOT EXISTS public.makesafe_card_story (
  job_id             uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
  -- The backend-honest verdict (one of the vocabulary above).
  story_verdict      text NOT NULL,
  -- Non-gating evidence gaps (why a confident verdict is/ isn't reachable, which
  -- legs an agent still has to run). Plain-English strings, audit + fix-list copy.
  evidence_gaps      jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The raw backend signals the verdict was computed from (audit trail; lets the
  -- board explain a verdict without re-running the pass).
  signals            jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Blockers: the human-readable reason(s) the verdict carries (mirrors the wiki
  -- reconciler's `blockers`), e.g. the near-double-send warning on SENT-UNRECORDED.
  blockers           jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- TRUE when the card needs an agent leg (portal capture / live mailbox sweep) to
  -- reach a confident verdict (verdict = UNVERIFIED-needs-agent).
  needs_agent        boolean NOT NULL DEFAULT false,
  -- TRUE when THIS pass stamped the card into the W2-C portal-recheck queue
  -- (report-type + portal link + not verified this cycle). Reuses the recheck
  -- columns on makesafe_job_details; never a second queue.
  recheck_enqueued   boolean NOT NULL DEFAULT false,
  -- Denormalised builder ref for fix-list display (audit only).
  external_ref       text,
  -- Delta fingerprint: a stable digest of the CHEAP signals (substatus, invoice,
  -- markers, cancellation, sent-mirror hits, job.updated_at). The pass recomputes a
  -- card only when this changes or the row is > 24h stale (the DESIGN delta rule).
  signal_fingerprint text,
  computed_at        timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_makesafe_card_story_verdict
  ON public.makesafe_card_story (story_verdict);
CREATE INDEX IF NOT EXISTS idx_makesafe_card_story_needs_agent
  ON public.makesafe_card_story (needs_agent) WHERE needs_agent;
CREATE INDEX IF NOT EXISTS idx_makesafe_card_story_computed
  ON public.makesafe_card_story (computed_at DESC);

-- RLS: service-role only (same posture as the whole email-sync schema; the
-- dashboard reads the verdict THROUGH the ops-api makesafe_audit payload, never
-- the table directly).
ALTER TABLE public.makesafe_card_story ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.makesafe_card_story TO service_role;
DROP POLICY IF EXISTS service_role_all ON public.makesafe_card_story;
CREATE POLICY service_role_all ON public.makesafe_card_story
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.makesafe_card_story IS
  'Cheap-pass (W3-A hybrid loop) backend-honest story verdict per ACTIVE make-safe
   card. Additive display cache; the pass that writes it NEVER advances substatus,
   creates invoices, sends, or SMSs (item-14 guard is law). Cleanly-closed cards get
   no row. Verdicts limited to what backend evidence honestly supports; anything
   needing portal / full-mailbox legs fails closed to UNVERIFIED-needs-agent and is
   stamped into the W2-C recheck queue.';
