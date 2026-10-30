DO $$ BEGIN
 IF to_regprocedure('public.context_job_story_credit_sig(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'credit witness survived down';END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='context_job_story_money_sig(uuid)'::regprocedure) NOT IN ('62392d8aab2f38362be4b2ddcfab1fbc','b2f762db966bf9f3417e759827705be2') THEN RAISE EXCEPTION 'credit down did not restore original signature';END IF;
 IF to_regclass('public.xero_supplier_credit_notes') IS NULL THEN RAISE EXCEPTION 'credit source lost';END IF;
END $$;
\ir ../../../rollbacks/20261031010000_context_story_credit_refresh_down.sql
