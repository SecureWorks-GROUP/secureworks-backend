-- anon inherits EXECUTE through a role membership that the migration's REVOKE
-- cannot remove. The migration must fail rather than report the hole closed.
-- Roles are cluster-wide; this one holds no grants in any later contract
-- database.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'contract_rpc_grantee') THEN
    CREATE ROLE contract_rpc_grantee NOLOGIN;
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION public.send_ghl_sms(text, text, uuid) TO contract_rpc_grantee;
GRANT contract_rpc_grantee TO anon;
