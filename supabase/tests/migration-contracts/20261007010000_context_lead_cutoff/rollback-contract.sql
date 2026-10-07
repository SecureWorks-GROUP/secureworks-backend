-- Rollback contract for 20261007010000_context_lead_cutoff: after the down migration the four
-- replaced bodies are the ones 20261006040000 and 20261006014000 left (md5 of prosrc, with their
-- comments, flags and grants), the rule's two functions are gone, a lead 29 days after its quote
-- reads as before the lead cutoff, and running the down again changes nothing.
DO $restored$
DECLARE x record; p record;
BEGIN
 IF to_regprocedure('public.context_lead_monitored_jobs(uuid[],timestamptz)') IS NOT NULL
    OR to_regprocedure('public.context_lead_monitored(uuid,timestamptz)') IS NOT NULL THEN
  RAISE EXCEPTION 'lead cutoff rollback contract: the rule''s two functions must be dropped';
 END IF;
 FOR x IN SELECT * FROM (VALUES
   ('public.context_job_record_loops(uuid[],timestamptz)', '21eef050dc79da65d01afc0d8325a38d', true,
    'Job record (20261006011000), story fixes (20261006033000), story safety (20261006040000): (eighth review)%'),
   ('public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)', '8557a596bc5628f9823d398b54decdc3', true, 'Job story (20261006014000): job-story-v1 for one job%'),
   ('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)', '7b65d10aac4a4f898c71861707346690', false,
    'Job story (20261006014000), story fixes (20261006033000), story safety (20261006040000): (ninth review)%'),
   ('public.context_ledger_judge(uuid[])', '112cce8cf65ef4086483ee069ee294a5', true, 'Context ledger store (20261006013000), story safety (20261006040000): (eighth review)%')
 ) v(sig, md5, definer, cmt) LOOP
  SELECT md5(pr.prosrc) AS m, pr.prosecdef, pr.proconfig, obj_description(pr.oid, 'pg_proc') AS c INTO p FROM pg_proc pr WHERE pr.oid = to_regprocedure(x.sig);
  IF p.m IS DISTINCT FROM x.md5 THEN
   RAISE EXCEPTION 'lead cutoff rollback contract: % md5 % (want %)', x.sig, p.m, x.md5;
  END IF;
  IF p.prosecdef IS DISTINCT FROM x.definer OR (x.definer AND p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'])
     OR coalesce(p.c, '') NOT LIKE x.cmt OR p.c LIKE '%lead cutoff%' THEN
   RAISE EXCEPTION 'lead cutoff rollback contract: % flags or comment not restored', x.sig;
  END IF;
  IF has_function_privilege('anon', x.sig, 'EXECUTE') OR has_function_privilege('authenticated', x.sig, 'EXECUTE')
     OR NOT has_function_privilege('service_role', x.sig, 'EXECUTE') THEN
   RAISE EXCEPTION 'lead cutoff rollback contract: % access changed', x.sig;
  END IF;
 END LOOP;
END $restored$;

-- A lead 29 days after its quote reads as it did before the lead cutoff.
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.jobs (id, org_id, job_number, status, type, client_name, ghl_contact_id, pricing_json, created_at, updated_at)
VALUES ('70000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000aa', 'SWF-97002', 'quoted', 'fencing', 'Lead Two', 'ct7002', '{}',
        '2026-07-01 00:00Z', '2026-07-01 00:00Z');
INSERT INTO public.job_documents (id, job_id, type, quote_number, version, created_at, sent_at)
VALUES ('70e00000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000002', 'quote', 'Q-7002', 1, '2026-09-08 01:00Z', '2026-09-08 02:00Z');
DO $before$
DECLARE r record; s jsonb;
BEGIN
 SELECT * INTO r FROM public.context_job_record_loops(ARRAY['70000000-0000-4000-8000-000000000002'::uuid], '2026-10-07 02:00Z') l
 WHERE l.rule = 'R7_quote_waiting';
 s := public.context_job_story('70000000-0000-4000-8000-000000000002', '2026-10-07 02:00Z');
 IF r.what IS DISTINCT FROM 'Quote Q-7002 v1 sent Tue 8 Sep 2026 (29 days), not viewed; no answer and no customer message since'
    OR s->'now'->>'whose_move' IS DISTINCT FROM 'customer' OR s->'now' ? 'monitored' THEN
  RAISE EXCEPTION 'lead cutoff rollback contract: the story reads as before the lead cutoff: % / %', r.what, s->'now';
 END IF;
END $before$;
ROLLBACK;

-- Running the down again changes nothing (its guard accepts the earlier bodies).
BEGIN;
CREATE TEMP TABLE lead_cutoff_down_md5 AS
 SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS m FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('context_job_record_loops', 'context_job_story', 'context_job_story_assemble', 'context_ledger_judge');
\ir ../../../rollbacks/20261007010000_context_lead_cutoff_down.sql
DO $again$
BEGIN
 IF (SELECT count(*) FROM lead_cutoff_down_md5) <> 4 OR EXISTS (SELECT 1 FROM lead_cutoff_down_md5 x JOIN pg_proc p ON p.oid = x.sig::regprocedure
       WHERE md5(p.prosrc) IS DISTINCT FROM x.m) THEN
  RAISE EXCEPTION 'lead cutoff rollback contract: a second down must change nothing';
 END IF;
END $again$;
ROLLBACK;
