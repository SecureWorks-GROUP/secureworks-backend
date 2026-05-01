-- T5 Iteration 3 — Async extraction queue (NOT YET APPLIED)
--
-- Status: file landed in main, NOT applied to production. Apply only after
-- explicit user approval naming this migration ("apply
-- 20260501160000_extraction_jobs.sql").
--
-- Why:
-- The extractor (Iteration 4) reads raw evidence asynchronously. Raw evidence
-- capture (business_events writes, inbox_events inserts, etc.) MUST NOT block
-- on a model call. This queue is the buffer.
--
-- Rules (from canon: cio/operations/2026-05-01-jarvis-memory-extraction-canon.md):
--   - new raw evidence lands -> create extraction_jobs row
--   - Railway worker processes queue
--   - write context_fact only if worth remembering
--   - extraction is eventually consistent
--   - every queued row must be idempotent
--   - worker must be safe to restart
--   - worker must record skipped/no-fact cases
--
-- Design notes:
--   - Idempotency: UNIQUE (source_table, source_id, extractor_version).
--     Duplicate enqueue → ON CONFLICT DO NOTHING, no error.
--   - Locking: status='processing' with lock_owner + lock_expires_at TTL.
--     Worker restart sweeps stale locks back to pending.
--   - Retry: attempts++ on failure; 'failed' rolls back to 'pending' until
--     attempts >= max_attempts, then 'dead_letter'.
--   - Skip: rows without resolvable job_id (or anything the prefilter
--     rejects) go to 'skipped' with skip_reason. Counted, not retried.
--   - No business action ever. Worker writes only its own status fields.
--   - RLS: service_role full; authenticated SELECT for ops dashboard
--     observability. No anon access.
--
-- Rollback:
--   DROP TABLE public.extraction_jobs CASCADE;

CREATE TABLE IF NOT EXISTS public.extraction_jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Job linkage. Nullable: rows with no resolvable job_id land in
  -- status='skipped' with skip_reason='no_job_id' or 'unresolved_job_id'.
  job_id              uuid REFERENCES public.jobs(id) ON DELETE SET NULL,

  -- Source pointer. (source_table, source_id, extractor_version) is the
  -- idempotency key.
  source_table        text NOT NULL,
  source_id           text NOT NULL,
  source_event_type   text,

  -- Extractor identity. Bumped when extractor logic changes so the same
  -- raw row can be reprocessed by a newer extractor without conflicting
  -- with the old run's done/skipped row.
  extractor_version   text NOT NULL,

  -- Lower number = higher priority. Reserved 1..9 (1 = highest).
  priority            smallint NOT NULL DEFAULT 5
                          CHECK (priority BETWEEN 1 AND 9),

  -- Lifecycle.
  status              text NOT NULL DEFAULT 'pending'
                          CHECK (status IN (
                            'pending',
                            'processing',
                            'done',
                            'skipped',
                            'failed',
                            'dead_letter'
                          )),

  attempts            integer NOT NULL DEFAULT 0,
  max_attempts        integer NOT NULL DEFAULT 3,

  -- Optional dedupe of *content*, not just source pointer. Use when the
  -- same source row could legitimately be enqueued for different reasons
  -- and the extractor wants to dedupe by content hash. Not required.
  dedupe_hash         text,

  -- Locking. lock_expires_at is the TTL — worker restart sweeps stale
  -- locks back to pending so a crashed worker doesn't strand rows.
  lock_owner          text,
  locked_at           timestamptz,
  lock_expires_at     timestamptz,

  -- Timestamps and outcome.
  created_at          timestamptz NOT NULL DEFAULT now(),
  processed_at        timestamptz,
  error               text,         -- last error message on failure
  skip_reason         text,         -- when status='skipped'
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Idempotency: one extraction_jobs row per (source_table, source_id,
-- extractor_version). Duplicate enqueue uses ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_extraction_jobs_dedupe
  ON public.extraction_jobs(source_table, source_id, extractor_version);

-- Pending-row scan (worker dequeue). Partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS idx_extraction_jobs_pending
  ON public.extraction_jobs(priority, created_at)
  WHERE status = 'pending';

-- Stale-lock sweep on worker restart.
CREATE INDEX IF NOT EXISTS idx_extraction_jobs_processing
  ON public.extraction_jobs(lock_expires_at)
  WHERE status = 'processing';

-- Per-job lookup (Iteration 5 evidence-health dashboard).
CREATE INDEX IF NOT EXISTS idx_extraction_jobs_job
  ON public.extraction_jobs(job_id)
  WHERE job_id IS NOT NULL;

-- Dead-letter scan.
CREATE INDEX IF NOT EXISTS idx_extraction_jobs_dead
  ON public.extraction_jobs(created_at DESC)
  WHERE status = 'dead_letter';

ALTER TABLE public.extraction_jobs ENABLE ROW LEVEL SECURITY;

-- Service role: full access (worker writes via service-role).
CREATE POLICY "service_role_all_extraction_jobs"
  ON public.extraction_jobs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Authenticated cockpit users: read-only for ops dashboard observability.
-- No INSERT/UPDATE/DELETE — only the worker writes.
CREATE POLICY "authenticated_read_extraction_jobs"
  ON public.extraction_jobs
  FOR SELECT
  TO authenticated
  USING (true);

GRANT SELECT ON public.extraction_jobs TO authenticated;
GRANT ALL    ON public.extraction_jobs TO service_role;

-- Cursor row pattern from existing context_extractor_state can be reused
-- to track "last evidence row enqueued" if/when the enqueuer is a cron.
-- For first-cut we don't add a separate cursor table; the enqueuer can
-- read max(created_at) of recent extraction_jobs in its own logic.
