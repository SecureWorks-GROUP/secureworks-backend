-- ════════════════════════════════════════════════════════════
-- Migration 004: pg_cron Schedules for Reporting
--
-- Prerequisites:
--   1. Enable pg_cron and pg_net extensions in Supabase dashboard
--      (Database → Extensions → search "pg_cron" → Enable, same for "pg_net")
--   2. Store the service role key in Vault:
--      INSERT INTO vault.secrets (name, secret)
--      VALUES ('service_role_key', 'your-service-role-key-here');
--
-- All times in UTC. Perth (AWST) = UTC+8, no DST.
-- ════════════════════════════════════════════════════════════

-- Enable extensions (must be enabled in Supabase dashboard first)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ── Xero Token Refresh (every 20 minutes) ──
-- Xero custom connection tokens expire after 30 min
SELECT cron.schedule(
  'xero-token-refresh',
  '*/20 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=token_refresh',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ── Xero Invoice Sync (every 15 minutes) ──
-- Incremental sync using If-Modified-Since
SELECT cron.schedule(
  'xero-invoice-sync',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=sync_invoices',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ── Xero Reports Sync (daily at 6am AWST = 10pm UTC previous day) ──
-- Pulls P&L and Aged Receivables
SELECT cron.schedule(
  'xero-reports-sync',
  '0 22 * * *',
  $$
  SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=sync_reports',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ── Contact Matching (daily at 3am AWST = 7pm UTC previous day) ──
-- Matches GHL contacts to Xero contacts by email
SELECT cron.schedule(
  'contact-matching',
  '0 19 * * *',
  $$
  SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=match_contacts',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
