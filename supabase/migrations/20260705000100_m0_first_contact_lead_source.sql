-- M0 · U2 — First-contact + lead-source (DRAFT — do not apply without Marnin's go)
--
-- Mission: sales-m0-data-truth-2026-07-05 (Lane A / U2). Contract §2a call 2 + call 3.
--
-- Adds the columns that make the sales funnel measurable:
--   * contact_matches.contact_first_seen_at  — LIFETIME first touch for a
--     contact (monotonic min across all their eligible touches). Contact-level.
--   * jobs.first_contacted_at / first_contact_channel / first_contact_direction
--     — PER-EPISODE first touch. An episode == a GHL opportunity, and the only
--     durable per-opportunity record in prod is `jobs` (jobs.ghl_opportunity_id).
--     No opportunities/lead_episodes table exists, and contact_matches.job_id
--     FK-requires the job to already exist, so it cannot hold a pre-job episode
--     stamp — therefore jobs is both the natural and the only home for the
--     episode stamp. (If a future mission first-classes opportunities pre-job,
--     the stamp moves there and jobs mirrors it.)
--   * jobs.lead_source — attribution source, propagated from the existing
--     contact_matches attribution write at job creation. Non-form leads get
--     'unattributed' (the CHANNEL never becomes the lead source).
--
-- All columns are nullable + additive. Stamping is gated behind the NEW flag
-- `first_contact_stamp_v1` (default OFF) so a deployed-but-unmigrated writer
-- stays inert until this migration lands AND Marnin flips the flag.
--
-- Grounding (live prod introspection 2026-07-05):
--   business_events.contact_id is TEXT (the GHL contact id) == contact_matches.ghl_contact_id
--   direction domain: inbound / outbound / internal / null
--   channel   domain: email / sms / call / telegram / quote / note / ...
--   Existing indexes idx_events_contact_occurred(contact_id, occurred_at) and
--   idx_events_job(job_id) already cover the stamping/backfill min-scans.

BEGIN;

-- ── Contact-level lifetime first-seen ────────────────────────────────────────
ALTER TABLE public.contact_matches
  ADD COLUMN IF NOT EXISTS contact_first_seen_at timestamptz;

COMMENT ON COLUMN public.contact_matches.contact_first_seen_at IS
  'M0/U2: lifetime first inbound/outbound touch (sms|call|email) for this contact across all episodes. Monotonic min; backdates idempotently on late resolution. NOT speed-to-lead (that is per-episode on jobs.first_contacted_at).';

-- ── Per-episode first contact (episode == GHL opportunity == this job) ────────
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS first_contacted_at     timestamptz,
  ADD COLUMN IF NOT EXISTS first_contact_channel  text,
  ADD COLUMN IF NOT EXISTS first_contact_direction text,
  ADD COLUMN IF NOT EXISTS lead_source            text;

COMMENT ON COLUMN public.jobs.first_contacted_at IS
  'M0/U2: first inbound/outbound touch (sms|call|email) for THIS episode (this GHL opportunity), i.e. the earliest eligible touch after the prior episode ended. Speed-to-lead is measured from here. A repeat client''s new opportunity never inherits an old timestamp.';
COMMENT ON COLUMN public.jobs.first_contact_channel IS
  'M0/U2: channel of the episode first touch (sms|call|email).';
COMMENT ON COLUMN public.jobs.first_contact_direction IS
  'M0/U2: direction of the episode first touch (inbound|outbound).';
COMMENT ON COLUMN public.jobs.lead_source IS
  'M0/U2: attribution source propagated from contact_matches at job creation (e.g. google_ads). Non-form / unattributed leads store ''unattributed'' — the comms channel is NEVER used as the lead source.';

-- Composite index to bound episode windows cheaply (prior-episode lookup by
-- contact ordered by created_at). Partial to match the existing idx_jobs_ghl.
CREATE INDEX IF NOT EXISTS idx_jobs_ghl_created
  ON public.jobs (ghl_contact_id, created_at)
  WHERE ghl_contact_id IS NOT NULL;

-- ── Kill-switch flag (default OFF) ───────────────────────────────────────────
-- Stamping at record_evidence + job-creation propagation both check this flag.
-- Stays OFF until the columns above are live AND Marnin approves the flip.
INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES (
  'first_contact_stamp_v1',
  false,
  'M0/U2: enables first-contact + lead-source stamping at the record_evidence choke point and at job creation. OFF until migration 20260705000100 is applied and Marnin approves.'
)
ON CONFLICT (flag_name) DO NOTHING;

COMMIT;
