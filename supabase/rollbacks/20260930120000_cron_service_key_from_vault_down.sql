-- Rollback for 20260930120000_cron_service_key_from_vault.sql.
--
-- USE ONLY IF the rewritten jobs fail at run time because public.sw_service_key()
-- cannot be read from the cron worker. Prefer fixing forward: this puts the
-- service-role key back into cron.job command text, which is the leak Step 2
-- removed. Never run it after Step 4 has put a new key in Vault; it would paste
-- the NEW key into cron.job.
--
-- It restores the previous behaviour without this file carrying a key: the key
-- is read from Vault once, now, and inlined as a literal.
--   - The eleven formerly inline jobs get 'Bearer <key>' back as a literal
--     inside the header expression the migration wrote (same jsonb on the wire
--     as before the migration; not byte-identical command text).
--   - weekly-ceo-financial-brief gets public._sw_service_key() back.
-- Jobs are altered in place, so ids, schedules and active flags are unchanged.
-- Fail-closed: one DO block, and no message carries a command or a key.

DO $$
DECLARE
  c_vault_bearer constant text := '''Bearer '' || public.sw_service_key()';
  c_inline_jobs constant text[] := ARRAY[
    'xero-token-refresh',
    'xero-po-sync',
    'xero-reports-sync',
    'xero-projects-sync',
    'xero-tracking-pl-sync',
    'xero-bank-sync',
    'xero-payables-sync',
    'xero-suppliers-sync',
    'contact-matching',
    'system-health-check',
    'xero-invoice-sync'
  ];
  v_key text;
  j record;
  v_cmd text;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'pg_cron is absent; no cron job to restore';
    RETURN;
  END IF;

  v_key := public.sw_service_key();

  FOR j IN
    SELECT jobid, jobname, command
      FROM cron.job
     WHERE jobname = ANY (c_inline_jobs) OR jobname = 'weekly-ceo-financial-brief'
     ORDER BY jobname, jobid
  LOOP
    IF j.jobname = 'weekly-ceo-financial-brief' THEN
      v_cmd := replace(j.command, 'public.sw_service_key()', 'public._sw_service_key()');
    ELSE
      IF position(c_vault_bearer IN j.command) = 0 THEN
        RAISE NOTICE 'cron job % (id %) is not in the migrated shape; left unchanged',
          j.jobname, j.jobid;
        CONTINUE;
      END IF;
      v_cmd := replace(j.command, c_vault_bearer, quote_literal('Bearer ' || v_key));
    END IF;

    IF v_cmd IS DISTINCT FROM j.command THEN
      PERFORM cron.alter_job(job_id := j.jobid, command := v_cmd);
    END IF;
  END LOOP;
END $$;
