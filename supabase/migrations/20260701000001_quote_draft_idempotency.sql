-- quote_draft_idempotency: enforce one live-unsent quote draft per scope
-- so prepare_quote is idempotent.
--
-- "scope" = (job_id, job_contact_id, run_label): the single-quote path has
-- both job_contact_id IS NULL and run_label IS NULL; per-neighbour runs carry
-- their respective non-null values. The coalesce() sentinels below make NULL
-- values participate in the unique index correctly.
--
-- Steps:
--   1. Backfill: supersede any existing duplicate live-unsent drafts, keeping
--      only the single max-by-(version,created_at,id) row per scope.
--   2. Create unique index to enforce the invariant going forward.

-- ── Step 1: supersede older duplicates ──
-- For each scope that has more than one live-unsent quote draft, mark all but
-- the max-(version,created_at,id) row as superseded. The sub-select d2 finds
-- any row in the same scope with a strictly-greater (version,created_at,id)
-- tuple — if one exists, d is not the max, and we mark it superseded.
-- Row-value comparison gives a TOTAL ORDER even when version is equal
-- (e.g. equal-version duplicates from a concurrency bug), so exactly one row
-- survives per scope and CREATE UNIQUE INDEX succeeds on all scopes.
-- sent_to_client IS NOT TRUE matches both false AND NULL, aligning with the
-- IS NOT TRUE predicate used in code (IS NOT TRUE ⊇ = false).
UPDATE job_documents d
SET superseded_at = now()
WHERE type = 'quote'
  AND sent_to_client IS NOT TRUE
  AND superseded_at IS NULL
  AND accepted_at IS NULL
  AND declined_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM job_documents d2
    WHERE d2.type = 'quote'
      AND d2.sent_to_client IS NOT TRUE
      AND d2.superseded_at IS NULL
      AND d2.accepted_at IS NULL
      AND d2.declined_at IS NULL
      AND d2.job_id = d.job_id
      AND d2.job_contact_id IS NOT DISTINCT FROM d.job_contact_id
      AND coalesce(d2.run_label, '') = coalesce(d.run_label, '')
      AND (d2.version, d2.created_at, d2.id) > (d.version, d.created_at, d.id)
  );

-- ── Step 2: unique partial index ──
-- Enforces: at most one live-unsent draft per (job_id, job_contact_id, run_label).
-- "Live-unsent" = sent_to_client IS NOT TRUE AND superseded_at IS NULL AND
--                 accepted_at IS NULL AND declined_at IS NULL.
-- IS NOT TRUE is a valid partial index predicate (immutable boolean expression)
-- and matches both false and NULL rows, closing the NULL-sent_to_client hole.
-- The coalesce() maps NULL job_contact_id → zero UUID and NULL run_label → ''
-- so that (job1, NULL, NULL) is treated as one distinct scope entry (not
-- "multiple NULLs are always unequal" which is the default B-tree behaviour).
CREATE UNIQUE INDEX IF NOT EXISTS ux_job_docs_live_unsent_quote
  ON job_documents (
    job_id,
    coalesce(job_contact_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(run_label, '')
  )
  WHERE type = 'quote'
    AND sent_to_client IS NOT TRUE
    AND superseded_at IS NULL
    AND accepted_at IS NULL
    AND declined_at IS NULL;
