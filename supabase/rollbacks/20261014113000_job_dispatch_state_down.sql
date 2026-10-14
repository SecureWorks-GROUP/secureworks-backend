-- Down for 20261014113000_job_dispatch_state. Drops the Dispatch stage table and nothing else:
-- the job_events rows the two Dispatch writes left (dispatch_stage_changed, dispatch_next_step_set)
-- are ordinary audit rows and stay. Roll ops-api back first: the deployed pipeline dispatch=1 read
-- and the two Dispatch writes read this table.
DROP TABLE IF EXISTS public.job_dispatch_state;
