-- One behavioural contract: exact saved-text parity before install, page summaries after it.
-- All replacements/fixtures and the explicit install roll back, including on a shared shard.
BEGIN;
SET LOCAL statement_timeout='120s';
\ir ../../../migrations/20261118041726_context_client_story_stored.sql
CREATE TEMP SEQUENCE p0013_story_calls;
-- Controlled card input only. The client query and page refresh below are real functions.
DO $inputs$
DECLARE p record;
BEGIN
 FOR p IN SELECT oid,pg_get_function_arguments(oid) AS args FROM pg_proc
   WHERE pronamespace='public'::regnamespace AND proname='context_job_story' LOOP
  EXECUTE format('CREATE OR REPLACE FUNCTION public.context_job_story(%s) RETURNS jsonb LANGUAGE plpgsql AS $s$
   BEGIN
    IF current_setting(''p0013.fail_story'',true)=''on'' THEN RAISE EXCEPTION ''p0013 unwanted live build''; END IF;
    PERFORM nextval(''pg_temp.p0013_story_calls'');
    RETURN jsonb_build_object(''now'',jsonb_build_object(''phase'',coalesce(nullif(current_setting(''p0013.phase'',true),''''),''install''),''line'',''ZZTEST stored line''),
     ''loops'',jsonb_build_array(jsonb_build_object(''key'',''ZZTEST:next'',''rank'',1,''status'',''open'',''what'',''ZZTEST next step'')));
   END $s$',p.args);
 END LOOP;
END $inputs$;
CREATE OR REPLACE FUNCTION public.context_job_story_text_get(p_job_id uuid,p_card jsonb DEFAULT NULL,p_check boolean DEFAULT true)
 RETURNS jsonb LANGUAGE sql STABLE AS $s$ SELECT '{"status":"fresh","card_hash":"ZZTEST"}'::jsonb $s$;
SET LOCAL session_replication_role=replica;
INSERT INTO public.jobs(id,org_id,job_number,type,status,created_at,ghl_contact_id,pricing_json)
 SELECT ('00000103-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,'00000000-0000-4000-8000-0000000000aa',
 'ZZTEST-'||(419+g),'fencing','accepted',now()-interval '30 days'+g*interval '1 hour','ZZTEST-P0013','{}'
 FROM generate_series(1,25) g;
INSERT INTO public.context_job_story_texts(job_id,written_at,checked_at,sections,status,card_hash,model)
 SELECT id,now()-interval '2 days',now()-interval '1 day',
 '{"headline":"ZZTEST saved headline","the_job":"ZZTEST","how_we_got_here":"ZZTEST","where_it_is_at":"ZZTEST","watch_out":"ZZTEST"}',
 'current',md5('ZZTEST'),'luna-story' FROM public.jobs WHERE ghl_contact_id='ZZTEST-P0013';
SET LOCAL session_replication_role=origin;
-- Keep unrelated feature branches out of this page-reader contract.
SET LOCAL session_replication_role=replica;
UPDATE public.feature_flags SET enabled=false WHERE flag_name='context_record_close_v1';
SET LOCAL session_replication_role=origin;
SELECT public.job_page_refresh(('00000103-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid)
 FROM generate_series(6,25) g;
-- The added storage lookup is a bounded primary-key probe, not a table scan.
DO $plan$
DECLARE p jsonb;
BEGIN
 EXECUTE $q$EXPLAIN (ANALYZE,FORMAT JSON) SELECT jp.page FROM public.job_pages jp
 WHERE jp.job_id='00000103-0000-4000-8000-000000000025' AND jp.status='ready'$q$ INTO p;
 IF p::text LIKE '%Seq Scan%' OR p::text NOT LIKE '%Index%'
 OR (p #>> '{0,Plan,Actual Rows}')::integer>1 THEN
  RAISE EXCEPTION 'P0013: page probe is not index bounded: %',p; END IF;
END $plan$;
CREATE TEMP TABLE p0013_before AS SELECT public.context_client_story('00000103-0000-4000-8000-000000000025') AS s;
\if :{?p0013_red}
DO $red$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(public.context_client_story('00000103-0000-4000-8000-000000000025')->'jobs') j
   WHERE j->>'phase'='install') THEN RAISE EXCEPTION 'P0013 RED: main omits the stored phase and open items'; END IF;
END $red$;
\endif
DO $inactive$ BEGIN
 IF public.context_client_story('00000103-0000-4000-8000-000000000025') IS DISTINCT FROM
 public.context_client_story_saved_main('00000103-0000-4000-8000-000000000025') THEN
  RAISE EXCEPTION 'P0013: inactive migration changed main answer'; END IF;
END $inactive$;
SELECT public.install_context_client_story_stored();
SELECT set_config('p0013.fail_story','on',true);
SELECT setval('pg_temp.p0013_story_calls',1,false);
DO $current$
DECLARE s jsonb;j jsonb;b jsonb;
BEGIN
 SELECT p.s INTO b FROM p0013_before p;
 s:=public.context_client_story('00000103-0000-4000-8000-000000000025');
 IF s->>'version'<>'client-story-v1' OR jsonb_array_length(s->'jobs')<>25
 OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(s) k) IS DISTINCT FROM
    (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(b) k)
 OR s->'money' IS DISTINCT FROM b->'money' THEN RAISE EXCEPTION 'P0013: shape, all jobs or money changed'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(s->'jobs') x WHERE x->>'phase'='install')<>20
 OR jsonb_array_length(s->'open_loops')<>10
 OR (SELECT is_called FROM pg_temp.p0013_story_calls) THEN RAISE EXCEPTION 'P0013: 20 stored summaries, top 10 loops, zero live builds required'; END IF;
 FOR j IN SELECT value FROM jsonb_array_elements(s->'jobs') LOOP
  IF (j-'phase') IS DISTINCT FROM (SELECT value-'phase' FROM jsonb_array_elements(b->'jobs') WHERE value->>'job_id'=j->>'job_id') THEN
   RAISE EXCEPTION 'P0013: saved headline/provenance or job money changed'; END IF;
 END LOOP;
END $current$;
-- Missing and failed pages remain unknown, while saved headline/source/age still answer.
DELETE FROM public.job_pages WHERE job_id='00000103-0000-4000-8000-000000000025';
UPDATE public.job_pages SET status='failed' WHERE job_id='00000103-0000-4000-8000-000000000024';
DO $missing$
DECLARE s jsonb;
BEGIN
 s:=public.context_client_story('00000103-0000-4000-8000-000000000025');
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'not_known') k
  WHERE k->>'what'='2 of this client''s jobs have no stored page yet; open the job to build it.')
 OR (SELECT count(*) FROM jsonb_array_elements(s->'jobs') j WHERE j->>'phase'='install')<>18
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(s->'jobs') j WHERE j->>'now'<>'ZZTEST saved headline') THEN
 RAISE EXCEPTION 'P0013: absent/failed page must be named without losing saved text'; END IF;
END $missing$;
-- A failed page read falls back byte-for-byte, then retries cleanly after recovery.
ALTER TABLE public.job_pages RENAME TO p0013_unreadable_pages;
DO $read_failure$ BEGIN
 IF public.context_client_story('00000103-0000-4000-8000-000000000025') IS DISTINCT FROM (SELECT s FROM p0013_before) THEN
  RAISE EXCEPTION 'P0013: failed page read must fall back to main'; END IF;
END $read_failure$;
ALTER TABLE public.p0013_unreadable_pages RENAME TO job_pages;
SELECT set_config('p0013.fail_story','off',true);
-- Office changed the card, then the real refresh publishes that change. A reader never writes it.
SELECT set_config('p0013.phase','complete',true);
SELECT public.job_page_refresh('00000103-0000-4000-8000-000000000025');
DO $edited$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(public.context_client_story('00000103-0000-4000-8000-000000000025')->'jobs') j
 WHERE j->>'job_id'='00000103-0000-4000-8000-000000000025' AND j->>'phase'='complete') THEN
  RAISE EXCEPTION 'P0013: refreshed office edit must be read on retry'; END IF;
END $edited$;
SELECT setval('pg_temp.p0013_story_calls',1,false);
DO $historical$
DECLARE s jsonb;
BEGIN
 s:=public.context_client_story('00000103-0000-4000-8000-000000000025',now()-interval '1 day');
 IF s->>'version'<>'client-story-v1' OR (SELECT last_value FROM pg_temp.p0013_story_calls)<>20
 OR NOT (SELECT is_called FROM pg_temp.p0013_story_calls) THEN RAISE EXCEPTION 'P0013: historical read must build only newest twenty'; END IF;
END $historical$;
-- Remove restores the exact main answer; the installer also refuses to overwrite a hand edit.
\ir ../../../rollbacks/20261118041726_context_client_story_stored_down.sql
DO $remove$ BEGIN
 IF public.context_client_story('00000103-0000-4000-8000-000000000025') IS DISTINCT FROM (SELECT s FROM p0013_before) THEN
  RAISE EXCEPTION 'P0013: remove must restore main answer'; END IF;
END $remove$;
DO $hand_edit$
DECLARE d text;
BEGIN
 d:=pg_get_functiondef('public.context_client_story(uuid,timestamptz)'::regprocedure);
 EXECUTE 'CREATE OR REPLACE FUNCTION public.context_client_story(p_job_id uuid,p_as_of timestamptz DEFAULT now()) RETURNS jsonb LANGUAGE sql AS ''SELECT NULL::jsonb''';
 BEGIN
  PERFORM public.install_context_client_story_stored();
  RAISE EXCEPTION 'P0013: install clobbered hand edit';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'client_story_stored_install_preimage_changed' THEN RAISE; END IF;
 END;
 EXECUTE d;
END $hand_edit$;
DO $grants$
BEGIN
 IF has_function_privilege('anon','public.context_client_story_stored(uuid,timestamptz)','EXECUTE')
 OR has_function_privilege('authenticated','public.install_context_client_story_stored()','EXECUTE') THEN
  RAISE EXCEPTION 'P0013: private read/install exposed'; END IF;
END $grants$;
ROLLBACK;
\echo P0-01.3 contract passed: merge parity, summaries, saved provenance, missing/failed read, office refresh, retry, historical cap, guarded install/remove
