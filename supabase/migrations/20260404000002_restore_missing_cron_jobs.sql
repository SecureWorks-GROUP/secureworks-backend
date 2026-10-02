-- 2026-09-30: the service-role key pasted in this file (fingerprint 4595ba)
-- was leaked by being committed. It is redacted here; the live jobs now read
-- the key from Vault (20260930120000_cron_service_key_from_vault.sql), and
-- the key itself is retired by rotation. This file predates the auto-apply
-- baseline and is never re-applied. Do not paste a key back in.

-- ════════════════════════════════════════════════════════════
-- Restore 6 missing cron jobs
--
-- These were registered in 20260322000004_hardcode_cron_auth.sql
-- and 20260322000012_phase2_cron_jobs.sql but were lost from
-- the cron.job table at some point after migration.
--
-- Only the xero-sync and system-health jobs survived.
-- All daily-digest-related schedulers were missing.
--
-- Uses cron.schedule which is idempotent on jobname — safe to
-- re-run even if a job already exists with that name.
-- ════════════════════════════════════════════════════════════

-- 1. Daily digest — 7am AWST (23:00 UTC previous day)
SELECT cron.schedule('daily-digest', '0 23 * * *',
  $$SELECT net.http_post(url:='https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/daily-digest',headers:='{"Authorization":"Bearer REDACTED-legacy-service-role-key","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$
);

-- 2. Intraday nudge checks — 11am, 3pm, 7pm AWST (3, 7, 11 UTC)
SELECT cron.schedule('intraday-nudge-check', '0 3,7,11 * * *',
  $$SELECT net.http_post(url:='https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/daily-digest?action=nudge_check',headers:='{"Authorization":"Bearer REDACTED-legacy-service-role-key","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$
);

-- 3. Stale quote/deposit followup — 9am AWST (1:00 UTC)
SELECT cron.schedule('stale-followup', '0 1 * * *',
  $$SELECT net.http_post(url:='https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/daily-digest?action=stale_followup',headers:='{"Authorization":"Bearer REDACTED-legacy-service-role-key","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$
);

-- 4. EOD follow-up — weekdays 5pm AWST (9:00 UTC)
SELECT cron.schedule('eod-followup-5pm', '0 9 * * 1-5',
  $$SELECT net.http_post(url:='https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/daily-digest?action=eod_followup',headers:='{"Authorization":"Bearer REDACTED-legacy-service-role-key","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$
);

-- 5. EOD escalation — weekdays 7pm AWST (11:00 UTC)
SELECT cron.schedule('eod-escalation-7pm', '0 11 * * 1-5',
  $$SELECT net.http_post(url:='https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/daily-digest?action=eod_followup',headers:='{"Authorization":"Bearer REDACTED-legacy-service-role-key","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$
);

-- 6. Shaun's morning brief — 7:30am AWST (23:30 UTC previous day)
SELECT cron.schedule('shaun-morning-brief', '30 23 * * *',
  $$SELECT net.http_post(url:='https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/daily-digest?action=shaun_brief',headers:='{"Authorization":"Bearer REDACTED-legacy-service-role-key","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$
);
