DO $$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.rerun_context_attribution(integer,text)'::regprocedure)<>'c80fea38727a0302b57a1111e6099c1c'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_core_status()'::regprocedure)<>'07c51159715c91663a1038f01bf6e09c'
 THEN RAISE EXCEPTION 'recheck rollback did not restore live preimages'; END IF;
END $$;
