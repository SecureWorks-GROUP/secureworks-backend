-- Named lead installer on a job's crew.
--
-- The crew model already exists: job_assignments is one row per crew member per
-- job, and tradeJobDetail already returns it as `crew`. What does NOT exist is a
-- way to say WHICH of them leads the job.
--
-- job_assignments.role cannot answer that question and must not be repurposed:
-- it defaults to 'lead_installer' (see the create table in
-- 20250301000001_schema.sql and `role: role || 'lead_installer'` in ops-api
-- createAssignment), so essentially every row already claims to be a lead. A
-- read-only production sample on 2026-08-03 (24 jobs carrying assignments,
-- 133 non-cancelled rows) measured role as lead_installer x112 / observer x21,
-- with 19 of 24 jobs carrying two or more 'lead_installer' rows and one job
-- carrying 28. Reading a lead out of that column would name an arbitrary person
-- on almost every job in the business.
--
-- So this adds an explicit flag and DELIBERATELY DOES NOT BACKFILL IT. Every
-- existing job ships with no lead, which is the honest state: nobody has ever
-- been designated. Ops names a lead per job through the ops-api `set_job_lead`
-- action, which is authorised by the SAME rule that authorises creating the
-- assignment in the first place (_resolveAllocationAuthz).
--
-- The partial unique index is the guarantee that "lead" means one person: the
-- database, not application code, is what makes a second lead impossible.
--
-- Additive and reversible. Writes no operational row, moves no board stage, and
-- touches no money column. Apply BEFORE the matching ops-api deploy — the trade
-- crew select names is_lead, and per AGENTS.md a missing column comes back as a
-- PostgREST 400 that degrades to an EMPTY crew list rather than an error.

ALTER TABLE job_assignments
  ADD COLUMN IF NOT EXISTS is_lead boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN job_assignments.is_lead IS
  'True for the one crew member designated lead installer on this job. Never backfilled: absent designation is represented as no lead at all, not as a guess. Set via ops-api set_job_lead.';

-- At most one lead per job. Partial, so the false rows (every row today) are not
-- indexed and cannot collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_assignments_one_lead
  ON job_assignments (job_id)
  WHERE is_lead;
