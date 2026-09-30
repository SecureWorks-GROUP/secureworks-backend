-- Take the service-role key out of pg_cron command text (legacy-key removal,
-- Step 2).
--
-- Production still has 11 cron jobs whose cron.job.command carries the
-- service-role JWT as a pasted literal inside the pg_net headers, and one,
-- weekly-ceo-financial-brief, that calls the legacy helper _sw_service_key().
-- Anyone who can read cron.job reads the key, and a rotation would mean
-- editing twelve commands. After this migration every one of them reads the key
-- at run time through the fail-closed Vault accessor public.sw_service_key(),
-- so Vault is the only place the key lives and a rotation is one Vault update.
--
-- Some of these commands exist only in production, so nothing here restates a
-- command. Each named job is rewritten IN PLACE with cron.alter_job: jobid,
-- schedule, active flag, database and owner are untouched, and only the key
-- source inside the command changes. A pasted key is anything JWT-shaped or
-- the Vault key's own value.
--   - An inline header literal '{..."Authorization":"Bearer <key>"...}'::jsonb
--     becomes ('{<the other headers, verbatim>}'::jsonb
--               || jsonb_build_object('Authorization', 'Bearer ' || public.sw_service_key())).
--   - A 'Bearer <key>' SQL string literal (for example inside
--     jsonb_build_object, the shape the rollback writes) becomes
--     'Bearer ' || public.sw_service_key().
--   - A _sw_service_key() / public._sw_service_key() call becomes
--     public.sw_service_key().
--
-- This is a pure refactor of WHERE the key comes from, never WHICH key is sent:
-- the migration refuses a job whose pasted key is not byte-identical to the
-- Vault key, so the requests on the wire are unchanged. It does not rotate the
-- key (Step 4 does). The Vault path is already proven in the cron worker: jobs
-- 70/73/90 and the make-safe triggers read it on every run.
--
-- The repo's earlier attempt at this, 20260717000001_cron_vault_service_key.sql,
-- is below the auto-apply baseline and was never applied (the literal was still
-- live on 2026-09-29). This migration supersedes it without its trigger
-- functions, because it does not need to know each live command.
--
-- Fail-closed: the whole migration is one DO block, so any refusal changes no
-- job. No message it raises carries a command or a key.
--
-- Run first: scripts/cron-service-key-precheck.sql (read-only).
-- Verify after: scripts/cron-service-key-postcheck.sql (read-only).
-- Rollback: supabase/rollbacks/20260930120000_cron_service_key_from_vault_down.sql.

DO $$
DECLARE
  c_jwt constant text := 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+';
  c_legacy_helper constant text :=
    '(?<![A-Za-z0-9_.$])(public\.)?_sw_service_key\s*\(\s*\)';
  c_header_literal constant text := '''(\{[^'']*\})''::jsonb';
  c_bearer_literal constant text := '''Bearer ([^'']+)''';
  -- Report 2026-09-29 section 4b: the 11 inline-literal jobs, then the one
  -- that calls the legacy helper.
  c_jobs constant text[] := ARRAY[
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
    'xero-invoice-sync',
    'weekly-ceo-financial-brief'
  ];
  v_is_superuser boolean;
  v_vault_key text;
  v_name text;
  j record;
  m text[];
  v_headers jsonb;
  v_cmd text;
  v_rewritten integer := 0;
  v_leftover text;
BEGIN
  -- A database without pg_cron (a fresh migration-provisioned one) has no job
  -- to rewrite.
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'pg_cron is absent; no cron job to rewrite';
    RETURN;
  END IF;

  -- Fails closed (RAISE) when Vault is missing, empty or malformed, before any
  -- job is touched.
  v_vault_key := public.sw_service_key();

  SELECT rolsuper INTO v_is_superuser FROM pg_roles WHERE rolname = current_user;

  FOREACH v_name IN ARRAY c_jobs LOOP
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = v_name) THEN
      RAISE NOTICE 'cron job % is absent; nothing to rewrite', v_name;
    END IF;
  END LOOP;

  FOR j IN
    SELECT jobid, jobname, username, command
      FROM cron.job
     WHERE jobname = ANY (c_jobs)
     ORDER BY jobname, jobid
  LOOP
    IF j.command !~ c_jwt
       AND strpos(j.command, v_vault_key) = 0
       AND j.command !~ c_legacy_helper THEN
      RAISE NOTICE 'cron job % (id %) carries no pasted key and no legacy helper; left unchanged',
        j.jobname, j.jobid;
      CONTINUE;
    END IF;

    -- cron.alter_job only lets a job's owner (or a superuser) change it; say
    -- so plainly instead of surfacing pg_cron's "could not find valid entry".
    IF j.username IS DISTINCT FROM current_user AND NOT coalesce(v_is_superuser, false) THEN
      RAISE EXCEPTION 'cron job % (id %) is owned by %, not %; cannot rewrite it',
        j.jobname, j.jobid, j.username, current_user;
    END IF;

    -- The job must be able to read Vault once its literal is gone.
    IF NOT has_function_privilege(j.username, 'public.sw_service_key()', 'EXECUTE') THEN
      RAISE EXCEPTION 'cron job % (id %) runs as %, which cannot execute public.sw_service_key()',
        j.jobname, j.jobid, j.username;
    END IF;

    v_cmd := j.command;

    FOR m IN SELECT regexp_matches(j.command, c_header_literal, 'g') LOOP
      CONTINUE WHEN m[1] !~ c_jwt AND strpos(m[1], v_vault_key) = 0;

      v_headers := m[1]::jsonb;
      IF v_headers->>'Authorization' IS DISTINCT FROM 'Bearer ' || v_vault_key THEN
        RAISE EXCEPTION 'cron job % (id %): its inline Authorization header is not "Bearer <Vault service_role_key>"; refusing to change which key it sends',
          j.jobname, j.jobid;
      END IF;
      IF (v_headers - 'Authorization')::text ~ c_jwt
         OR strpos((v_headers - 'Authorization')::text, v_vault_key) > 0 THEN
        RAISE EXCEPTION 'cron job % (id %) carries a key outside its Authorization header',
          j.jobname, j.jobid;
      END IF;

      v_cmd := replace(
        v_cmd,
        '''' || m[1] || '''::jsonb',
        format(
          '(%L::jsonb || jsonb_build_object(%L, %L || public.sw_service_key()))',
          (v_headers - 'Authorization')::text,
          'Authorization',
          'Bearer '
        )
      );
    END LOOP;

    FOR m IN SELECT regexp_matches(v_cmd, c_bearer_literal, 'g') LOOP
      CONTINUE WHEN m[1] !~ ('^' || c_jwt || '$') AND m[1] IS DISTINCT FROM v_vault_key;

      IF m[1] IS DISTINCT FROM v_vault_key THEN
        RAISE EXCEPTION 'cron job % (id %): its inline Authorization header is not "Bearer <Vault service_role_key>"; refusing to change which key it sends',
          j.jobname, j.jobid;
      END IF;
      v_cmd := replace(v_cmd, '''Bearer ' || m[1] || '''', '''Bearer '' || public.sw_service_key()');
    END LOOP;

    v_cmd := regexp_replace(v_cmd, c_legacy_helper, 'public.sw_service_key()', 'g');

    -- Any shape the rewrites did not recognise leaves its key behind.
    IF v_cmd ~ c_jwt OR strpos(v_cmd, v_vault_key) > 0 THEN
      RAISE EXCEPTION 'cron job % (id %) still carries a pasted key in an unrecognised shape; rewrite it by hand',
        j.jobname, j.jobid;
    END IF;
    IF v_cmd ~ '_sw_service_key' THEN
      RAISE EXCEPTION 'cron job % (id %) still references _sw_service_key in an unrecognised shape; rewrite it by hand',
        j.jobname, j.jobid;
    END IF;

    PERFORM cron.alter_job(job_id := j.jobid, command := v_cmd);
    v_rewritten := v_rewritten + 1;
  END LOOP;

  RAISE NOTICE 'rewrote % cron job(s) to read the service key from Vault', v_rewritten;

  -- Fail the migration rather than report the key gone while any job, named or
  -- not, still carries one. Job names only; never the command.
  SELECT string_agg(format('%s (id %s)', jobname, jobid), ', ' ORDER BY jobid)
    INTO v_leftover
    FROM cron.job
   WHERE command ~ c_jwt OR strpos(command, v_vault_key) > 0;
  IF v_leftover IS NOT NULL THEN
    RAISE EXCEPTION 'cron jobs still carry a pasted service key: %', v_leftover;
  END IF;
END $$;
