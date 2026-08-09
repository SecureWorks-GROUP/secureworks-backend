-- Make-safe D1 reconcile digest SMS gets an independent kill switch.
-- alarm_enabled remains the shared gate for every other alarm kind.

ALTER TABLE public.makesafe_notify_settings
  ADD COLUMN IF NOT EXISTS d1_reconcile_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.makesafe_notify_settings.d1_reconcile_enabled IS
  'D1 reconcile digest SMS only. FALSE silences D1 without silencing D2-D5/B1 alarms.';
