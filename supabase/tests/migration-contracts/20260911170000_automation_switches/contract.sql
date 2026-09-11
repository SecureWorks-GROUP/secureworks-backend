BEGIN;
DO $$ BEGIN
 IF NOT public.automation_lane_enabled('capture') THEN RAISE EXCEPTION 'switch seed'; END IF;
 DELETE FROM public.automation_switches;
 IF public.automation_lane_enabled('capture') THEN RAISE EXCEPTION 'missing row reads on'; END IF;
END $$;
ROLLBACK;
