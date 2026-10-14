-- Dispatch slice 3: the job's Dispatch stage and its next-step line.
--
-- Contract: docs/dispatch-slice-3-contract.md. Reader: ops-api `pipeline` with
-- dispatch=1. Writers: ops-api `set_dispatch_stage` and `set_dispatch_next_step`
-- (supabase/functions/ops-api/dispatch_stage.ts holds the rules), and nothing
-- else.
--
-- One row per job, created on the first press. It is Dispatch's own record and
-- never the job status: a new job status would be refused by jobs_status_check,
-- dropped by the Jobs board and every status reader, and the status writer texts
-- staff, moves the CRM and calls a paid AI read. A press on the rail writes this
-- row and one job_events row, and nothing else.
--
-- Its own table, not a column on jobs and not a key in jobs.metadata: any update
-- to jobs moves jobs.updated_at (trg_jobs_updated), which orders the Dispatch
-- list, and jobs.metadata is one shared blob with no partial update.
--
-- Row security on with no policy, revoked from the browser roles, as
-- quote_builder_versions and job_contacts are: only ops-api reaches it.
--
-- Rollback: supabase/rollbacks/20261014113000_job_dispatch_state_down.sql.

CREATE TABLE IF NOT EXISTS public.job_dispatch_state (
  job_id uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  stage text NULL,
  stage_set_at timestamptz NULL,
  stage_set_by uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
  stage_set_by_email text NULL,
  next_step text NULL,
  next_step_set_at timestamptz NULL,
  next_step_set_by uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
  next_step_set_by_email text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_dispatch_state_stage_valid CHECK (
    stage IS NULL OR stage IN (
      'accepted', 'deposit_paid', 'materials_ordered',
      'supplier_confirmed', 'materials_on_site', 'trade_scheduled'
    )
  ),
  CONSTRAINT job_dispatch_state_stage_dated CHECK ((stage IS NULL) = (stage_set_at IS NULL)),
  -- ops-api trims and collapses the line and stores a cleared line as null.
  CONSTRAINT job_dispatch_state_next_step_length CHECK (
    next_step IS NULL OR (char_length(next_step) BETWEEN 1 AND 40)
  )
);

COMMENT ON TABLE public.job_dispatch_state IS
  'Dispatch tab (docs/dispatch-slice-3-contract.md): the stage a person set on the job''s Dispatch rail and the next-step line they typed. Never the job status; written only by ops-api set_dispatch_stage / set_dispatch_next_step. A job with no row reads its rail place from its job status (the Repairs board stage for repair).';
COMMENT ON COLUMN public.job_dispatch_state.stage IS
  'One of the six rail stops; null when only a next-step line was saved. not_started is never stored.';
COMMENT ON COLUMN public.job_dispatch_state.stage_set_by IS
  'The signed-in user who pressed the stop; null for the privileged ops key, whose operator email is in stage_set_by_email.';

ALTER TABLE public.job_dispatch_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.job_dispatch_state FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.job_dispatch_state TO service_role;
