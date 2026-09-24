-- C1d's reconciler status block must be the function this follow-up owns.
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_ghl_capture_status()')) IS DISTINCT FROM 'c2a1df7fe3cbc405f552c0bf2268f5ed'
 THEN RAISE EXCEPTION 'ghl retry status setup: expected the C1d status body'; END IF;
END $$;
