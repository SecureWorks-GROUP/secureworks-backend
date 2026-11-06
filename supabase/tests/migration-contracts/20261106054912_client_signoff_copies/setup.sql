-- Uses the registered group/sign-off stack, never a second schema definition.
DO $$ BEGIN
  IF to_regclass('public.job_client_signoffs') IS NULL
    OR to_regprocedure('public.group_work_order_release_state(uuid)') IS NULL
 THEN
    RAISE EXCEPTION 'client sign-off prerequisites are missing';
  END IF;
END $$;

-- Supabase owns storage. Mirror the bucket columns this migration uses when
-- the disposable registered stack has no storage service installed.
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets(
 id text PRIMARY KEY,name text NOT NULL,public boolean DEFAULT false,
 file_size_limit bigint,allowed_mime_types text[]
);
