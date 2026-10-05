-- Prerequisites for 20261006013000_context_ledger_store. The registered stack
-- already has jobs, business_events and its triggers, the run and reservation
-- ledgers, the cadence and catch-up functions, the vision admission
-- (20261006001000) and the ledger model (20261006010000). This adds only the
-- live columns the store reads that earlier fixtures never needed, each with
-- its live type, and checks the admission is the pre-image this migration
-- replaces. Nothing here calls or stubs another builder's function.
ALTER TABLE public.inbox_events ADD COLUMN IF NOT EXISTS from_email text;
ALTER TABLE public.inbox_events ADD COLUMN IF NOT EXISTS from_name text;
ALTER TABLE public.inbox_events ADD COLUMN IF NOT EXISTS to_email text;
ALTER TABLE public.inbox_events ADD COLUMN IF NOT EXISTS processed_at timestamptz;
ALTER TABLE public.inbox_events ADD COLUMN IF NOT EXISTS classification text;
ALTER TABLE public.job_assignments ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
CREATE TABLE IF NOT EXISTS public.email_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 email_type text,
 job_id uuid,
 recipient text,
 sender text,
 subject text,
 status text,
 sent_at timestamptz,
 metadata jsonb DEFAULT '{}'::jsonb,
 created_at timestamptz DEFAULT now()
);
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.reserve_context_model_call(text,uuid,uuid)'))
    IS DISTINCT FROM 'f50de57b906f28fc9b5b286821d64cb1' THEN
  RAISE EXCEPTION 'ledger store setup: reserve_context_model_call is not the 20261006001000 body (live md5 f50de57b906f28fc9b5b286821d64cb1)';
 END IF;
 IF to_regclass('public.context_ledger_items') IS NULL THEN
  RAISE EXCEPTION 'ledger store setup: the ledger model (20261006010000) is missing';
 END IF;
END $$;
