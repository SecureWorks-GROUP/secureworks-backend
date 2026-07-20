-- ════════════════════════════════════════════════════════════
-- Restore retained daily jobs
--
-- These were registered by earlier scheduler migrations but were lost from
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
  $$SELECT net.http_post(url:='https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/daily-digest',headers:='{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtldmdyaGNqeHNwYnhnb3ZwbWZsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjM1NDEwNSwiZXhwIjoyMDg3OTMwMTA1fQ.rBAokSo0wBnIO7ZOnGmCGtWzvdKcumyLR2OD9-hG47U","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$
);

-- 2. Stale quote/deposit followup — 9am AWST (1:00 UTC)
SELECT cron.schedule('stale-followup', '0 1 * * *',
  $$SELECT net.http_post(url:='https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/daily-digest?action=stale_followup',headers:='{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtldmdyaGNqeHNwYnhnb3ZwbWZsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjM1NDEwNSwiZXhwIjoyMDg3OTMwMTA1fQ.rBAokSo0wBnIO7ZOnGmCGtWzvdKcumyLR2OD9-hG47U","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$
);
