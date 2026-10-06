-- After the down migration: the five bodies are the 972 ones again, word for word
-- (production's md5 of each, read 6 Oct 2026), with their 972 comments, flags
-- (SECURITY DEFINER or not, STABLE, the search_path setting) and grants; a second
-- run of the down changes nothing: all five bodies, comments, flags and grants are
-- checked again after it.
DO $rb$
DECLARE x record; live text; p record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
   ('public.context_job_record_timeline(uuid[],timestamptz)', 'a8b34905f83ab30739b8cbc5cf268748', 'Job record (20261006011000):%', true),
   ('public.context_job_record_loops(uuid[],timestamptz)', 'b872b6d0f55411280de1bd0c405771fb', 'Job record (20261006011000):%', true),
   ('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)', '4860fd81fb02905e0ae0ddccd64d0f1c', 'Job story (20261006014000):%', false),
   ('public.context_job_story_ledger(uuid,uuid,timestamptz)', '3352950310073c33cc83f64bd80f60a9', 'Job story (20261006014000):%', true),
   ('public.context_client_story(uuid,timestamptz)', '3f2cc15aa814f9b993a80e282d1fd65b', 'Job story (20261006014000):%', true)) v(sig, md5, cmt, definer) LOOP
  SELECT md5(pr.prosrc) AS m, pr.prosecdef, pr.provolatile, pr.proconfig INTO p FROM pg_proc pr WHERE pr.oid = to_regprocedure(x.sig);
  IF p.m IS DISTINCT FROM x.md5 THEN
   RAISE EXCEPTION 'story fixes rollback contract: % md5 % (want the 972 body %)', x.sig, coalesce(p.m, '<missing>'), x.md5;
  END IF;
  IF obj_description(to_regprocedure(x.sig), 'pg_proc') NOT LIKE x.cmt OR obj_description(to_regprocedure(x.sig), 'pg_proc') LIKE '%story fixes%' THEN
   RAISE EXCEPTION 'story fixes rollback contract: % comment is not the 972 one', x.sig;
  END IF;
  IF p.prosecdef IS DISTINCT FROM x.definer OR p.provolatile IS DISTINCT FROM 's'
     OR (x.definer AND p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'])
     OR (NOT x.definer AND p.proconfig IS NOT NULL) THEN
   RAISE EXCEPTION 'story fixes rollback contract: % flags are not the 972 ones (definer %, volatility %, config %)', x.sig, p.prosecdef, p.provolatile, p.proconfig;
  END IF;
  IF has_function_privilege('anon', x.sig, 'EXECUTE') OR has_function_privilege('authenticated', x.sig, 'EXECUTE')
     OR NOT has_function_privilege('service_role', x.sig, 'EXECUTE') THEN
   RAISE EXCEPTION 'story fixes rollback contract: % access changed', x.sig;
  END IF;
 END LOOP;
END $rb$;
\ir ../../../rollbacks/20261006033000_context_story_fixups_down.sql
DO $rb2$
DECLARE x record; p record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
   ('public.context_job_record_timeline(uuid[],timestamptz)', 'a8b34905f83ab30739b8cbc5cf268748', 'Job record (20261006011000):%', true),
   ('public.context_job_record_loops(uuid[],timestamptz)', 'b872b6d0f55411280de1bd0c405771fb', 'Job record (20261006011000):%', true),
   ('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)', '4860fd81fb02905e0ae0ddccd64d0f1c', 'Job story (20261006014000):%', false),
   ('public.context_job_story_ledger(uuid,uuid,timestamptz)', '3352950310073c33cc83f64bd80f60a9', 'Job story (20261006014000):%', true),
   ('public.context_client_story(uuid,timestamptz)', '3f2cc15aa814f9b993a80e282d1fd65b', 'Job story (20261006014000):%', true)) v(sig, md5, cmt, definer) LOOP
  SELECT md5(pr.prosrc) AS m, pr.prosecdef, pr.provolatile, pr.proconfig INTO p FROM pg_proc pr WHERE pr.oid = to_regprocedure(x.sig);
  IF p.m IS DISTINCT FROM x.md5 OR obj_description(to_regprocedure(x.sig), 'pg_proc') NOT LIKE x.cmt
     OR obj_description(to_regprocedure(x.sig), 'pg_proc') LIKE '%story fixes%'
     OR p.prosecdef IS DISTINCT FROM x.definer OR p.provolatile IS DISTINCT FROM 's'
     OR (x.definer AND p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']) OR (NOT x.definer AND p.proconfig IS NOT NULL)
     OR has_function_privilege('anon', x.sig, 'EXECUTE') OR has_function_privilege('authenticated', x.sig, 'EXECUTE')
     OR NOT has_function_privilege('service_role', x.sig, 'EXECUTE') THEN
   RAISE EXCEPTION 'story fixes rollback contract: a second run of the down must change nothing, but % differs (md5 %)', x.sig, p.m;
  END IF;
 END LOOP;
END $rb2$;
