-- The deploy must change no one's Trade App visibility: every existing
-- admin/owner/ops_manager (the old role-derived see-everything set) carries
-- the flag, nobody else does, and new rows default to false.
DO $$
DECLARE
  staff_total integer;
  staff_missing integer;
  others_flagged integer;
  new_default boolean;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE NOT trade_sees_all_jobs)
    INTO staff_total, staff_missing
  FROM public.users
  WHERE role IN ('admin', 'owner', 'ops_manager');

  IF staff_total < 3 THEN
    RAISE EXCEPTION 'trade_sees_all_jobs contract: expected the staff fixtures, found %', staff_total;
  END IF;
  IF staff_missing <> 0 THEN
    RAISE EXCEPTION 'trade_sees_all_jobs contract: % admin/owner/ops_manager users lost see-everything at deploy', staff_missing;
  END IF;

  SELECT count(*) INTO others_flagged
  FROM public.users
  WHERE trade_sees_all_jobs
    AND (role IS NULL OR role NOT IN ('admin', 'owner', 'ops_manager'));
  IF others_flagged <> 0 THEN
    RAISE EXCEPTION 'trade_sees_all_jobs contract: % non-staff users gained see-everything at deploy', others_flagged;
  END IF;

  IF (SELECT managed_verticals FROM public.users WHERE id = 'f5000000-0000-4000-8000-000000000005') <> ARRAY['makesafe']::text[] THEN
    RAISE EXCEPTION 'trade_sees_all_jobs contract: migration touched managed_verticals';
  END IF;
END
$$;

BEGIN;
INSERT INTO public.users (id, org_id, name, role)
VALUES ('f5000000-0000-4000-8000-0000000000ff', 'e0000000-0000-4000-8000-0000000000aa', 'New admin (contract)', 'admin');
DO $$
BEGIN
  IF (SELECT trade_sees_all_jobs FROM public.users WHERE id = 'f5000000-0000-4000-8000-0000000000ff') THEN
    RAISE EXCEPTION 'trade_sees_all_jobs contract: a new user must default to false';
  END IF;
END
$$;
ROLLBACK;

-- Re-applying the migration must never re-widen a person the separate
-- approved data change has already narrowed, and must not error.
BEGIN;
UPDATE public.users SET trade_sees_all_jobs = false
WHERE id = 'f5000000-0000-4000-8000-000000000003';
\ir ../../../migrations/20260925040000_users_trade_sees_all_jobs.sql
DO $$
BEGIN
  IF (SELECT trade_sees_all_jobs FROM public.users WHERE id = 'f5000000-0000-4000-8000-000000000003') THEN
    RAISE EXCEPTION 'trade_sees_all_jobs contract: re-apply re-widened a narrowed ops_manager';
  END IF;
  IF NOT (SELECT trade_sees_all_jobs FROM public.users WHERE id = 'f5000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'trade_sees_all_jobs contract: re-apply cleared an untouched admin';
  END IF;
END
$$;
ROLLBACK;
