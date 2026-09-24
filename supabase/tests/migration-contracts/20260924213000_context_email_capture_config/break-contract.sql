-- Give monitored_mailboxes the columns the deployed old monitor-inbox path
-- selects. The contract must then fail on E22: the old path could read the
-- seeded list and poll khairo@ and the groups as user mailboxes.
ALTER TABLE public.monitored_mailboxes
 ADD COLUMN id uuid DEFAULT gen_random_uuid(),
 ADD COLUMN email text,
 ADD COLUMN status text DEFAULT 'active',
 ADD COLUMN last_polled_at timestamptz;
