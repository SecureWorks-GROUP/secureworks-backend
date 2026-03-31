-- ════════════════════════════════════════════════════════════
-- Fix: Re-register Xero sync cron jobs
--
-- Root cause: pg_cron jobs for xero-sync stopped firing on
-- 18 March 2026 ~12:45 UTC, likely dropped during the batch
-- of migrations pushed that day. Daily-digest cron was
-- unaffected (still running). This re-registers all 4 xero
-- cron jobs + the PO sync job added later.
--
-- cron.schedule is idempotent on jobname — if the job exists
-- it updates the schedule, if not it creates it.
-- ════════════════════════════════════════════════════════════

-- ── Xero Token Refresh (every 20 minutes) ──
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

-- ── Xero Reports Sync (daily at 6am AWST = 10pm UTC) ──
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

-- ── Contact Matching (daily at 3am AWST = 7pm UTC) ──
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

-- ── Xero Projects Sync (daily at 6:15am AWST = 10:15pm UTC) ──
SELECT cron.schedule(
  'xero-projects-sync',
  '15 22 * * *',
  $$
  SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=sync_projects',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ── Xero Tracking P&L Sync (daily at 6:30am AWST = 10:30pm UTC) ──
SELECT cron.schedule(
  'xero-tracking-pl-sync',
  '30 22 * * *',
  $$
  SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=sync_tracking_pl',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ── Xero Bank + Supplier Sync (daily at 6:45am AWST = 10:45pm UTC) ──
SELECT cron.schedule(
  'xero-bank-supplier-sync',
  '45 22 * * *',
  $$
  SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=sync_bank_balances',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=sync_aged_payables',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=sync_suppliers',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ── Xero PO Sync (every 30 minutes) ──
SELECT cron.schedule(
  'xero-po-sync',
  '5,35 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=sync_purchase_orders',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
