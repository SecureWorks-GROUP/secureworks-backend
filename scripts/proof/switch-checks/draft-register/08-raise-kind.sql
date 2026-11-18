-- Draft register, check 8: the Reconcile list knows the kind an incomplete
-- office draft is raised as ('draft_incomplete').
\set zz_check 'draft_register.raise_kind'
\ir ../session.sql
\if :zz_ok
SELECT :'zz_check' AS "check",
       CASE WHEN EXISTS (SELECT 1 FROM public.reconcile_item_kinds WHERE kind = 'draft_incomplete')
            THEN 'PASS' ELSE 'FAIL' END AS result,
       jsonb_build_object('kind', 'draft_incomplete',
                          'found', EXISTS (SELECT 1 FROM public.reconcile_item_kinds WHERE kind = 'draft_incomplete'))::text AS evidence;
\endif
