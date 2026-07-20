-- ════════════════════════════════════════════════════════════
-- Phase 2 Cron Job: stale followup
--
-- Uses hardcoded service_role_key (same pattern as 000004/000011).
-- vault.decrypted_secrets is broken in pg_cron context.
-- ════════════════════════════════════════════════════════════

-- Stale quote/deposit followup — daily at 9am AWST (1:00 UTC)
SELECT cron.schedule('stale-followup', '0 1 * * *',
  $$SELECT net.http_post(url:='https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/daily-digest?action=stale_followup',headers:='{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtldmdyaGNqeHNwYnhnb3ZwbWZsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjM1NDEwNSwiZXhwIjoyMDg3OTMwMTA1fQ.rBAokSo0wBnIO7ZOnGmCGtWzvdKcumyLR2OD9-hG47U","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$
);
