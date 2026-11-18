DO $$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.job_cost_lines_sync_receipt(uuid)'))
   IS DISTINCT FROM 'c499c1e901175e363c3ad018a4b190c8' THEN
   RAISE EXCEPTION 'unbooked hold rollback: the 20261118115701 body is not back';
 END IF;
END $$;
SELECT 'PASS: rollback restores the receipt sync body exactly' AS result;
