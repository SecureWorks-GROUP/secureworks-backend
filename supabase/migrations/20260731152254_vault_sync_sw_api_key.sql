-- Let the privileged ops-api sync its own SW_API_KEY runtime secret into
-- Vault without exposing Vault writes to browser or routine callers.

CREATE OR REPLACE FUNCTION public.vault_upsert_sw_api_key(p_secret text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  secret_id uuid;
  secret_name CONSTANT text := 'sw_api_key';
  secret_description CONSTANT text :=
    'Synced from the ops-api SW_API_KEY edge runtime environment';
BEGIN
  IF p_secret IS NULL OR pg_catalog.btrim(p_secret) = '' THEN
    RAISE EXCEPTION 'vault_upsert_sw_api_key: secret is missing or empty';
  END IF;

  -- Serialize create/update so concurrent retries cannot race the unique name.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vault:sw_api_key', 0)
  );

  SELECT id
    INTO secret_id
    FROM vault.secrets
   WHERE name = secret_name;

  IF secret_id IS NULL THEN
    secret_id := vault.create_secret(
      p_secret,
      secret_name,
      secret_description
    );
  ELSE
    PERFORM vault.update_secret(
      secret_id,
      p_secret,
      secret_name,
      secret_description
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'name', secret_name,
    'value_md5_prefix', pg_catalog.left(pg_catalog.md5(p_secret), 8)
  );
END;
$$;

COMMENT ON FUNCTION public.vault_upsert_sw_api_key(text) IS
  'Creates or updates the sw_api_key Vault secret and returns only its name and an MD5 fingerprint prefix.';

REVOKE ALL ON FUNCTION public.vault_upsert_sw_api_key(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vault_upsert_sw_api_key(text)
  TO service_role, postgres;
