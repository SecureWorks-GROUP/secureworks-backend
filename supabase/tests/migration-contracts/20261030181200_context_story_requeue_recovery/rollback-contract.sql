DO $$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='context_job_story_enqueue_changed(integer)'::regprocedure) <> 'b0d7b0c0d3b99759c37814a68fab6b17' THEN RAISE EXCEPTION 'story requeue rollback mismatch'; END IF; END $$;
\set expect_legacy true
\ir contract.sql
