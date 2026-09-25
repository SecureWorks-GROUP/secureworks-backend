-- Put back the column the deployed old monitor-inbox query selects. The
-- contract must then fail on E22: the old path could read the seeded list and
-- poll khairo@ and the groups as user mailboxes.
ALTER TABLE public.monitored_mailboxes ADD COLUMN last_polled_at timestamptz;
