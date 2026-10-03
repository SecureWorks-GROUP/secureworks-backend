-- Read-only post-check for 20260930120000_cron_service_key_from_vault.sql.
--
-- Run each numbered query on its own, as postgres, after the migration. Every
-- query is a plain SELECT and returns no key (JWT-shaped strings are replaced
-- by <JWT>). Replace <APPLIED_AT_UTC> (queries 3-4) with the apply time, for example
-- 2026-10-01 01:00:00+00.

-- 1. Nothing in cron.job carries a JWT-shaped literal. Expect 0.
SELECT count(*) AS jobs_with_jwt_literal
  FROM cron.job
 WHERE command ~ 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+';

-- 2. The twelve named jobs read Vault only. Expect uses_vault_accessor = true
--    and uses_legacy_helper = false on every present job, and jobid /
--    schedule / active / username identical to pre-check query 3.
SELECT j.jobid, j.jobname, j.schedule, j.active, j.username,
       j.command ~ 'public\.sw_service_key\(\)' AS uses_vault_accessor,
       j.command ~ '_sw_service_key' AS uses_legacy_helper,
       regexp_replace(j.command, 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '<JWT>', 'g') AS command_redacted
  FROM cron.job j
 WHERE j.jobname IN (
   'xero-token-refresh', 'xero-po-sync', 'xero-reports-sync',
   'xero-projects-sync', 'xero-tracking-pl-sync', 'xero-bank-sync',
   'xero-payables-sync', 'xero-suppliers-sync', 'contact-matching',
   'system-health-check', 'xero-invoice-sync', 'weekly-ceo-financial-brief'
 )
 ORDER BY j.jobid;

-- 3. The rewritten jobs run. The frequent ones (xero-invoice-sync every 15
--    min, xero-token-refresh every 20, system-health-check every 30,
--    xero-po-sync twice an hour) must show `succeeded` within the hour; a
--    `failed` run naming sw_service_key means the Vault read failed in the
--    worker (use the rollback). `succeeded` only means the SQL ran and pg_net
--    queued the request; query 4 covers the HTTP outcome.
SELECT j.jobid, j.jobname, d.status, count(*) AS runs, max(d.start_time) AS last_run,
       left(regexp_replace(max(d.return_message),
            'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '<JWT>', 'g'), 160) AS sample_message
  FROM cron.job j
  JOIN cron.job_run_details d ON d.jobid = j.jobid
 WHERE d.start_time >= timestamptz '<APPLIED_AT_UTC>'
   AND j.jobname IN (
     'xero-token-refresh', 'xero-po-sync', 'xero-reports-sync',
     'xero-projects-sync', 'xero-tracking-pl-sync', 'xero-bank-sync',
     'xero-payables-sync', 'xero-suppliers-sync', 'contact-matching',
     'system-health-check', 'xero-invoice-sync', 'weekly-ceo-financial-brief'
   )
 GROUP BY j.jobid, j.jobname, d.status
 ORDER BY j.jobid, d.status;

-- 4. HTTP outcome mix since apply, to compare with pre-check query 6. The
--    same key is sent, so the mix should not move; the pre-existing 401s
--    (report section 4e) are expected to persist and are not caused by this.
SELECT status_code,
       left(regexp_replace(coalesce(content::text, ''),
            'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '<JWT>', 'g'), 80) AS body_head,
       count(*) AS responses
  FROM net._http_response
 WHERE created >= timestamptz '<APPLIED_AT_UTC>'
 GROUP BY 1, 2
 ORDER BY responses DESC
 LIMIT 25;
