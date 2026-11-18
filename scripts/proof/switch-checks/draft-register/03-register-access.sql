-- Draft register, check 3: only the server writes it. Row security is on,
-- anon and authenticated hold no privilege on it (TRUNCATE included: row
-- security does not cover it), and service_role can read,
-- insert and update (the upsert). A role that does not exist reads as FAIL.
\set zz_check 'draft_register.register_access'
\ir ../session.sql
\if :zz_ok
WITH r AS (
  SELECT
    (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.xero_draft_register')) AS rls,
    (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')) = 3 AS roles_found
), p AS (
  SELECT r.*,
    CASE WHEN r.roles_found THEN
      has_table_privilege('anon', 'public.xero_draft_register', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_table_privilege('authenticated', 'public.xero_draft_register', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') END AS browser_any,
    CASE WHEN r.roles_found THEN
      has_table_privilege('service_role', 'public.xero_draft_register', 'SELECT')
      AND has_table_privilege('service_role', 'public.xero_draft_register', 'INSERT')
      AND has_table_privilege('service_role', 'public.xero_draft_register', 'UPDATE') END AS server_writes
  FROM r
)
SELECT :'zz_check' AS "check",
       CASE WHEN p.rls IS TRUE AND p.roles_found AND p.browser_any IS FALSE AND p.server_writes IS TRUE
            THEN 'PASS' ELSE 'FAIL' END AS result,
       jsonb_build_object('row_security', p.rls, 'roles_found', p.roles_found,
                          'anon_or_authenticated_privilege', p.browser_any,
                          'service_role_select_insert_update', p.server_writes)::text AS evidence
FROM p;
\endif
