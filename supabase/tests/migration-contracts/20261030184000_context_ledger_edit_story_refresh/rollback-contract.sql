DO $$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_story_enqueue_changed(integer)'::regprocedure) <> 'f4c040642a58cf9e5c281c76d94abecb' THEN RAISE EXCEPTION 'ledger edit rollback mismatch'; END IF; END $$;
\set expect_legacy true
\ir contract.sql
