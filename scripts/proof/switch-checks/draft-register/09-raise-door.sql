-- Draft register, check 9: the raise call recordXeroDraft makes can reach a
-- function. It calls reconcile_item_raise by NAMED arguments through
-- PostgREST (p_kind ... p_org_id); PostgREST finds a function only by its
-- argument names. On main both overloads take positional (unnamed)
-- parameters, so this FAILS today: a draft is still recorded, but no
-- Reconcile item is raised (PR 1641 logs PGRST202). Known gap, needs a
-- migration; it is not a fault in this check.
\set zz_check 'draft_register.raise_door'
\ir ../session.sql
WITH f AS (
  SELECT p.oid, p.proargnames
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'reconcile_item_raise'
), named AS (
  SELECT f.oid FROM f
  WHERE f.proargnames @> ARRAY['p_kind','p_subject_table','p_subject_id','p_job_ids','p_suggestion',
                               'p_evidence','p_raised_by','p_org_id']::text[]
    AND cardinality(f.proargnames) = 8
)
SELECT :'zz_check' AS "check",
       CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
             AND EXISTS (SELECT 1 FROM named n WHERE has_function_privilege('service_role', n.oid, 'EXECUTE'))
            THEN 'PASS' ELSE 'FAIL' END AS result,
       jsonb_build_object('overloads', (SELECT count(*) FROM f),
                          'overload_with_the_eight_argument_names', (SELECT count(*) FROM named),
                          'note', 'FAIL on main today: positional parameters; drafts record, nothing is raised')::text AS evidence;
