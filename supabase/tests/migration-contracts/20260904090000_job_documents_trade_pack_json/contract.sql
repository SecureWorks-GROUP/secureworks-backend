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

ROLLBACK;
