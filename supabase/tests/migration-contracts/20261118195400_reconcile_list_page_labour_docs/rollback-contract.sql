DO $$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.reconcile_list_page(uuid,text[],integer,jsonb)'::regprocedure)
       IS DISTINCT FROM 'b599baff51f0323ef9c55ff2e853caee'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.reconcile_list_counts(uuid)'::regprocedure)
       IS DISTINCT FROM '50eba5230d66097482cc1cab9ef44f2c' THEN
    RAISE EXCEPTION 'ZZTEST rollback did not restore 20261118195200''s bodies';
  END IF;
  IF obj_description('public.reconcile_list_counts(uuid)'::regprocedure, 'pg_proc')
       IS DISTINCT FROM 'Reconcile list (P2-03.6): open items per kind for one org. Read only.'
     OR NOT has_function_privilege('service_role', 'public.reconcile_list_page(uuid,text[],integer,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.reconcile_list_counts(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ZZTEST rollback did not restore comments and grants';
  END IF;
END $$;
-- Runs again cleanly (a re-run finds 20261118195200's bodies).
\ir ../../../rollbacks/20261118195400_reconcile_list_page_labour_docs_down.sql
SELECT 'Reconcile list labour documents rollback contract passed' AS result;
