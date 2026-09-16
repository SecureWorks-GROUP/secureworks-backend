DO $$ BEGIN
 IF public.automation_lane_enabled('extraction') THEN RAISE EXCEPTION 'B3 rollback did not stop extraction'; END IF;
 IF has_function_privilege('service_role','public.persist_luna_context_revision(uuid,uuid,uuid,jsonb,jsonb,jsonb,jsonb,text,integer)','EXECUTE') THEN RAISE EXCEPTION 'B3 rollback still writable'; END IF;
 IF to_regclass('public.luna_context_job_revisions') IS NULL THEN RAISE EXCEPTION 'B3 rollback lost custody'; END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='context_fact_stamp_trust' AND NOT tgisinternal) THEN RAISE EXCEPTION 'B3 rollback left trust trigger'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.job_context WHERE id='b3000000-0000-0000-0000-000000000003' AND trust='luna') THEN RAISE EXCEPTION 'B3 rollback erased audit truth'; END IF;
END $$;
