-- Prerequisites for 20261018140000_context_quote_ask_link.
-- The timeline this replaces is the record-scope body. Production already has
-- quote_revisions.pricing_snapshot_json (20260430160000). The contract runner
-- does not replay that migration; its stub table does not have the column, and
-- a SQL function is checked at CREATE time. Add the column here only. The
-- migration itself adds no column.
ALTER TABLE public.quote_revisions ADD COLUMN IF NOT EXISTS pricing_snapshot_json jsonb;

DO $$
DECLARE live text;
BEGIN
 SELECT md5(p.prosrc) INTO live FROM pg_proc p
 WHERE p.oid = to_regprocedure('public.context_job_record_timeline(uuid[],timestamptz)');
 IF live IS DISTINCT FROM 'fca5eda750a40bbf1f2d8f0e7cf33055' THEN
  RAISE EXCEPTION 'quote ask link setup: timeline is not the record-scope body (md5 %)', coalesce(live, '<missing>');
 END IF;
 IF to_regprocedure('public.job_quote_values(uuid)') IS NULL
    OR to_regprocedure('public.context_job_record_messages(uuid[],timestamptz)') IS NULL THEN
  RAISE EXCEPTION 'quote ask link setup: a function the timeline reads is missing';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'job_documents' AND column_name = 'data_snapshot_json' AND data_type = 'jsonb')
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'pricing_json' AND data_type = 'jsonb')
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'quote_revisions' AND column_name = 'pricing_snapshot_json' AND data_type = 'jsonb') THEN
  RAISE EXCEPTION 'quote ask link setup: a jsonb column the timeline reads is missing';
 END IF;
END $$;
