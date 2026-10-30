DO $$ BEGIN
IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='context_unplaced_for_job(uuid)'::regprocedure) IS DISTINCT FROM 'f2382688c5ae085bd0a7f88a11053c12' THEN RAISE EXCEPTION 'offjob rollback preimage mismatch'; END IF;
IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='context_job_story_meta(uuid,timestamp with time zone)'::regprocedure) IS DISTINCT FROM 'b50bdd406db617a3361497c2c921a758' THEN RAISE EXCEPTION 'offjob rollback preimage mismatch'; END IF;
IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='context_job_story_placement_review(jsonb,uuid,uuid,timestamp with time zone,boolean)'::regprocedure) IS DISTINCT FROM '49493e7e110b7727f8025a34f4e8f8df' THEN RAISE EXCEPTION 'offjob rollback preimage mismatch'; END IF;
IF to_regprocedure('context_ledger_event_locations(public.business_events)') IS NOT NULL THEN RAISE EXCEPTION 'offjob rollback helper retained'; END IF; END $$;
