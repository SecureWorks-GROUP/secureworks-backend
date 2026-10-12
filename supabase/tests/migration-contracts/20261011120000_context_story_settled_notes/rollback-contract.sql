-- Runs after supabase/rollbacks/20261011120000_context_story_settled_notes_down.sql on the stack
-- applied through this case: 20261011100000's assembler and 20261007010000's story read are back,
-- bodies and comments word for word, with the same access, and the story has no settled list again.
DO $restored$
DECLARE x record; live text; s jsonb;
BEGIN
 FOR x IN SELECT * FROM (VALUES
   ('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)', '88b1d086f95f1db15927ff4c67e2eb09',
    'Job story (20261006014000), story fixes (20261006033000), story safety (20261006040000): (lead cutoff, 20261007010000) (scoping pipeline, 20261009133000) (story lead rank, 20261011100000) the open loops%'),
   ('public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)', '6ea32b33b81609c3c5838fd39cbfc129',
    'Job story (20261006014000), lead cutoff (20261007010000): the record part also carries lead%')) v(sig, m, cmt) LOOP
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.m THEN
   RAISE EXCEPTION 'story settled notes rollback: % md5 % (want %)', x.sig, coalesce(live, '<missing>'), x.m;
  END IF;
  IF coalesce(obj_description(to_regprocedure(x.sig), 'pg_proc'), '') LIKE '%(story settled notes%'
     OR coalesce(obj_description(to_regprocedure(x.sig), 'pg_proc'), '') NOT LIKE x.cmt THEN
   RAISE EXCEPTION 'story settled notes rollback: the % comment is not the earlier one', x.sig;
  END IF;
  IF has_function_privilege('anon', x.sig, 'EXECUTE') OR has_function_privilege('authenticated', x.sig, 'EXECUTE')
     OR NOT has_function_privilege('service_role', x.sig, 'EXECUTE') THEN
   RAISE EXCEPTION 'story settled notes rollback: % access wrong', x.sig;
  END IF;
 END LOOP;
 s := public.context_job_story_assemble('{"id":"x","status":"in_progress","type":"fencing","created_at":"2026-09-22T00:00:00Z"}', '{}'::jsonb,
   NULL, NULL, '2026-10-11T04:00:00Z', NULL);
 IF s ? 'settled' OR s ? 'disputed' THEN
  RAISE EXCEPTION 'story settled notes rollback: the earlier story has no settled or disputed list: %', s;
 END IF;
END $restored$;
