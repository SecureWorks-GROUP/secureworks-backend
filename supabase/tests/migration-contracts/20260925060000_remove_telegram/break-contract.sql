-- Re-admit telegram on one CHECK, as a migration that missed it would leave it.
ALTER TABLE public.intention_log DROP CONSTRAINT intention_log_channel_check,
  ADD CONSTRAINT intention_log_channel_check CHECK (channel IN ('telegram','web','api','system','cron'));
