DO $$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)'::regprocedure) <> 'db181308debc03dfd15b433f45abf573' THEN RAISE EXCEPTION 'invoice matter rollback mismatch'; END IF; END $$;
\set expect_legacy true
\ir contract.sql
