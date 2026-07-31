-- Restore the vault-backed service-role accessor for migrations provisioned
-- after the production auto-apply baseline. The original definition lives in
-- the historical manual lane (20260717000001) and is absent in production.

CREATE OR REPLACE FUNCTION public.sw_service_key() RETURNS text AS $$
DECLARE
  v_key text;
BEGIN
  SELECT decrypted_secret INTO v_key
    FROM vault.decrypted_secrets
    WHERE name = 'service_role_key'
    LIMIT 1;

  IF v_key IS NULL THEN
    v_key := public._sw_service_key();
  END IF;

  -- Repair line-wrapped pastes: a JWT never legally contains whitespace.
  v_key := regexp_replace(v_key, '\s', '', 'g');

  -- Fail loud rather than send a malformed bearer token and 401 silently.
  IF v_key !~ '^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'sw_service_key: vault secret "service_role_key" is not a well-formed JWT';
  END IF;

  RETURN v_key;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER
   SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.sw_service_key IS
  'Returns the service-role key from vault (whitespace-stripped, shape-validated).
   SECURITY DEFINER so pg_cron background workers can read the vault secret.
   Deliberately NOT granted to anon/authenticated: it returns a god-mode key.';

-- Lock the accessor down hard: postgres only. Nothing else needs it — the
-- trigger functions below are themselves SECURITY DEFINER and owned by the
-- same role, so they call it as the owner regardless of the caller.
REVOKE ALL ON FUNCTION public.sw_service_key() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sw_service_key() FROM anon;
REVOKE ALL ON FUNCTION public.sw_service_key() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sw_service_key() TO postgres;
