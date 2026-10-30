DO $$ BEGIN
IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='context_ledger_judge(uuid[])'::regprocedure) IS DISTINCT FROM '484fbb9ba08a6167b3fc5a7f78898ecd' THEN RAISE EXCEPTION 'placement rollback mismatch'; END IF;
IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='context_ledger_packet(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure) IS DISTINCT FROM 'e2ccc5450117a4e36b30df104752d1cd' THEN RAISE EXCEPTION 'placement rollback mismatch'; END IF;
IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='context_ledger_finish(uuid,uuid,uuid,text,jsonb)'::regprocedure) IS DISTINCT FROM '1695e52f99f56534a24166f6662ced35' THEN RAISE EXCEPTION 'placement rollback mismatch'; END IF;
IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='context_job_story_ledger(uuid,uuid,timestamp with time zone)'::regprocedure) IS DISTINCT FROM '6ecf46dd34fb7d8280f126c88a5bad21' THEN RAISE EXCEPTION 'placement rollback mismatch'; END IF;
IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='context_job_story(uuid,timestamp with time zone,uuid,timestamp with time zone,boolean)'::regprocedure) IS DISTINCT FROM '240b50d71c6d1cd6c4266e275366bc0e' THEN RAISE EXCEPTION 'placement rollback mismatch'; END IF;
IF to_regprocedure('context_ledger_placement_state(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'placement rollback left helper'; END IF;
END $$;
