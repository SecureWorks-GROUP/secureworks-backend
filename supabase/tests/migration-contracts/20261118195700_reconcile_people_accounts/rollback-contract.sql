DO $$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.reconcile_list_page(uuid,text[],integer,jsonb)'::regprocedure)
       IS DISTINCT FROM '8c9e154df84031b3ae8620953c67c841'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.reconcile_list_counts(uuid)'::regprocedure)
       IS DISTINCT FROM '377ee4c6d4f4d5ae66b070dc31748f44' THEN
    RAISE EXCEPTION 'ZZTEST rollback did not restore 20261118195400''s bodies';
  END IF;
  IF obj_description('public.reconcile_list_counts(uuid)'::regprocedure, 'pg_proc')
       IS DISTINCT FROM 'Reconcile list (P2-03.6): open items per kind for one org, with the same items left out as a page. Read only.'
     OR NOT has_function_privilege('service_role', 'public.reconcile_list_page(uuid,text[],integer,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.reconcile_list_counts(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ZZTEST rollback did not restore comments and grants';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.job_cost_lines_bill_document(uuid,jsonb,boolean)'::regprocedure)
       IS DISTINCT FROM '534760eeda42dd472aa643ac27e90368'
     OR (SELECT provolatile FROM pg_proc WHERE oid = 'public.job_cost_lines_bill_document(uuid,jsonb,boolean)'::regprocedure) <> 'i'
     OR has_function_privilege('service_role', 'public.job_cost_lines_bill_document(uuid,jsonb,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ZZTEST rollback did not restore 20261118195100''s cost-line twin';
  END IF;
  -- The owner's answer is kept: the table and its rows stay.
  IF (SELECT array_agg(account_code ORDER BY account_code) FROM public.people_account_codes)
       IS DISTINCT FROM ARRAY['301','306','475'] THEN
    RAISE EXCEPTION 'ZZTEST rollback dropped or changed people_account_codes';
  END IF;
END $$;
-- Runs again cleanly (a re-run finds 20261118195400's bodies).
\ir ../../../rollbacks/20261118195700_reconcile_people_accounts_down.sql
SELECT 'Reconcile people accounts rollback contract passed' AS result;
