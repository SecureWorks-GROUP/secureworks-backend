-- ROLLBACK of 20260906150000_jobs_send_runs_claimed_at.sql

alter table public.jobs
  drop column if exists send_runs_claimed_at;
