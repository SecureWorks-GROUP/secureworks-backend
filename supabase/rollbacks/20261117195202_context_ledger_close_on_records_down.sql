DROP FUNCTION IF EXISTS public.context_ledger_record_close_undo(timestamptz);
DROP FUNCTION IF EXISTS public.context_ledger_close_on_records(uuid,boolean);
DROP INDEX IF EXISTS public.context_ledger_record_close_at;
