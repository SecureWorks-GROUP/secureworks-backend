\set ON_ERROR_STOP on
BEGIN;
SET LOCAL jit=off;
SET LOCAL TimeZone='UTC';
SET LOCAL statement_timeout='120s';
-- Rule 17: FU26.0's objects and this case's own are re-applied first.
\ir ../../../migrations/20261118024514_context_story_book_speed.sql
\ir ../../../migrations/20261118065939_job_story_stored_profit.sql
-- Rule 17: an earlier contract in the shard may have rebuilt the stored tables.
-- These are the store's own job indexes (20261117195801), restored if missing.
CREATE INDEX IF NOT EXISTS job_cost_events_stored_job_idx ON public.job_cost_events_stored(job_id);
CREATE INDEX IF NOT EXISTS job_revenue_events_stored_job_idx ON public.job_revenue_events_stored(job_id);
CREATE FUNCTION pg_temp.sp_assert(ok boolean,msg text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN IF ok IS NOT TRUE THEN RAISE EXCEPTION 'FU26.1: %',msg; END IF; END $f$;

-- 1. Merge changes no entry point and seeds the switch off.
SELECT pg_temp.sp_assert((SELECT md5(prosrc)='fc9a1c8f605a1dfd6c7d1ef7667bfa0d' FROM pg_proc WHERE oid='public.context_job_story_book(uuid,timestamptz)'::regprocedure),'merge changed the book');
SELECT pg_temp.sp_assert((SELECT md5(prosrc)='ac51513f6164fa256011d67c1bd82b10' FROM pg_proc WHERE oid='public.context_job_story_text_get(uuid,jsonb,boolean)'::regprocedure),'merge changed the staff read');
SELECT pg_temp.sp_assert((SELECT md5(prosrc)='7a7798901a26351b8e910da3f1392509' FROM pg_proc WHERE oid='public.context_job_story_money_sig(uuid)'::regprocedure),'merge changed the money signature');
SELECT pg_temp.sp_assert((SELECT NOT enabled FROM public.feature_flags WHERE flag_name='job_story_stored_profit_v1'),'switch not seeded off');
SELECT pg_temp.sp_assert((SELECT prosrc FROM pg_proc WHERE oid='public.context_job_story_text_get_unstamped(uuid,jsonb,boolean)'::regprocedure)
 =(SELECT prosrc FROM pg_proc WHERE oid='public.context_job_story_text_get(uuid,jsonb,boolean)'::regprocedure),'unstamped copy is not the current read');

-- 2. Install refuses until the FU26.0 book is installed.
DO $c$ BEGIN
 BEGIN PERFORM public.install_job_story_stored_profit(); RAISE EXCEPTION 'installed over the main book';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'story_stored_profit_needs_fast_book_installed' THEN RAISE; END IF; END;
END $c$;
SELECT public.install_context_story_book_speed();

\ir ../20261118024514_context_story_book_speed/fixtures.sql
\ir ../20261029170000_cfo_bill_cost_outcomes/h7_fixtures.sql
CREATE TEMP TABLE sp_jobs AS SELECT id FROM public.jobs WHERE job_number LIKE 'TP13-%' OR job_number IN ('MB-1','MB-2') OR job_number LIKE 'H7-J%';
SELECT pg_temp.sp_assert((SELECT count(*)=27 FROM sp_jobs),'existing fixture cohort missing');
-- The front door as it answers with FU26.0 installed, before this install.
CREATE TEMP TABLE sp_before(job_id uuid,kind text,answer jsonb,PRIMARY KEY(job_id,kind));
INSERT INTO sp_before SELECT id,'book',public.context_job_story_book(id) FROM sp_jobs;
INSERT INTO sp_before SELECT id,'card',public.context_job_story_text_get(id,public.context_job_story(id,now()),true) FROM sp_jobs;
INSERT INTO sp_before SELECT id,'unchecked',public.context_job_story_text_get(id,NULL,false) FROM sp_jobs;
INSERT INTO sp_before SELECT id,'writer_card',public.context_job_story_text_get(id,public.context_job_story_writer_input(id)->'card',true) FROM sp_jobs;
CREATE FUNCTION pg_temp.sp_front(j uuid,kind text) RETURNS jsonb LANGUAGE sql AS $f$
 SELECT CASE kind WHEN 'book' THEN public.context_job_story_book(j)
  WHEN 'card' THEN public.context_job_story_text_get(j,public.context_job_story(j,now()),true)
  WHEN 'unchecked' THEN public.context_job_story_text_get(j,NULL,false)
  ELSE public.context_job_story_text_get(j,public.context_job_story_writer_input(j)->'card',true) END $f$;
-- Strip only the as-at field this change adds, wherever the answer carries it.
CREATE FUNCTION pg_temp.sp_strip(a jsonb) RETURNS jsonb LANGUAGE sql AS $f$
 SELECT CASE WHEN a ? 'money' AND jsonb_typeof(a->'money')='object' THEN a #- '{money,computed_at}' ELSE a-'computed_at' END $f$;

-- One transaction: now() is its start, earlier than every refresh stamp
-- (clock_timestamp). On live the read is a later transaction. Move each
-- refresh's stamps to just before now(), keeping their order and day.
CREATE FUNCTION pg_temp.sp_settle() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE top timestamptz; BEGIN
 SELECT greatest((SELECT max(computed_at) FROM public.job_profit_stored),(SELECT max(computed_at) FROM public.job_cost_events_stored),
  (SELECT max(computed_at) FROM public.job_revenue_events_stored)) INTO top;
 IF top<now() THEN RETURN; END IF;
 UPDATE public.job_profit_stored SET computed_at=now()-(top-computed_at)-interval '1 microsecond' WHERE computed_at>=now();
 UPDATE public.job_cost_events_stored SET computed_at=now()-(top-computed_at)-interval '1 microsecond' WHERE computed_at>=now();
 UPDATE public.job_revenue_events_stored SET computed_at=now()-(top-computed_at)-interval '1 microsecond' WHERE computed_at>=now();
END $f$;
SELECT public.install_job_story_stored_profit();
SELECT public.install_job_story_stored_profit();
SELECT pg_temp.sp_assert((SELECT prosrc FROM pg_proc WHERE oid='public.context_job_story_book(uuid,timestamptz)'::regprocedure)
 =(SELECT prosrc FROM pg_proc WHERE oid='public.context_job_story_book_switch(uuid,timestamptz)'::regprocedure),'install did not place the switch');
DO $c$ BEGIN
 BEGIN PERFORM public.remove_context_story_book_speed(); RAISE EXCEPTION 'FU26.0 remove ran under this install';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'story_book_remove_preimage_changed' THEN RAISE; END IF; END;
END $c$;

-- 3. Switch off, missing, or on with no usable snapshot: every answer equals
--    the installed book exactly, every field.
SELECT pg_temp.sp_assert(NOT EXISTS(SELECT 1 FROM sp_before b WHERE b.answer IS DISTINCT FROM pg_temp.sp_front(b.job_id,b.kind)),'switch off differs from installed book');
DELETE FROM public.feature_flags WHERE flag_name='job_story_stored_profit_v1';
SELECT pg_temp.sp_assert(NOT EXISTS(SELECT 1 FROM sp_before b WHERE b.kind='book' AND b.answer IS DISTINCT FROM pg_temp.sp_front(b.job_id,b.kind)),'missing switch differs');
INSERT INTO public.feature_flags(flag_name,enabled) VALUES('job_story_stored_profit_v1',true);
SELECT pg_temp.sp_assert(NOT EXISTS(SELECT 1 FROM sp_before b WHERE b.answer IS DISTINCT FROM pg_temp.sp_front(b.job_id,b.kind)),'switch on, refresh off, differs');
-- The profit refresh is installed as job_profit_refresh_install does (its
-- triggers; no pg_cron here) and switched on. Nothing stored yet.
-- Stand-in for job_profit_refresh_install (its pg_cron step is absent locally):
-- its own trigger statements, made idempotent, and its switch on.
DO $c$ DECLARE m text[]; BEGIN
 FOR m IN SELECT regexp_matches(prosrc,'(CREATE TRIGGER job_profit_changed[^;]+ ON (public\.[a-z_]+)[^;]+;)','g') FROM pg_proc WHERE oid='public.job_profit_refresh_install()'::regprocedure LOOP
  EXECUTE 'DROP TRIGGER IF EXISTS job_profit_changed ON '||m[2]; EXECUTE m[1];
 END LOOP;
END $c$;
SELECT pg_temp.sp_assert((SELECT count(*)=11 FROM pg_trigger WHERE tgname='job_profit_changed' AND tgenabled<>'D'),'refresh triggers not installed');
INSERT INTO public.feature_flags(flag_name,enabled) VALUES('job_profit_refresh_v1',true) ON CONFLICT(flag_name) DO UPDATE SET enabled=true;
DELETE FROM public.job_profit_change_events; DELETE FROM public.job_profit_dirty;
SELECT pg_temp.sp_assert(NOT EXISTS(SELECT 1 FROM sp_before b WHERE b.answer IS DISTINCT FROM pg_temp.sp_front(b.job_id,b.kind)),'missing stored rows differ');

-- 4. A complete refresh: the stored book equals the installed book in every
--    field (lines, digest, money_sig, facts) and adds only its as-at time.
SET LOCAL statement_timeout='120s';
SELECT public.job_profit_refresh_many(ARRAY(SELECT id FROM sp_jobs));
SELECT pg_temp.sp_settle();
DO $c$ DECLARE r record; got jsonb; BEGIN
 FOR r IN SELECT b.job_id,b.answer FROM sp_before b WHERE b.kind='book' LOOP
  got:=public.context_job_story_book(r.job_id);
  PERFORM pg_temp.sp_assert(got ? 'computed_at','stored snapshot not used for '||r.job_id);
  PERFORM pg_temp.sp_assert((got->>'computed_at')::timestamptz=(SELECT computed_at FROM public.job_profit_stored WHERE job_id=r.job_id),'as-at is not the summary stamp');
  PERFORM pg_temp.sp_assert(got-'computed_at'=r.answer,'stored book differs for '||r.job_id);
  PERFORM pg_temp.sp_assert(public.context_job_story_book_stored(r.job_id,now())=public.context_job_story_book_main(r.job_id,now()),'stored body differs from main for '||r.job_id);
 END LOOP;
END $c$;
-- Staff front door: same answer, and the money block carries the as-at time.
SELECT pg_temp.sp_assert(NOT EXISTS(SELECT 1 FROM sp_before b WHERE b.answer IS DISTINCT FROM pg_temp.sp_strip(pg_temp.sp_front(b.job_id,b.kind))),'stored front door differs');
SELECT pg_temp.sp_assert(NOT EXISTS(SELECT 1 FROM sp_before b WHERE b.kind IN ('card','unchecked') AND b.answer ? 'money' AND b.answer->'money'<>'null'::jsonb
 AND NOT (pg_temp.sp_front(b.job_id,b.kind)->'money') ? 'computed_at'),'staff money lacks as-at');
SELECT pg_temp.sp_assert(public.context_job_story_book(NULL) IS NULL AND public.context_job_story_book('00000000-0000-4000-8000-000000009999') IS NULL,'unknown job changed');

-- 5. Bad paths with the switch on: each falls back to the installed book's
--    current answer, with no as-at time; a retry after recovery uses the store.
CREATE FUNCTION pg_temp.sp_live(j uuid) RETURNS boolean LANGUAGE sql AS $f$
 SELECT NOT (public.context_job_story_book(j) ? 'computed_at') AND public.context_job_story_book(j)=public.context_job_story_book_fast(j) $f$;
CREATE TEMP TABLE sp_one AS SELECT id FROM public.jobs WHERE job_number='MB-1';
-- A real source write queues a change (not yet folded): live answer at once.
UPDATE public.job_materials_facts SET amount_ex_gst=amount_ex_gst+1 WHERE xero_invoice_id='MB-BILL-1';
SELECT pg_temp.sp_assert(EXISTS(SELECT 1 FROM public.job_profit_change_events q JOIN sp_one o ON o.id=q.job_id) AND NOT EXISTS(SELECT 1 FROM public.job_profit_dirty d JOIN sp_one o ON o.id=d.job_id),'fixture write did not queue');
SELECT pg_temp.sp_assert(public.context_job_story_book_stored(id,now())->>'digest' IS DISTINCT FROM public.context_job_story_book_fast(id)->>'digest','fixture write did not change money') FROM sp_one;
SELECT pg_temp.sp_assert(pg_temp.sp_live(id),'queued source change must fall back') FROM sp_one;
-- The timer folds and refreshes: the store answers again, with the new money.
SET LOCAL statement_timeout='120s';
SELECT public.job_profit_refresh_due();
SELECT pg_temp.sp_settle();
SELECT pg_temp.sp_assert(public.context_job_story_book(id) ? 'computed_at' AND public.context_job_story_book(id)-'computed_at'=public.context_job_story_book_fast(id),'refreshed change not used') FROM sp_one;
-- A dirty mark (office change caught by a mark) falls back until refreshed.
SELECT public.job_profit_mark(id,'office') FROM sp_one;
SELECT pg_temp.sp_assert(pg_temp.sp_live(id),'dirty mark must fall back') FROM sp_one;
SET LOCAL statement_timeout='120s';
SELECT public.job_profit_refresh(id) FROM sp_one;
SELECT pg_temp.sp_settle();
SELECT pg_temp.sp_assert(public.context_job_story_book(id) ? 'computed_at','retry after mark not served from store') FROM sp_one;
-- A previous-day snapshot (date holds move with the day) falls back.
UPDATE public.job_profit_stored s SET computed_at=s.computed_at-interval '1 day' FROM sp_one o WHERE s.job_id=o.id;
UPDATE public.job_cost_events_stored s SET computed_at=s.computed_at-interval '1 day' FROM sp_one o WHERE s.job_id=o.id;
UPDATE public.job_revenue_events_stored s SET computed_at=s.computed_at-interval '1 day' FROM sp_one o WHERE s.job_id=o.id;
SELECT pg_temp.sp_assert(pg_temp.sp_live(id),'previous-day snapshot must fall back') FROM sp_one;
SET LOCAL statement_timeout='120s';
SELECT public.job_profit_refresh(id) FROM sp_one;
SELECT pg_temp.sp_settle();
-- An event set stamped after the summary is not one snapshot: falls back.
UPDATE public.job_cost_events_stored s SET computed_at=clock_timestamp()+interval '1 second' FROM sp_one o WHERE s.job_id=o.id;
SELECT pg_temp.sp_assert(pg_temp.sp_live(id),'later event snapshot must fall back') FROM sp_one;
SET LOCAL statement_timeout='120s';
SELECT public.job_profit_refresh(id) FROM sp_one;
SELECT pg_temp.sp_settle();
SELECT pg_temp.sp_assert(public.context_job_story_book(id) ? 'computed_at','store not used after refresh') FROM sp_one;
-- The refresh switched off, or one source trigger missing: falls back.
UPDATE public.feature_flags SET enabled=false WHERE flag_name='job_profit_refresh_v1';
SELECT pg_temp.sp_assert(pg_temp.sp_live(id),'refresh off must fall back') FROM sp_one;
UPDATE public.feature_flags SET enabled=true WHERE flag_name='job_profit_refresh_v1';
SAVEPOINT trigger_gone;
DROP TRIGGER job_profit_changed ON public.work_orders;
SELECT pg_temp.sp_assert(pg_temp.sp_live(id),'missing source trigger must fall back') FROM sp_one;
ROLLBACK TO trigger_gone;
SELECT pg_temp.sp_assert(public.context_job_story_book(id) ? 'computed_at','store not used with triggers back') FROM sp_one;
-- A failed stored read falls back; the retry still falls back; after repair the store answers.
SAVEPOINT read_failure;
CREATE OR REPLACE FUNCTION public.context_job_story_book_stored(p_job_id uuid,p_as_of timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql STABLE AS $f$ BEGIN RAISE EXCEPTION 'injected stored read failure'; END $f$;
SELECT pg_temp.sp_assert(pg_temp.sp_live(id),'failed stored read must fall back') FROM sp_one;
SELECT pg_temp.sp_assert(pg_temp.sp_live(id),'retry after refusal must fall back') FROM sp_one;
ROLLBACK TO read_failure;
SELECT pg_temp.sp_assert(public.context_job_story_book(id) ? 'computed_at','retry after repair not served from store') FROM sp_one;
-- Switching off removes the as-at time, also from a cached stored book handed in.
CREATE TEMP TABLE sp_cached AS SELECT id,public.context_job_story_book(id) AS book FROM sp_one;
UPDATE public.feature_flags SET enabled=false WHERE flag_name='job_story_stored_profit_v1';
SELECT pg_temp.sp_assert(public.context_job_story_text_get(id,jsonb_build_object('job',jsonb_build_object('id',id),'book',book),false)
 =public.context_job_story_text_get_unstamped(id,jsonb_build_object('job',jsonb_build_object('id',id),'book',book),false),'off staff read differs on a cached stored book') FROM sp_cached;
SELECT pg_temp.sp_assert(pg_temp.sp_live(id),'switch off must not use the store') FROM sp_one;
UPDATE public.feature_flags SET enabled=true WHERE flag_name='job_story_stored_profit_v1';

-- 6. Rule 16: every new read is bounded by the job key. Dense unrelated rows.
SAVEPOINT plan_rows;
INSERT INTO public.job_profit_stored(job_id,computed_at) SELECT md5('sp-job-'||n)::uuid,now() FROM generate_series(1,10000) n;
INSERT INTO public.job_profit_dirty(job_id,reason) SELECT md5('sp-job-'||n)::uuid,'plan' FROM generate_series(1,10000) n;
INSERT INTO public.job_profit_change_events(job_id,reason) SELECT md5('sp-job-'||n)::uuid,'plan' FROM generate_series(1,10000) n;
INSERT INTO public.job_cost_events_stored(job_id,source,is_actual,amount_ex,computed_at) SELECT md5('sp-job-'||(n%10000))::uuid,'trade_line',true,1,now() FROM generate_series(1,20000) n;
INSERT INTO public.job_revenue_events_stored(job_id,counts_as_invoiced,amount_ex,computed_at) SELECT md5('sp-job-'||(n%10000))::uuid,true,1,now() FROM generate_series(1,20000) n;
ANALYZE public.job_profit_stored; ANALYZE public.job_profit_dirty; ANALYZE public.job_profit_change_events;
ANALYZE public.job_cost_events_stored; ANALYZE public.job_revenue_events_stored;
DO $plans$ DECLARE src text; q text; p jsonb; node jsonb; j text; BEGIN
 SELECT quote_literal(id)||'::uuid' INTO j FROM sp_one;
 SELECT prosrc INTO src FROM pg_proc WHERE oid='public.job_story_stored_profit_as_at(uuid,timestamptz)'::regprocedure;
 src:=regexp_replace(src,E'--[^\\n]*','','g');
 q:=substring(src FROM 'SELECT s\.computed_at INTO stamp(.*?);');
 PERFORM pg_temp.sp_assert(q IS NOT NULL,'freshness probe not found');
 FOREACH src IN ARRAY ARRAY['SELECT s.computed_at '||q,
   (SELECT 'SELECT * FROM ('||split_part(split_part(prosrc,'$fn$',1),';',1)||') x' FROM pg_proc WHERE oid='public.context_story_book_costs_stored(uuid)'::regprocedure)] LOOP
  src:=replace(replace(src,'p_job_id',j),'p_as_of','now()');
  EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON, TIMING OFF) '||src INTO p;
  PERFORM pg_temp.sp_assert(NOT jsonb_path_exists(p,'$.** ? (@."Node Type" == "Seq Scan")'),'sequential scan: '||p::text);
  PERFORM pg_temp.sp_assert(jsonb_path_exists(p,'$.** ? (@."Node Type" == "Index Scan" || @."Node Type" == "Index Only Scan" || @."Node Type" == "Bitmap Index Scan")'),'no index scan: '||p::text);
  FOR node IN SELECT value FROM jsonb_path_query(p,'$.** ? (exists(@."Relation Name"))') AS nodes(value) LOOP
   PERFORM pg_temp.sp_assert(coalesce((node->>'Actual Rows')::numeric,0)+coalesce((node->>'Rows Removed by Filter')::numeric,0)<=16,'read grew with company: '||node::text);
  END LOOP;
  RAISE NOTICE 'FU26.1 plan: %',p;
 END LOOP;
END $plans$;
ROLLBACK TO plan_rows;

-- 7. Remove restores FU26.0's book and the staff read exactly; FU26.0 then removes.
SELECT public.remove_job_story_stored_profit();
SELECT public.remove_job_story_stored_profit();
SELECT pg_temp.sp_assert((SELECT md5(prosrc)='af4fc8363060be37e1aec1046d933561' FROM pg_proc WHERE oid='public.context_job_story_book(uuid,timestamptz)'::regprocedure),'remove did not restore the installed book');
SELECT pg_temp.sp_assert((SELECT md5(prosrc)='ac51513f6164fa256011d67c1bd82b10' FROM pg_proc WHERE oid='public.context_job_story_text_get(uuid,jsonb,boolean)'::regprocedure),'remove did not restore the staff read');
SELECT public.remove_context_story_book_speed();
SELECT pg_temp.sp_assert((SELECT md5(prosrc)='fc9a1c8f605a1dfd6c7d1ef7667bfa0d' FROM pg_proc WHERE oid='public.context_job_story_book(uuid,timestamptz)'::regprocedure),'FU26.0 remove after this remove failed');
-- Re-apply while removed keeps the switch as it is and replaces no entry point.
\ir ../../../migrations/20261118065939_job_story_stored_profit.sql
SELECT pg_temp.sp_assert((SELECT md5(prosrc)='fc9a1c8f605a1dfd6c7d1ef7667bfa0d' FROM pg_proc WHERE oid='public.context_job_story_book(uuid,timestamptz)'::regprocedure),'re-apply touched the book');

-- 8. No browser role reaches any new door.
DO $c$ DECLARE f text; BEGIN
 FOREACH f IN ARRAY ARRAY['job_story_stored_profit_on()','job_story_stored_profit_as_at(uuid,timestamptz)','context_story_book_costs_stored(uuid)',
  'context_job_story_money_sig_stored(uuid)','context_job_story_book_stored(uuid,timestamptz)','context_job_story_book_switch(uuid,timestamptz)',
  'context_job_story_text_get_stamped(uuid,jsonb,boolean)','context_job_story_text_get_unstamped(uuid,jsonb,boolean)',
  'install_job_story_stored_profit()','remove_job_story_stored_profit()'] LOOP
  PERFORM pg_temp.sp_assert(NOT has_function_privilege('anon','public.'||f,'EXECUTE') AND NOT has_function_privilege('authenticated','public.'||f,'EXECUTE'),'browser privilege: '||f);
 END LOOP;
END $c$;
ROLLBACK;
\echo FU26.1 PASS: 27-fixture stored parity, front door, bad paths, install/remove, privileges, 2 indexed plans
