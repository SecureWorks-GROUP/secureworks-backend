-- After the scorecard v2 rollback: W11's three bodies and comments are back word
-- for word (production's md5 before v2), with their access; the card answers v1
-- again; the hourly run's rollback is allowed again (the v1 card does not read
-- the run status); every data source v2 read is untouched; a second run of the
-- rollback changes nothing; and it refuses a body that is neither v2's nor W11's.
DO $$
DECLARE x record; f text;
BEGIN
 FOR x IN SELECT * FROM (VALUES ('public.context_scorecard_policy()', '50ed8ccdac924097399359a9857f02a8'),
  ('public.context_scorecard(timestamptz)', '82574dfb65328d855ad87683a78ca9cd'),
  ('public.context_scorecard_jobs(uuid,integer,timestamptz)', '6fd07f87b10ff8e0164f2daad98cce48')) AS t(sig, m) LOOP
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig)) IS DISTINCT FROM x.m THEN
   RAISE EXCEPTION 'scorecard v2 rollback: % is not W11''s body', x.sig;
  END IF;
  IF obj_description(to_regprocedure(x.sig), 'pg_proc') NOT LIKE 'Context scorecard (20261006032000)%' THEN
   RAISE EXCEPTION 'scorecard v2 rollback: % comment is not W11''s', x.sig;
  END IF;
  IF has_function_privilege('anon', x.sig, 'EXECUTE') OR has_function_privilege('authenticated', x.sig, 'EXECUTE')
     OR NOT has_function_privilege('service_role', x.sig, 'EXECUTE') THEN
   RAISE EXCEPTION 'scorecard v2 rollback: % access wrong', x.sig;
  END IF;
 END LOOP;
 IF (SELECT proconfig FROM pg_proc WHERE oid = 'public.context_scorecard(timestamptz)'::regprocedure) <> ARRAY['search_path=public, pg_temp'] THEN
  RAISE EXCEPTION 'scorecard v2 rollback: the v1 card keeps a setting it never had';
 END IF;
 IF public.context_scorecard(now())->>'version' <> 'context-scorecard-v1'
    OR public.context_scorecard_jobs(NULL, 1, now())->>'version' <> 'context-scorecard-jobs-v1' THEN
  RAISE EXCEPTION 'scorecard v2 rollback: the v1 card and page do not answer';
 END IF;
 FOREACH f IN ARRAY ARRAY['public.context_lead_monitored_jobs(uuid[],timestamptz)', 'public.context_scorecard_run_status(timestamptz)',
   'public.context_history_crm_summary()', 'public.context_party_roles_lanes(timestamptz,integer)',
   'public.context_placement_grades_newest(timestamptz,text)', 'public.context_email_history_reach(timestamptz)',
   'public.context_grades_newest(timestamptz)', 'public.context_item_kinds()', 'public.context_scorecard_lane_of(text,text,text,text,text,jsonb)'] LOOP
  IF to_regprocedure(f) IS NULL THEN RAISE EXCEPTION 'scorecard v2 rollback: % lost', f; END IF;
 END LOOP;
END $$;
-- The hourly run's rollback is allowed again (inside a rolled-back transaction).
BEGIN;
\ir ../../../rollbacks/20261007040000_context_scorecard_hourly_down.sql
DO $$ BEGIN
 IF to_regprocedure('public.context_scorecard_run_status(timestamptz)') IS NOT NULL THEN
  RAISE EXCEPTION 'scorecard v2 rollback: the hourly rollback did not run after it';
 END IF;
END $$;
ROLLBACK;
-- A second run changes nothing.
BEGIN;
\ir ../../../rollbacks/20261007120000_context_scorecard_v2_down.sql
DO $$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_scorecard(timestamptz)'::regprocedure) <> '82574dfb65328d855ad87683a78ca9cd' THEN
  RAISE EXCEPTION 'scorecard v2 rollback: a second run changed the card';
 END IF;
END $$;
ROLLBACK;
-- It refuses a body that is neither v2's nor W11's, and changes nothing.
BEGIN;
CREATE OR REPLACE FUNCTION public.context_scorecard(p_as_of timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE sql STABLE AS $$ SELECT '{"version": "hand-made"}'::jsonb $$;
SAVEPOINT sc2_down_refusal;
\echo 'scorecard v2 rollback contract: the errors below are the rollback refusing a hand-made body, as it must'
\set ON_ERROR_STOP 0
\ir ../../../rollbacks/20261007120000_context_scorecard_v2_down.sql
\set ON_ERROR_STOP 1
\if :ERROR
\else
SELECT 'scorecard v2 rollback ran over a hand-made body'::text::integer;
\endif
ROLLBACK TO SAVEPOINT sc2_down_refusal;
DO $$ BEGIN
 IF public.context_scorecard(now())->>'version' IS DISTINCT FROM 'hand-made'
    OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_scorecard_policy()'::regprocedure) <> '50ed8ccdac924097399359a9857f02a8' THEN
  RAISE EXCEPTION 'scorecard v2 rollback: a refused rollback changed something';
 END IF;
END $$;
ROLLBACK;
