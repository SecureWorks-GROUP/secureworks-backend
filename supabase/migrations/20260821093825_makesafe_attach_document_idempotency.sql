-- attach_makesafe_document retry guard.
--
-- The Edge handler promises idempotency on (job_id, type, file_name), but a
-- read-before-insert check cannot enforce that promise when two retries race.
-- Keep quote/version history out of scope: this guard covers only the typed
-- MakeSafe attach classes and only their active (not superseded) rows.
--
-- This migration deliberately does not rewrite existing document history.
-- Deployment fails closed if an environment already contains active duplicate
-- keys. Production was read-only censused immediately before this migration was
-- authored and had zero duplicate groups for this predicate.

CREATE UNIQUE INDEX IF NOT EXISTS ux_job_documents_makesafe_attach_key
  ON public.job_documents (job_id, type, file_name)
  WHERE type IN ('work_order', 'makesafe_report', 'roof_report', 'invoice', 'swms')
    AND file_name IS NOT NULL
    AND superseded_at IS NULL;
