-- ════════════════════════════════════════════════════════════
-- Cron: System health check every 30 minutes
--
-- Calls the system-health edge function to verify Xero sync
-- freshness, digest runs, stale alerts, and event generation.
-- Sends Telegram alert if anything is degraded or critical.
-- Uses hardcoded service role key (same pattern as 000004).
-- ════════════════════════════════════════════════════════════

SELECT cron.schedule('system-health-check', '*/30 * * * *',
  $$SELECT net.http_post(url:='https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/system-health',headers:='{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtldmdyaGNqeHNwYnhnb3ZwbWZsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjM1NDEwNSwiZXhwIjoyMDg3OTMwMTA1fQ.rBAokSo0wBnIO7ZOnGmCGtWzvdKcumyLR2OD9-hG47U","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$
);
