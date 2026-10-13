-- After the down: the lane list is the email deep history slice's again, byte for byte,
-- the reader no longer admits closeout, and the close-out tables and column are gone.
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.automation_switch_cron_lanes()'::regprocedure) <> '6498276b1eb16b527fb76dd2b0fa6d83'
 THEN RAISE EXCEPTION 'closeout rollback: lane list not restored'; END IF;
 IF public.automation_lane_enabled('closeout') THEN RAISE EXCEPTION 'closeout rollback: closeout lane still admitted'; END IF;
 IF position('closeout' in (SELECT prosrc FROM pg_proc WHERE oid = 'public.automation_lane_enabled(text)'::regprocedure)) > 0
 THEN RAISE EXCEPTION 'closeout rollback: reader still names closeout'; END IF;
 IF to_regclass('public.job_closeout_settings') IS NOT NULL OR to_regclass('public.job_closeout_state') IS NOT NULL
  OR to_regclass('public.job_review_claims') IS NOT NULL OR to_regprocedure('public.trigger_job_closeout_sweep()') IS NOT NULL
 THEN RAISE EXCEPTION 'closeout rollback: close-out objects remain'; END IF;
 IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'automation_switches' AND column_name = 'closeout')
 THEN RAISE EXCEPTION 'closeout rollback: automation_switches.closeout remains'; END IF;
 IF NOT public.automation_lane_enabled('capture') AND (SELECT capture AND NOT all_stop FROM public.automation_switches WHERE id = 1)
 THEN RAISE EXCEPTION 'closeout rollback: capture lane broken'; END IF;
END $$;
