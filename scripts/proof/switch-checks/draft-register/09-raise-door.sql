-- Draft register, check 9: the raise call the register makes can reach a
-- function. PR 1641 calls reconcile_item_raise_named by named arguments
-- through PostgREST (p_kind ... p_org_id), which finds a function only by its
-- argument names. That function is added by PR 1643; without it the call
-- answers PGRST202, the draft is still recorded and nothing is raised.
-- PASS: the function exists with exactly those eight names in order, the
-- service role may run it, and anon and authenticated may not.
\set zz_check 'draft_register.raise_door'
\ir ../session.sql
\if :zz_ok
WITH f AS (
  SELECT p.oid, p.proargnames
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'reconcile_item_raise_named'
), named AS (
  SELECT f.oid FROM f
  WHERE f.proargnames = ARRAY['p_kind','p_subject_table','p_subject_id','p_job_ids','p_suggestion',
                              'p_evidence','p_raised_by','p_org_id']::text[]
), roles AS (
  SELECT count(*) = 3 AS found FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')
), grants AS (
  SELECT n.oid,
         CASE WHEN r.found THEN has_function_privilege('service_role', n.oid, 'EXECUTE') END AS server_runs,
         CASE WHEN r.found THEN has_function_privilege('anon', n.oid, 'EXECUTE')
                                OR has_function_privilege('authenticated', n.oid, 'EXECUTE') END AS browser_runs
  FROM named n CROSS JOIN roles r
)
SELECT :'zz_check' AS "check",
       CASE WHEN (SELECT count(*) FROM named) = 1
             AND EXISTS (SELECT 1 FROM grants WHERE server_runs IS TRUE AND browser_runs IS FALSE)
            THEN 'PASS' ELSE 'FAIL' END AS result,
       jsonb_build_object('function', 'reconcile_item_raise_named',
                          'found', (SELECT count(*) FROM f),
                          'with_the_eight_names_in_order', (SELECT count(*) FROM named),
                          'service_role_runs', (SELECT server_runs FROM grants LIMIT 1),
                          'anon_or_authenticated_runs', (SELECT browser_runs FROM grants LIMIT 1),
                          'note', 'needs PR 1643 applied; FAIL on main today')::text AS evidence;
\endif
