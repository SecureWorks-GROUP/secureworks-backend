-- Executed against disposable PostgreSQL after the migration.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'job_documents'
      AND column_name = 'trade_pack_json'
      AND data_type = 'jsonb'
  ) THEN
    RAISE EXCEPTION 'job_documents.trade_pack_json is missing';
  END IF;
END;
$$;

INSERT INTO public.job_documents (id, type, quote_number, trade_pack_json)
VALUES (
  '20000000-0000-4000-8000-000000000001',
  'quote',
  'SWF-26001-Q1',
  '{"quote_number":"SWF-26001-Q1","items":[],"source":"frozen"}'::jsonb
);

ROLLBACK;
