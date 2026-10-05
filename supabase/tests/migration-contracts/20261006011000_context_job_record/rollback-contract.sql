-- After the down migration: the five record functions are gone and the ledger
-- tables from the base migration are untouched.
DO $rb$
BEGIN
 IF to_regprocedure('public.context_job_record_timeline(uuid[],timestamptz)') IS NOT NULL
    OR to_regprocedure('public.context_job_record_loops(uuid[],timestamptz)') IS NOT NULL
    OR to_regprocedure('public.context_job_record_money(uuid[],timestamptz)') IS NOT NULL
    OR to_regprocedure('public.context_job_record_contact(uuid[],timestamptz)') IS NOT NULL
    OR to_regprocedure('public.context_job_record_messages(uuid[],timestamptz)') IS NOT NULL THEN
  RAISE EXCEPTION 'record rollback contract: a record function survived the rollback';
 END IF;
 IF to_regclass('public.context_ledger_items') IS NULL THEN
  RAISE EXCEPTION 'record rollback contract: the ledger tables must remain';
 END IF;
END $rb$;
