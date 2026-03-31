-- ════════════════════════════════════════════════════════════
-- Fix: Nuke and re-register ALL cron jobs
--
-- Uses current_setting('app.settings.service_role_key') instead
-- of vault.decrypted_secrets — this is what Supabase sets
-- automatically and doesn't need a manual vault insert.
-- ════════════════════════════════════════════════════════════

-- Step 1: Remove ALL existing cron jobs (clean slate)
DO $$
BEGIN
  PERFORM cron.unschedule(jobname) FROM cron.job;
END;
$$;

-- Step 2: Re-register everything using current_setting (not vault)

-- ── Xero Token Refresh (every 20 minutes) ──
SELECT cron.schedule(
  'xero-token-refresh',
  '*/20 * * * *',
  $job$
  SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=token_refresh',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $job$
);

-- ── Xero Invoice Sync (every 15 minutes) ──
SELECT cron.schedule(
  'xero-invoice-sync',
  '*/15 * * * *',
  $job$
  SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=sync_invoices',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $job$
);

-- ── Xero Reports Sync (daily at 6am AWST = 10pm UTC) ──
SELECT cron.schedule(
  'xero-reports-sync',
  '0 22 * * *',
  $job$
  SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=sync_reports',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $job$
);

-- ── Contact Matching (daily at 3am AWST = 7pm UTC) ──
SELECT cron.schedule(
  'contact-matching',
  '0 19 * * *',
  $job$
  SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=match_contacts',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $job$
);

-- ── Xero Projects Sync (daily at 6:15am AWST = 10:15pm UTC) ──
SELECT cron.schedule(
  'xero-projects-sync',
  '15 22 * * *',
  $job$
  SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=sync_projects',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $job$
);

-- ── Xero Tracking P&L Sync (daily at 6:30am AWST = 10:30pm UTC) ──
SELECT cron.schedule(
  'xero-tracking-pl-sync',
  '30 22 * * *',
  $job$
  SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=sync_tracking_pl',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $job$
);

-- ── Xero Bank Balances (daily at 6:45am AWST = 10:45pm UTC) ──
SELECT cron.schedule(
  'xero-bank-sync',
  '45 22 * * *',
  $job$
  SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=sync_bank_balances',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $job$
);

-- ── Xero Aged Payables (daily at 6:50am AWST = 10:50pm UTC) ──
SELECT cron.schedule(
  'xero-payables-sync',
  '50 22 * * *',
  $job$
  SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=sync_aged_payables',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $job$
);

-- ── Xero Suppliers (daily at 6:55am AWST = 10:55pm UTC) ──
SELECT cron.schedule(
  'xero-suppliers-sync',
  '55 22 * * *',
  $job$
  SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=sync_suppliers',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $job$
);

-- ── Xero PO Sync (every 30 minutes) ──
SELECT cron.schedule(
  'xero-po-sync',
  '5,35 * * * *',
  $job$
  SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=sync_purchase_orders',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $job$
);

-- ── Daily Digest (7am AWST = 11pm UTC) ──
SELECT cron.schedule(
  'daily-digest',
  '0 23 * * *',
  $job$
  SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/daily-digest',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $job$
);

-- ── Intraday Nudge Check (11am, 3pm, 7pm AWST) ──
SELECT cron.schedule(
  'intraday-nudge-check',
  '0 3,7,11 * * *',
  $job$
  SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/daily-digest?action=nudge_check',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $job$
);
