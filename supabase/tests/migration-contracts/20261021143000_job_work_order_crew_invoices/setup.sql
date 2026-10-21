-- Shaun and Marnin exist so the contract can name them. The migration does
-- not write backup_approver_user_ids; the contract sets that list itself.
-- The contract users table sometimes has email (production: not null) and
-- sometimes does not (the reduced 20261012130000 stub).
--
-- These two are ops_manager. 20260925040000 backfills trade_sees_all_jobs
-- only for staff who already exist when it runs. This setup runs after that
-- migration and commits, so a later see-everything contract would count them
-- as staff who lost the flag. When the column exists they are inserted and
-- updated with it true. Their role is not changed.

DO $$
DECLARE
  v_email boolean;
  v_sees boolean;
  v_shaun uuid := '9913309f-35ae-4a71-8e1f-f704ecc526ea';
  v_marnin uuid := '706c5258-70dd-483a-b36c-af6864b24498';
  v_org uuid := '00000000-0000-0000-0000-000000000001';
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'email'
  ) INTO v_email;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'trade_sees_all_jobs'
  ) INTO v_sees;

  IF v_email AND v_sees THEN
    INSERT INTO public.users (id, org_id, name, role, email, trade_sees_all_jobs) VALUES
      (v_shaun, v_org, 'Shaun', 'ops_manager', 'shaun@secureworkswa.com.au', true),
      (v_marnin, v_org, 'Marnin', 'ops_manager', 'marnin@secureworkswa.com.au', true)
    ON CONFLICT (id) DO NOTHING;
  ELSIF v_email THEN
    INSERT INTO public.users (id, org_id, name, role, email) VALUES
      (v_shaun, v_org, 'Shaun', 'ops_manager', 'shaun@secureworkswa.com.au'),
      (v_marnin, v_org, 'Marnin', 'ops_manager', 'marnin@secureworkswa.com.au')
    ON CONFLICT (id) DO NOTHING;
  ELSIF v_sees THEN
    INSERT INTO public.users (id, org_id, name, role, trade_sees_all_jobs) VALUES
      (v_shaun, v_org, 'Shaun', 'ops_manager', true),
      (v_marnin, v_org, 'Marnin', 'ops_manager', true)
    ON CONFLICT (id) DO NOTHING;
  ELSE
    INSERT INTO public.users (id, org_id, name, role) VALUES
      (v_shaun, v_org, 'Shaun', 'ops_manager'),
      (v_marnin, v_org, 'Marnin', 'ops_manager')
    ON CONFLICT (id) DO NOTHING;
  END IF;

  IF v_sees THEN
    UPDATE public.users
      SET trade_sees_all_jobs = true
      WHERE id IN (v_shaun, v_marnin);
  END IF;

  IF v_email THEN
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
  END IF;
END $$;

-- Staff rows in production see every job (20260925040000). Keep that true for
-- the two staff rows added here, so the users_trade_sees_all_jobs contract,
-- which runs after every setup, does not count them as having lost it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'trade_sees_all_jobs'
  ) THEN
    EXECUTE $q$UPDATE public.users SET trade_sees_all_jobs = true
      WHERE id IN ('9913309f-35ae-4a71-8e1f-f704ecc526ea', '706c5258-70dd-483a-b36c-af6864b24498')$q$;
  END IF;
END $$;
