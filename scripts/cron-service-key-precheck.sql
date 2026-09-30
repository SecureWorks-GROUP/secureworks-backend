-- Read-only pre-check for 20260930120000_cron_service_key_from_vault.sql.
--
-- Run each numbered query on its own (the Supabase SQL connector returns one
-- result set per call), as postgres, BEFORE applying the migration, and keep
-- the output: the post-check compares against it.
--
-- Every query is a plain SELECT. No key is ever returned: JWT-shaped strings
-- are replaced by <JWT> or reduced to a 6-hex sha256 fingerprint inside SQL,
-- and the Vault key is only ever compared, never selected out. Queries 2 and 3
-- call public.sw_service_key(); if Vault is missing or malformed they raise,
-- and so would the migration.
--
-- The migration treats as a pasted key anything JWT-shaped or equal to the
-- Vault key's own value. In production public.sw_service_key() only ever
-- returns a JWT, so the JWT checks below cover both.
--
-- Go / no-go: apply only when query 3 shows `rewrite` (or `absent` /
-- `unchanged`) for all twelve jobs and query 4 returns no rows. Any `REFUSE`
-- names the precondition the migration would fail on; it would change nothing.

-- 1. Session, pg_cron and the ledger slot.
SELECT current_user,
       (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser,
       (SELECT extversion FROM pg_extension WHERE extname = 'pg_cron') AS pg_cron_version,
       to_regprocedure('cron.alter_job(bigint,text,text,text,text,boolean)') IS NOT NULL AS has_alter_job,
       to_regprocedure('public.sw_service_key()') IS NOT NULL AS has_vault_accessor,
       (SELECT array_agg(version || ' ' || coalesce(name, '') ORDER BY version)
          FROM supabase_migrations.schema_migrations
         WHERE version >= '20260930000000') AS ledger_since_2026_09_30,
       EXISTS (
         SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260930120000'
       ) AS version_20260930120000_taken;

-- 2. Vault key fingerprint (compare with the report's 4595ba).
SELECT left(encode(sha256(convert_to(public.sw_service_key(), 'UTF8')), 'hex'), 6) AS vault_key_fp,
       length(public.sw_service_key()) AS vault_key_length;

-- 3. The twelve named jobs: live state, every precondition the migration
--    checks, the outcome it would reach, and the command with keys redacted.
WITH params AS (
  SELECT 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'::text AS jwt,
         '(?<![A-Za-z0-9_.$])(public\.)?_sw_service_key\s*\(\s*\)'::text AS legacy_helper,
         '''(\{[^'']*\})''::jsonb'::text AS header_literal,
         public.sw_service_key() AS vault_key,
         (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser
),
named AS (
  SELECT * FROM unnest(ARRAY[
    'xero-token-refresh', 'xero-po-sync', 'xero-reports-sync',
    'xero-projects-sync', 'xero-tracking-pl-sync', 'xero-bank-sync',
    'xero-payables-sync', 'xero-suppliers-sync', 'contact-matching',
    'system-health-check', 'xero-invoice-sync', 'weekly-ceo-financial-brief'
  ]) WITH ORDINALITY AS n(jobname, ord)
),
facts AS (
  SELECT n.ord, n.jobname, j.jobid, j.schedule, j.active, j.username, j.database,
    (SELECT count(*) FROM regexp_matches(j.command, p.jwt, 'g')) AS jwt_count,
    (SELECT array_agg(left(encode(sha256(convert_to(t[1], 'UTF8')), 'hex'), 6))
       FROM regexp_matches(j.command, '(' || p.jwt || ')', 'g') t) AS jwt_fps,
    (SELECT array_agg(
         CASE WHEN convert_from(decode(rpad(translate(split_part(t[1], '.', 2), '-_', '+/'),
                  ((length(split_part(t[1], '.', 2)) + 3) / 4) * 4, '='), 'base64'), 'UTF8') LIKE '{%'
              THEN convert_from(decode(rpad(translate(split_part(t[1], '.', 2), '-_', '+/'),
                  ((length(split_part(t[1], '.', 2)) + 3) / 4) * 4, '='), 'base64'), 'UTF8')::jsonb->>'role'
         END)
       FROM regexp_matches(j.command, '(' || p.jwt || ')', 'g') t) AS jwt_roles,
    (SELECT coalesce(sum((SELECT count(*) FROM regexp_matches(h[1], p.jwt, 'g'))), 0)
       FROM regexp_matches(j.command, p.header_literal, 'g') h
      WHERE h[1] ~ p.jwt) AS jwts_in_header_literals,
    (SELECT bool_and(
              (h[1]::jsonb->>'Authorization') IS NOT DISTINCT FROM 'Bearer ' || p.vault_key
              AND (h[1]::jsonb - 'Authorization')::text !~ p.jwt)
       FROM regexp_matches(j.command, p.header_literal, 'g') h
      WHERE h[1] ~ p.jwt) AS header_literals_match_vault,
    (SELECT count(*)
       FROM regexp_matches(j.command, '''Bearer (' || p.jwt || ')''', 'g') b) AS bearer_sql_literals,
    (SELECT bool_and(b[1] = p.vault_key)
       FROM regexp_matches(j.command, '''Bearer (' || p.jwt || ')''', 'g') b) AS bearer_sql_literals_match_vault,
    j.command ~ p.legacy_helper AS uses_legacy_helper,
    regexp_replace(j.command, p.legacy_helper, '', 'g') ~ '_sw_service_key' AS legacy_helper_unrecognised,
    j.command ~ 'public\.sw_service_key\(\)' AS uses_vault_accessor,
    (j.username = current_user OR coalesce(p.is_superuser, false)) AS owner_can_alter,
    CASE WHEN j.username IS NOT NULL
         THEN has_function_privilege(j.username, 'public.sw_service_key()', 'EXECUTE')
    END AS owner_can_read_vault,
    regexp_replace(j.command, p.jwt, '<JWT>', 'g') AS command_redacted
  FROM named n
  LEFT JOIN cron.job j ON j.jobname = n.jobname
  CROSS JOIN params p
)
SELECT ord, jobname, jobid, schedule, active, username, database,
       jwt_count, jwt_fps, jwt_roles,
       jwts_in_header_literals, header_literals_match_vault,
       bearer_sql_literals, bearer_sql_literals_match_vault,
       uses_legacy_helper, uses_vault_accessor,
       owner_can_alter, owner_can_read_vault,
       CASE
         WHEN jobid IS NULL THEN 'absent (skipped with a notice)'
         WHEN jwt_count = 0 AND NOT uses_legacy_helper AND NOT legacy_helper_unrecognised
           THEN 'unchanged (no inline key, no legacy helper)'
         WHEN NOT owner_can_alter THEN 'REFUSE: owned by another role'
         WHEN NOT owner_can_read_vault THEN 'REFUSE: owner cannot execute public.sw_service_key()'
         WHEN header_literals_match_vault IS FALSE OR bearer_sql_literals_match_vault IS FALSE
           THEN 'REFUSE: inline key is not the Vault key'
         WHEN jwt_count > jwts_in_header_literals + bearer_sql_literals
           THEN 'REFUSE: JWT in an unrecognised shape'
         WHEN legacy_helper_unrecognised THEN 'REFUSE: _sw_service_key in an unrecognised shape'
         ELSE 'rewrite'
       END AS migration_outcome,
       command_redacted
  FROM facts
 ORDER BY ord;

-- 4. Any OTHER job carrying a JWT-shaped literal. The migration's final sweep
--    refuses while one exists, so this must return no rows.
SELECT j.jobid, j.jobname, j.active,
       (SELECT array_agg(left(encode(sha256(convert_to(t[1], 'UTF8')), 'hex'), 6))
          FROM regexp_matches(j.command, '(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)', 'g') t) AS jwt_fps,
       regexp_replace(j.command, 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '<JWT>', 'g') AS command_redacted
  FROM cron.job j
 WHERE j.command ~ 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'
   AND j.jobname <> ALL (ARRAY[
     'xero-token-refresh', 'xero-po-sync', 'xero-reports-sync',
     'xero-projects-sync', 'xero-tracking-pl-sync', 'xero-bank-sync',
     'xero-payables-sync', 'xero-suppliers-sync', 'contact-matching',
     'system-health-check', 'xero-invoice-sync', 'weekly-ceo-financial-brief'
   ])
 ORDER BY j.jobid;

-- 5. Proof the Vault path already works in the cron worker: runs since Step 1
--    (20260930023008 applied 2026-09-30 02:30 UTC) of every job, by status.
--    Jobs that call process_outbound_queue / trigger_* read Vault on every
--    run. Keep this as the baseline the post-check compares with.
SELECT j.jobid, j.jobname, d.status, count(*) AS runs, max(d.start_time) AS last_run,
       left(regexp_replace(max(d.return_message),
            'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '<JWT>', 'g'), 160) AS sample_message
  FROM cron.job j
  JOIN cron.job_run_details d ON d.jobid = j.jobid
 WHERE d.start_time >= timestamptz '2026-09-30 02:30:00+00'
 GROUP BY j.jobid, j.jobname, d.status
 ORDER BY j.jobid, d.status;

-- 6. Baseline HTTP outcome mix from pg_net (it keeps about six hours and does
--    not record URLs). The post-check repeats this for the window after apply.
SELECT status_code,
       left(regexp_replace(coalesce(content::text, ''),
            'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '<JWT>', 'g'), 80) AS body_head,
       count(*) AS responses
  FROM net._http_response
 WHERE created > now() - interval '6 hours'
 GROUP BY 1, 2
 ORDER BY responses DESC
 LIMIT 25;
