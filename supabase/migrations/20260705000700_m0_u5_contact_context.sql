-- M0 · U5 — Generalise job_context for contact-level facts (D11)
--   (DRAFT — do not apply without Marnin's go)
--
-- Mission: sales-m0-data-truth-2026-07-05 (Lane B / U5). Store shape = the
-- CP2-accepted Option 1 (Deckhand B's consumer-proofed proposal): EXTEND the
-- existing fact store rather than add a new table. Pre-job conversation facts
-- attach at contact level on the same table job-level facts already use.
--
-- Why this is safe (consumer proof, live 2026-07-05): every reader of
-- job_context filters by job — ops-api (index.ts:6606 .in('job_id'), 7057
-- .eq('job_id')), reporting-api (index.ts:358 .eq('job_id')), and all 8
-- agent readers use .eq('job_id', ...). `job_id = X` is never true for a NULL
-- row, so contact-only rows (job_id NULL) are invisible to every existing
-- job-keyed reader. There is no unfiltered scan or COUNT(*)-all of job_context.
--
-- Additive + reversible. No data is written or moved. Contact-level writes are
-- produced only by the agent extractor behind the OFF flag contact_extraction_v1.
--
-- Grounding (live prod introspection 2026-07-05):
--   contact key = ghl_contact_id (text) — the spine on business_events.contact_id
--     (text, the GHL id) and contact_matches.ghl_contact_id. NOT contact_matches.id
--     (that table is per-job: 758 rows / 658 distinct ghl).
--   job_context today: job_id uuid NOT NULL, FK->jobs.id, no org_id column.

BEGIN;

-- job_id becomes nullable; the FK still holds for non-NULL values (NULL skips it).
ALTER TABLE public.job_context ALTER COLUMN job_id DROP NOT NULL;

-- Contact anchor for pre-job facts (= ghl_contact_id) + org anchor (job_context
-- had no org_id; a contact-only row has no job to derive org from).
ALTER TABLE public.job_context
  ADD COLUMN IF NOT EXISTS contact_key text,
  ADD COLUMN IF NOT EXISTS org_id uuid;

COMMENT ON COLUMN public.job_context.contact_key IS
  'M0/U5: ghl_contact_id for a contact-level fact (job_id NULL). Facts follow the contact by this key; a later job read can union job_id-facts with contact_key-facts. Written only by the agent extractor behind contact_extraction_v1.';
COMMENT ON COLUMN public.job_context.org_id IS
  'M0/U5: org anchor for contact-only rows (no job to derive it from). NULL for legacy job-level rows (org comes from the job). Set on contact-level writes.';

-- Every row must anchor to a job OR a contact. NOT VALID first (fast, no full
-- scan/lock); validated separately below — existing rows all have job_id so it
-- passes. Kept in one migration for the draft; splitting is trivial if a
-- zero-lock apply is needed.
ALTER TABLE public.job_context
  ADD CONSTRAINT job_context_anchor_chk
  CHECK (job_id IS NOT NULL OR contact_key IS NOT NULL) NOT VALID;
ALTER TABLE public.job_context VALIDATE CONSTRAINT job_context_anchor_chk;

-- Contact-key lookups (the M1 texting AI / voice agent read path):
--   SELECT ... FROM job_context WHERE contact_key = :ghl_contact_id ...
CREATE INDEX IF NOT EXISTS job_context_contact_key_idx
  ON public.job_context (contact_key)
  WHERE contact_key IS NOT NULL;

-- RLS note (deferred, intentional): the existing policy
-- authenticated_read_org_job_context is job-derived, so contact-only rows are
-- invisible to authenticated (anon-key) reads. That is fine for M0 — every live
-- reader is a service-role edge function (bypasses RLS). When an authenticated
-- surface needs contact rows, extend the policy with:
--   OR (job_id IS NULL AND org_id = auth_org_id())
-- Not added here to keep U5 to the additive store change.

COMMIT;
