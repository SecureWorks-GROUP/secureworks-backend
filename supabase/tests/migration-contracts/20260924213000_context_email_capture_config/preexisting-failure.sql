-- The 2 May T7 draft of monitored_mailboxes (supabase/migrations/_drafts/
-- 20260502000003_monitored_mailboxes.sql, never applied by the repo) already
-- live: a table the deployed old monitor-inbox path would read. EM1 must
-- refuse rather than build on or reshape a table nobody read.
CREATE TABLE public.monitored_mailboxes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 email text NOT NULL UNIQUE,
 enabled boolean NOT NULL DEFAULT true,
 status text NOT NULL DEFAULT 'active',
 last_polled_at timestamptz
);
