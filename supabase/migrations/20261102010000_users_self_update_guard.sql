-- Signed-in staff may edit only harmless fields on their own users row.
--
-- Production, 2 Nov 2026: the policy "Users can update own profile" (USING
-- id = auth.uid(), no column limit) and the UPDATE grant on every users column
-- let any signed-in user, crew and trade logins included, set their own role
-- to admin, move their own org, and change their own pay rate, trade tier and
-- job visibility. auth_role() and auth_org_id() read those columns, and policies
-- on 81 tables trust them.
--
-- This trigger limits only requests made directly as the signed-in app user
-- (current_user authenticated or anon, i.e. PostgREST): a non-admin may change
-- name, phone, avatar_url and telegram_username on their own row, nothing else.
-- New columns are protected by default. Unchanged: admins of the same org,
-- the service role (every edge function, including ops-api update_trade_profile
-- and set_trade_rate), migrations, and SECURITY DEFINER routines. No row is
-- changed by this migration.

CREATE OR REPLACE FUNCTION public.users_guard_self_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  allowed constant text[] := ARRAY['name', 'phone', 'avatar_url', 'telegram_username', 'updated_at'];
  changed text[];
BEGIN
  -- SECURITY INVOKER on purpose: current_user is the caller's database role.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  -- auth_role()/auth_org_id() read the caller's row as it was when the
  -- statement started, so an admin is judged by the role they already hold.
  IF public.auth_role() = 'admin' AND OLD.org_id = public.auth_org_id() THEN
    RETURN NEW;
  END IF;
  SELECT array_agg(n.key ORDER BY n.key) INTO changed
  FROM jsonb_each(to_jsonb(NEW)) AS n
  WHERE NOT (n.key = ANY (allowed))
    AND n.value IS DISTINCT FROM (to_jsonb(OLD) -> n.key);
  IF changed IS NOT NULL THEN
    RAISE EXCEPTION 'users_self_update_refused: only an admin can change %', array_to_string(changed, ', ')
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.users_guard_self_update() IS
  'Users self-update guard (20261102010000): signed-in non-admins may change only name, phone, avatar_url, telegram_username on their own row.';

DROP TRIGGER IF EXISTS trg_users_guard_self_update ON public.users;
CREATE TRIGGER trg_users_guard_self_update
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.users_guard_self_update();

COMMENT ON TRIGGER trg_users_guard_self_update ON public.users IS
  'Users self-update guard (20261102010000)';
