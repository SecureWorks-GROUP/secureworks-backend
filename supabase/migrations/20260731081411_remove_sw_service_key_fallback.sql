-- Keep legacy service-role callers fail-closed. The embedded
-- legacy helper value is not an acceptable fallback when Vault is missing or
-- unreadable.

CREATE OR REPLACE FUNCTION public.sw_service_key() RETURNS text AS $$
DECLARE
  v_key text;
BEGIN
  SELECT regexp_replace(decrypted_secret, '\s', '', 'g')
    INTO v_key
    FROM vault.decrypted_secrets
   WHERE name = 'service_role_key'
   LIMIT 1;

  IF v_key IS NULL OR v_key = '' THEN
    RAISE EXCEPTION
      'sw_service_key: vault secret "service_role_key" is missing or empty';
  END IF;

  IF v_key !~ '^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION
      'sw_service_key: vault secret "service_role_key" is not a well-formed JWT';
  END IF;

  RETURN v_key;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER
   SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.sw_service_key IS
  'Returns only the whitespace-stripped, shape-validated Vault service-role key and fails closed when that secret is unavailable.';

REVOKE ALL ON FUNCTION public.sw_service_key() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sw_service_key() FROM anon;
REVOKE ALL ON FUNCTION public.sw_service_key() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sw_service_key() TO postgres;
