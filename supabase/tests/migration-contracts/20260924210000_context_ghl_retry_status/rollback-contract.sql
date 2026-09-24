-- The follow-up rollback restores the exact C1d projection.
DO $$
DECLARE s jsonb; composed jsonb;
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_ghl_capture_status()')) IS DISTINCT FROM 'c2a1df7fe3cbc405f552c0bf2268f5ed'
 THEN RAISE EXCEPTION 'ghl retry status rollback: C1d body not restored'; END IF;
 s:=public.context_ghl_capture_status();
 composed:=public.context_pipeline_status();
 IF s->'reconciler' ? 'retry_from' OR composed#>'{ghl_capture,reconciler,retry_from}' IS NOT NULL
 THEN RAISE EXCEPTION 'ghl retry status rollback left the new field'; END IF;
 IF has_function_privilege('anon','public.context_ghl_capture_status()','EXECUTE')
  OR NOT has_function_privilege('service_role','public.context_ghl_capture_status()','EXECUTE')
 THEN RAISE EXCEPTION 'ghl retry status rollback grants'; END IF;
END $$;
