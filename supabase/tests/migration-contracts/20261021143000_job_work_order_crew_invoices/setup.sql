-- Shaun and Marnin must exist before 20261021143000 seeds the backup approver.
-- The contract users table sometimes has email (production: not null) and
-- sometimes does not (the reduced 20261012130000 stub).

DO $$
DECLARE
  v_email boolean;
  v_shaun uuid := '9913309f-35ae-4a71-8e1f-f704ecc526ea';
  v_marnin uuid := '706c5258-70dd-483a-b36c-af6864b24498';
  v_org uuid := '00000000-0000-0000-0000-000000000001';
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'email'
  ) INTO v_email;

  IF v_email THEN
    INSERT INTO public.users (id, org_id, name, role, email) VALUES
      (v_shaun, v_org, 'Shaun', 'ops_manager', 'shaun@secureworkswa.com.au'),
      (v_marnin, v_org, 'Marnin', 'ops_manager', 'marnin@secureworkswa.com.au')
    ON CONFLICT (id) DO NOTHING;

    UPDATE public.users u
      SET email = 'shaun@secureworkswa.com.au'
      WHERE u.id = v_shaun
        AND COALESCE(btrim(u.email), '') = ''
        AND NOT EXISTS (
          SELECT 1 FROM public.users o
          WHERE o.id <> u.id AND lower(btrim(o.email)) = 'shaun@secureworkswa.com.au'
        );
    UPDATE public.users u
      SET email = 'marnin@secureworkswa.com.au'
      WHERE u.id = v_marnin
        AND COALESCE(btrim(u.email), '') = ''
        AND NOT EXISTS (
          SELECT 1 FROM public.users o
          WHERE o.id <> u.id AND lower(btrim(o.email)) = 'marnin@secureworkswa.com.au'
        );
  ELSE
    INSERT INTO public.users (id, org_id, name, role) VALUES
      (v_shaun, v_org, 'Shaun', 'ops_manager'),
      (v_marnin, v_org, 'Marnin', 'ops_manager')
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;
