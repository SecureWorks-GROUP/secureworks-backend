DO $$ BEGIN IF public.automation_lane_enabled('capture') THEN RAISE EXCEPTION 'rollback must stop'; END IF; END $$;
