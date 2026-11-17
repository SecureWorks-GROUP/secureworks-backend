-- After the down: the client story is story safety's body again, with its comment and grants.
DO $c$
DECLARE sig constant text := 'public.context_client_story(uuid,timestamptz)';
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(sig)) IS DISTINCT FROM 'a362a79d0ce92295f509f6e1b0f0ba66' THEN
  RAISE EXCEPTION 'client story saved rollback: the client story must be story safety''s body';
 END IF;
 IF position('client story saved, 20261117090000' IN coalesce(obj_description(to_regprocedure(sig), 'pg_proc'), '')) > 0
    OR coalesce(obj_description(to_regprocedure(sig), 'pg_proc'), '') NOT LIKE 'Job story (20261006014000), story fixes (20261006033000), story safety (20261006040000):%' THEN
  RAISE EXCEPTION 'client story saved rollback: the comment must be story safety''s';
 END IF;
 IF has_function_privilege('anon', sig, 'EXECUTE') OR has_function_privilege('authenticated', sig, 'EXECUTE')
    OR NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN
  RAISE EXCEPTION 'client story saved rollback: service role only';
 END IF;
END $c$;
