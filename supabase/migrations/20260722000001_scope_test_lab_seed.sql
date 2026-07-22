-- Dedicated Supabase tenant for general scoping-tool write tests.
-- GHL pipeline/location routing is configured separately through edge secrets.
-- No GHL ID belongs in this migration. The auth password is random and not
-- recoverable; lab sessions use the normal Supabase admin/reset path.

INSERT INTO public.organisations (
  id,
  name,
  abn,
  phone,
  email,
  settings_json
) VALUES (
  '00000000-0000-0000-0000-00000000f001',
  'TEST-ZZZ Scope Save Lab',
  NULL,
  '+61000000000',
  'test-zzz-scope-lab@example.invalid',
  '{"test_context":true,"lab":"scope-save-path","all_tools":true,"outbound_comms":false}'::jsonb
)
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.organisations
    WHERE id = '00000000-0000-0000-0000-00000000f001'
      AND name = 'TEST-ZZZ Scope Save Lab'
      AND email = 'test-zzz-scope-lab@example.invalid'
      AND settings_json->>'test_context' = 'true'
  ) THEN
    RAISE EXCEPTION 'Reserved scope lab organisation ID is already occupied';
  END IF;
END;
$$;

INSERT INTO auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  created_at,
  updated_at,
  raw_app_meta_data,
  raw_user_meta_data,
  is_super_admin,
  confirmation_token
) VALUES (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-0000-0000-00000000f002',
  'authenticated',
  'authenticated',
  'test-zzz-scope-lab@example.invalid',
  crypt('TEST-ZZZ-' || gen_random_uuid()::text, gen_salt('bf')),
  now(),
  now(),
  now(),
  '{"provider":"email","providers":["email"],"test_context":true}'::jsonb,
  '{"name":"TEST-ZZZ Scope Lab User","test_context":true}'::jsonb,
  false,
  ''
)
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM auth.users
    WHERE id = '00000000-0000-0000-0000-00000000f002'
      AND email = 'test-zzz-scope-lab@example.invalid'
  ) THEN
    RAISE EXCEPTION 'Reserved scope lab user ID or email is already occupied';
  END IF;
END;
$$;

INSERT INTO public.users (
  id,
  org_id,
  name,
  email,
  phone,
  role
) VALUES (
  '00000000-0000-0000-0000-00000000f002',
  '00000000-0000-0000-0000-00000000f001',
  'TEST-ZZZ Scope Lab User',
  'test-zzz-scope-lab@example.invalid',
  '+61000000000',
  'estimator'
)
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.users
    WHERE id = '00000000-0000-0000-0000-00000000f002'
      AND org_id = '00000000-0000-0000-0000-00000000f001'
      AND name = 'TEST-ZZZ Scope Lab User'
      AND email = 'test-zzz-scope-lab@example.invalid'
  ) THEN
    RAISE EXCEPTION 'Scope lab user exists outside the reserved test organisation';
  END IF;
END;
$$;
