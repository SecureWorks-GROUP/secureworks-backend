BEGIN;
DO $$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.reconcile_list_page(uuid,text[],integer,jsonb)'::regprocedure)
       IS DISTINCT FROM '21429cddb4dcbda92d5f36083fdf453a'
    OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.reconcile_list_counts(uuid)'::regprocedure)
       IS DISTINCT FROM '40f09ca674d5313c3500100114400280'
    OR to_regprocedure('public.reconcile_item_xero_hidden(uuid,text,text)') IS NOT NULL
    OR NOT has_function_privilege('service_role', 'public.reconcile_list_page(uuid,text[],integer,jsonb)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.reconcile_list_counts(uuid)', 'EXECUTE')
    OR to_regclass('public.people_account_codes') IS NULL THEN
    RAISE EXCEPTION 'rollback must return 20261118195700''s list bodies and grants, drop the helper and keep the table';
  END IF;
END $$;
SELECT 'PASS reconcile hidden Xero lines rollback: 20261118195700 bodies, grants and table kept, helper dropped' AS result;
ROLLBACK;
