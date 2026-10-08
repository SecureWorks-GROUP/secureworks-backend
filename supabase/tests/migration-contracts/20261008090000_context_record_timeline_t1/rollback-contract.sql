-- After the down migration: the timeline is the story safety (20261006040000) body word for word
-- (md5 of prosrc as production runs it), with its comment, flags and grants, and its rules are the
-- old ones again (a scope save is a site visit). A second run of the down changes nothing.
CREATE FUNCTION pg_temp.t1_rb_check(p_when text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p record; f constant text := 'public.context_job_record_timeline(uuid[],timestamptz)';
BEGIN
 SELECT md5(pr.prosrc) AS m, pr.prosecdef, pr.provolatile, pr.proconfig, obj_description(pr.oid, 'pg_proc') AS c INTO p
 FROM pg_proc pr WHERE pr.oid = to_regprocedure(f);
 IF p.m IS DISTINCT FROM '0921f25dfb5a67ab04629d2977e9f0a6' THEN
  RAISE EXCEPTION 'record timeline T1 rollback contract (%): timeline md5 % (want the 20261006040000 body)', p_when, coalesce(p.m, '<missing>');
 END IF;
 IF NOT p.prosecdef OR p.provolatile <> 's' OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
  RAISE EXCEPTION 'record timeline T1 rollback contract (%): flags changed', p_when;
 END IF;
 IF p.c NOT LIKE 'Job record (20261006011000), story fixes (20261006033000), story safety (20261006040000): a booking change on a ghost%' THEN
  RAISE EXCEPTION 'record timeline T1 rollback contract (%): comment is not the 20261006040000 one', p_when;
 END IF;
 IF NOT has_function_privilege('service_role', f, 'EXECUTE') OR has_function_privilege('anon', f, 'EXECUTE')
    OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
  RAISE EXCEPTION 'record timeline T1 rollback contract (%): access changed', p_when;
 END IF;
END $$;
SELECT pg_temp.t1_rb_check('after the down');
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, pricing_json, created_at, updated_at)
VALUES ('8a000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000aa', 'SWF-T81F1', 'quoted', 'fencing', 'Scope Client', '{}',
        '2026-09-07 01:33Z', '2026-09-07 01:33Z');
INSERT INTO public.job_events (id, job_id, event_type, detail_json, created_at)
VALUES ('8af00000-0000-4000-8000-0000000000f1', '8a000000-0000-4000-8000-0000000000f1', 'scope_saved', '{}', '2026-09-07 01:40Z');
SET LOCAL session_replication_role = origin;
DO $old$
BEGIN
 IF (SELECT t.kind FROM public.context_job_record_timeline(ARRAY['8a000000-0000-4000-8000-0000000000f1'::uuid], '2026-10-07 06:10Z') t
     WHERE t.source_id = '8af00000-0000-4000-8000-0000000000f1') IS DISTINCT FROM 'site_visit' THEN
  RAISE EXCEPTION 'record timeline T1 rollback contract: the old rules are back (a scope save is a site visit again)';
 END IF;
END $old$;
ROLLBACK;
\ir ../../../rollbacks/20261008090000_context_record_timeline_t1_down.sql
SELECT pg_temp.t1_rb_check('after a second down');
