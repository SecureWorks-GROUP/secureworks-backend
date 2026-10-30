DO $$ DECLARE x record; BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_source_freshness_policy()','0b131a763a53c21811465e04a66be539'),
  ('public.context_source_freshness()','474f94e13b3be83ffe7ce6c4f5b2d774')) AS v(sig,hash) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=x.sig::regprocedure) IS DISTINCT FROM x.hash
   OR has_function_privilege('anon',x.sig,'EXECUTE') OR has_function_privilege('authenticated',x.sig,'EXECUTE')
   OR NOT has_function_privilege('service_role',x.sig,'EXECUTE') THEN RAISE EXCEPTION 'capture_evaluation rollback: body or ACL not restored %',x.sig; END IF;
 END LOOP;
 IF public.context_source_freshness_policy() ? 'ignored_capture_event_types' THEN RAISE EXCEPTION 'capture_evaluation rollback: policy not restored'; END IF;
END $$;
\ir ../../../rollbacks/20261030192929_context_capture_excludes_evaluation_down.sql
