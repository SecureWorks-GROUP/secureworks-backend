-- Rollback for 20261111110000_job_deposit_gate_overrides.sql.
-- Refuses while any override has been recorded: those rows are the only
-- record of who let work go ahead before the deposits, and why. Roll back the
-- matching ops-api first (it reads this table and calls both functions).
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.job_deposit_gate_overrides') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.job_deposit_gate_overrides) THEN
    RAISE EXCEPTION 'deposit gate overrides are recorded; refusing to drop the record';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.grant_job_deposit_gate_override(uuid, uuid, text, jsonb);
DROP FUNCTION IF EXISTS public.revoke_job_deposit_gate_override(uuid, uuid, text);
DROP TABLE IF EXISTS public.job_deposit_gate_overrides;
DROP FUNCTION IF EXISTS public.job_deposit_gate_overrides_guard();

COMMIT;
