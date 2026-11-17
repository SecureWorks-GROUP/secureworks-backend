-- Focused local bootstrap; preserves the full registered GitHub stack.
\ir ../20261117195201_context_ledger_record_candidates/setup.sql
CREATE TABLE IF NOT EXISTS public.users(id uuid PRIMARY KEY,org_id uuid NOT NULL,name text NOT NULL,role text);
SELECT to_regclass('public.job_pages') IS NULL AS fu23_needs_pages \gset
\if :fu23_needs_pages
\ir ../../../migrations/20261117171302_job_change_marks.sql
\ir ../../../migrations/20261117171304_job_pages.sql
\ir ../../../migrations/20261117172503_job_pages_queue_safety.sql
\endif
SELECT to_regclass('public.job_truth_weekly_samples') IS NULL AS fu23_needs_weekly \gset
\if :fu23_needs_weekly
\ir ../../../migrations/20261117173701_job_truth_weekly_samples.sql
\endif
SELECT to_regprocedure('public.context_ledger_record_candidates(uuid,text,text,timestamptz,text,text)') IS NULL AS fu23_needs_candidates \gset
\if :fu23_needs_candidates
\ir ../../../migrations/20261117210201_context_record_close_obligation_guards.sql
\endif
-- The local bootstrap starts at the same pre-image as main, not a stand-in.
\if :fu23_needs_weekly
\ir ../../../migrations/20261117205501_job_truth_weekly_skip_failed.sql
\endif
