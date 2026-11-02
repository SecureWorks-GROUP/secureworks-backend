-- Rollback for 20261102010000_users_self_update_guard.sql.
-- Removes the guard and reopens the 2 Nov 2026 flaw (any signed-in user can
-- change their own role, org and pay fields). Refuses a same-named function
-- this migration did not make. No row data moves.

DO $down$
BEGIN
  IF to_regprocedure('public.users_guard_self_update()') IS NOT NULL
     AND COALESCE(obj_description(to_regprocedure('public.users_guard_self_update()'), 'pg_proc'), '') NOT LIKE 'Users self-update guard (20261102010000)%' THEN
    RAISE EXCEPTION 'users_self_update_guard_down_preimage_mismatch: public.users_guard_self_update is not 20261102010000''s';
  END IF;
END
$down$;

DROP TRIGGER IF EXISTS trg_users_guard_self_update ON public.users;
DROP FUNCTION IF EXISTS public.users_guard_self_update();
