-- Fix AI & Telegram Bot Quality Issues (2026-03-22)
-- 1. Add missing columns to chat_logs (ops-ai inserts channel + caller_tier but they don't exist)
-- 2. Add Henry to users table (via auth.users first, then public.users)
-- 3. Dismiss stale alerts older than 7 days

-- ── chat_logs schema fix ────────────────────────────────────
ALTER TABLE chat_logs ADD COLUMN IF NOT EXISTS channel text;
ALTER TABLE chat_logs ADD COLUMN IF NOT EXISTS caller_tier int;

-- ── Add Henry as lead installer ─────────────────────────────
-- users.id references auth.users(id), so we must create auth entry first
DO $$
DECLARE
  _uid uuid;
BEGIN
  -- Check if already exists in auth.users
  SELECT id INTO _uid FROM auth.users WHERE email = 'emeka.henry.1441@gmail.com';

  IF _uid IS NULL THEN
    _uid := gen_random_uuid();
    INSERT INTO auth.users (
      instance_id, id, aud, role, email,
      encrypted_password, email_confirmed_at,
      created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data,
      is_super_admin, confirmation_token
    ) VALUES (
      '00000000-0000-0000-0000-000000000000',
      _uid, 'authenticated', 'authenticated',
      'emeka.henry.1441@gmail.com',
      crypt('temp-change-me-' || gen_random_uuid()::text, gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"name":"Henry"}'::jsonb,
      false, ''
    );
  END IF;

  -- Upsert into public.users
  INSERT INTO users (id, org_id, email, name, role)
  VALUES (
    _uid,
    '00000000-0000-0000-0000-000000000001',
    'emeka.henry.1441@gmail.com',
    'Henry',
    'lead_installer'
  )
  ON CONFLICT (id) DO UPDATE SET role = 'lead_installer', name = 'Henry';
END;
$$;

-- ── Dismiss stale alerts (older than 7 days) ────────────────
UPDATE ai_alerts
SET dismissed_at = now(),
    dismissed_by = '00000000-0000-0000-0000-000000000000'
WHERE created_at < now() - interval '7 days'
  AND dismissed_at IS NULL;
