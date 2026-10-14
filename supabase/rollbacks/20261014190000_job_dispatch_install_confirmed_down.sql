-- Down for 20261014190000_job_dispatch_install_confirmed. Drops the two checks and the four install
-- confirmation columns, and puts slice 3's comments back. The job_events rows the write left
-- (dispatch_install_confirmed, dispatch_install_confirmed_cleared) are ordinary audit rows and stay.
-- Roll ops-api back first: the deployed pipeline dispatch=1 read and set_dispatch_install_confirmed
-- read these columns.
ALTER TABLE public.job_dispatch_state
  DROP CONSTRAINT IF EXISTS job_dispatch_state_install_confirmed_named,
  DROP CONSTRAINT IF EXISTS job_dispatch_state_install_confirmed_dated;
ALTER TABLE public.job_dispatch_state
  DROP COLUMN IF EXISTS install_confirmed_at,
  DROP COLUMN IF EXISTS install_confirmed_by,
  DROP COLUMN IF EXISTS install_confirmed_by_email,
  DROP COLUMN IF EXISTS install_confirmed_for_day;
COMMENT ON TABLE public.job_dispatch_state IS
  'Dispatch tab (docs/dispatch-slice-3-contract.md): the stage a person set on the job''s Dispatch rail and the next-step line they typed. Never the job status; written only by ops-api set_dispatch_stage / set_dispatch_next_step. A job with no row reads its rail place from its job status (the Repairs board stage for repair).';
COMMENT ON COLUMN public.job_dispatch_state.stage IS
  'One of the six rail stops; null when only a next-step line was saved. not_started is never stored.';
