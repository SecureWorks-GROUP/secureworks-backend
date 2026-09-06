-- In-flight lock for send-quote /send-runs. Not a client-send publication.
-- Exclusive while a send-runs create+email+publish is in progress.
-- Stale claims expire and may be reclaimed so a crashed worker cannot
-- permanently block the next send-runs call.

alter table public.jobs
  add column if not exists send_runs_claimed_at timestamptz;

comment on column public.jobs.send_runs_claimed_at is
  'In-flight send-runs claim. Cleared when the handler finishes. Stale claims expire and may be reclaimed. Not quote-pack publication.';
