\set ON_ERROR_STOP on
BEGIN;
SET LOCAL jit=off;
SET LOCAL TimeZone='UTC';
SET LOCAL statement_timeout='120s';
-- Rule 17: the mark tables (an earlier job-page contract may run their
-- rollback), FU26.0, FU26.1, its follow-up and this case are re-applied first.
\ir ../../../migrations/20261117172503_job_pages_queue_safety.sql
\ir ../../../migrations/20261118024514_context_story_book_speed.sql
\ir ../../../migrations/20261118065939_job_story_stored_profit.sql
\ir ../../../migrations/20261118115531_job_story_stored_profit_guards.sql
\ir ../../../migrations/20261118153102_job_story_stored_profit_change_marks.sql
CREATE INDEX IF NOT EXISTS job_cost_events_stored_job_idx ON public.job_cost_events_stored(job_id);
CREATE INDEX IF NOT EXISTS job_revenue_events_stored_job_idx ON public.job_revenue_events_stored(job_id);
CREATE FUNCTION pg_temp.cm_assert(ok boolean,msg text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN IF ok IS NOT TRUE THEN RAISE EXCEPTION 'FU32 change marks: %',msg; END IF; END $f$;

-- 1. Merge replaces one private body and nothing else; the switch stays off.
SELECT pg_temp.cm_assert((SELECT md5(prosrc)='ea1bd9b50d9191e704653525370d74e3' FROM pg_proc WHERE oid='public.job_story_stored_profit_as_at(uuid,timestamptz)'::regprocedure),'new freshness body not in place');
SELECT pg_temp.cm_assert((SELECT md5(prosrc)='fc9a1c8f605a1dfd6c7d1ef7667bfa0d' FROM pg_proc WHERE oid='public.context_job_story_book(uuid,timestamptz)'::regprocedure),'merge changed the book');
SELECT pg_temp.cm_assert((SELECT md5(prosrc)='ac51513f6164fa256011d67c1bd82b10' FROM pg_proc WHERE oid='public.context_job_story_text_get(uuid,jsonb,boolean)'::regprocedure),'merge changed the staff read');
SELECT pg_temp.cm_assert((SELECT md5(prosrc)='a712ec6772216f23eb8791e1d9cefb7d' FROM pg_proc WHERE oid='public.context_job_story_text_get_stamped(uuid,jsonb,boolean)'::regprocedure)
 AND (SELECT md5(prosrc)='48ddebb7caa8539699d770b5eca774b7' FROM pg_proc WHERE oid='public.install_job_story_stored_profit()'::regprocedure)
 AND (SELECT md5(prosrc)='404751117e0e76af73d0b32e0388ded1' FROM pg_proc WHERE oid='public.remove_job_story_stored_profit()'::regprocedure)
 AND (SELECT md5(prosrc)='a4535d4e67f1a8bd261e81c83b8532c8' FROM pg_proc WHERE oid='public.context_job_story_book_switch(uuid,timestamptz)'::regprocedure),'merge changed another story body');
SELECT pg_temp.cm_assert((SELECT NOT enabled FROM public.feature_flags WHERE flag_name='job_story_stored_profit_v1'),'switch not off');
SELECT pg_temp.cm_assert(NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname IN ('job_story_stored_profit_rearm','job_story_stored_profit_counts')),'merge created a trigger');

-- 2. The store set up as the director does: FU26.0 installed, the profit
--    refresh's 11 source triggers (stand-in for job_profit_refresh_install,
--    whose pg_cron step is absent locally: its own trigger statements), the
--    refresh switch on, FU26.1 installed and armed, the story switch on.
SELECT public.install_context_story_book_speed();
\ir ../20261118024514_context_story_book_speed/fixtures.sql
CREATE TEMP TABLE cm_one AS SELECT id FROM public.jobs WHERE job_number='MB-1';
CREATE TEMP TABLE cm_two AS SELECT id FROM public.jobs WHERE job_number='MB-2';
SELECT pg_temp.cm_assert((SELECT count(*)=1 FROM cm_one) AND (SELECT count(*)=1 FROM cm_two),'fixture jobs missing');
DO $c$ DECLARE m text[]; BEGIN
 FOR m IN SELECT regexp_matches(prosrc,'(CREATE TRIGGER job_profit_changed[^;]+ ON (public\.[a-z_]+)[^;]+;)','g') FROM pg_proc WHERE oid='public.job_profit_refresh_install()'::regprocedure LOOP
  EXECUTE 'DROP TRIGGER IF EXISTS job_profit_changed ON '||m[2]; EXECUTE m[1];
 END LOOP;
END $c$;
SELECT pg_temp.cm_assert((SELECT count(*)=11 FROM pg_trigger WHERE tgname='job_profit_changed' AND tgenabled IN ('O','A')),'refresh triggers not installed');
INSERT INTO public.feature_flags(flag_name,enabled) VALUES('job_profit_refresh_v1',true) ON CONFLICT(flag_name) DO UPDATE SET enabled=true;
SELECT public.install_job_story_stored_profit();
INSERT INTO public.feature_flags(flag_name,enabled) VALUES('job_story_stored_profit_v1',true) ON CONFLICT(flag_name) DO UPDATE SET enabled=true;
DELETE FROM public.job_profit_change_events; DELETE FROM public.job_profit_dirty;
-- Marks left by earlier work in this transaction are moved to before it.
UPDATE public.job_change_mark_events SET marked_at=now()-interval '1 hour' WHERE marked_at>=now()-interval '1 hour';
UPDATE public.job_change_marks_base SET last_marked_at=now()-interval '1 hour' WHERE last_marked_at>=now()-interval '1 hour';

-- One transaction: now() is its start. As in the follow-up's contract, move
-- the refresh stamps and the arm stamp to just before now(), keeping order and
-- day. The refresh's own start (counts.refresh_started_at) is now().
CREATE FUNCTION pg_temp.cm_settle() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE top timestamptz; BEGIN
 SELECT greatest((SELECT max(computed_at) FROM public.job_profit_stored),(SELECT max(computed_at) FROM public.job_cost_events_stored),
  (SELECT max(computed_at) FROM public.job_revenue_events_stored),(SELECT max(armed_at) FROM public.job_story_stored_profit_arm)) INTO top;
 IF top<now() THEN RETURN; END IF;
 UPDATE public.job_cost_events_stored SET computed_at=now()-(top-computed_at)-interval '1 microsecond' WHERE computed_at>=now();
 UPDATE public.job_revenue_events_stored SET computed_at=now()-(top-computed_at)-interval '1 microsecond' WHERE computed_at>=now();
 UPDATE public.job_profit_stored SET computed_at=now()-(top-computed_at)-interval '1 microsecond' WHERE computed_at>=now();
 UPDATE public.job_story_stored_profit_arm SET armed_at=now()-(top-armed_at)-interval '1 microsecond' WHERE armed_at>=now();
END $f$;
-- The live answer exactly, with no as-at time.
CREATE FUNCTION pg_temp.cm_live(j uuid) RETURNS boolean LANGUAGE sql AS $f$
 SELECT NOT (public.context_job_story_book(j) ? 'computed_at') AND public.context_job_story_book(j)=public.context_job_story_book_fast(j)
  AND NOT coalesce((public.context_job_story_text_get(j,NULL,false)->'money') ? 'computed_at',false) $f$;
-- The stored answer: the live book's every field plus the summary's as-at time.
CREATE FUNCTION pg_temp.cm_stored(j uuid) RETURNS boolean LANGUAGE sql AS $f$
 SELECT public.context_job_story_book(j) ? 'computed_at'
  AND (public.context_job_story_book(j)->>'computed_at')::timestamptz=(SELECT computed_at FROM public.job_profit_stored WHERE job_id=j)
  AND public.context_job_story_book(j)-'computed_at'=public.context_job_story_book_fast(j) $f$;

-- 3. A refresh that changes the figures writes its own 'profit' mark after
--    its stamp. That mark, and a bulk mark, never make the snapshot stale.
SET LOCAL statement_timeout='120s';
SELECT public.job_profit_refresh_many(ARRAY(SELECT id FROM cm_one UNION ALL SELECT id FROM cm_two));
SELECT pg_temp.cm_settle();
SELECT pg_temp.cm_assert(EXISTS(SELECT 1 FROM public.job_change_mark_events e JOIN cm_one o ON o.id=e.job_id WHERE e.source='profit'
 AND e.marked_at>(SELECT k.refresh_started_at FROM public.job_story_stored_profit_counts k JOIN cm_one o2 ON o2.id=k.job_id)),'refresh wrote no profit mark after its start');
SELECT pg_temp.cm_assert(pg_temp.cm_stored(id),'own profit mark made the store stale') FROM cm_one;
SELECT public.job_mark_changed(id,'bulk') FROM cm_one;
SELECT pg_temp.cm_assert(pg_temp.cm_stored(id),'bulk mark made the store stale') FROM cm_one;
SELECT pg_temp.cm_assert(public.context_job_story_book_stored(id,now())->>'digest'=public.context_job_story_book_fast(id)->>'digest','stored digest differs from live') FROM cm_one;
SELECT pg_temp.cm_assert((public.context_job_story_text_get(id,NULL,false)->'money') ? 'computed_at','staff money lacks the as-at time') FROM cm_one;

-- 4. A real change mark after the refresh began (a 10:00 payment against a
--    01:08 snapshot), with nothing queued or dirty: the live book, exactly.
SAVEPOINT real_mark;
SELECT public.job_mark_changed(id,'payment') FROM cm_one;
SELECT pg_temp.cm_assert(NOT EXISTS(SELECT 1 FROM public.job_profit_change_events q JOIN cm_one o ON o.id=q.job_id)
 AND NOT EXISTS(SELECT 1 FROM public.job_profit_dirty d JOIN cm_one o ON o.id=d.job_id),'mark queued a profit change');
SELECT pg_temp.cm_assert(public.job_story_stored_profit_as_at(id,now()) IS NULL,'newer real mark still gave an as-at time') FROM cm_one;
SELECT pg_temp.cm_assert(pg_temp.cm_live(id),'newer real mark must fall back to the live book') FROM cm_one;
SELECT pg_temp.cm_assert(pg_temp.cm_live(id),'retry must still fall back') FROM cm_one;
-- Another job's mark does not touch this one.
SELECT pg_temp.cm_assert(pg_temp.cm_stored(id),'one job''s mark made another job stale') FROM cm_two;
-- The same mark dated before the refresh began: the snapshot covers it.
UPDATE public.job_change_mark_events e SET marked_at=now()-interval '1 second' FROM cm_one o WHERE e.job_id=o.id AND e.source='payment';
SELECT pg_temp.cm_assert(pg_temp.cm_stored(id),'older real mark made the store stale') FROM cm_one;
ROLLBACK TO real_mark;
-- Every real source the job-page triggers write counts; unknown ones too.
DO $c$ DECLARE src text; j uuid; BEGIN
 SELECT id INTO j FROM cm_one;
 FOREACH src IN ARRAY ARRAY['invoice','payment','bill','status','order','work_order','crew_line','signoff','document','booking','notes','message','unknown'] LOOP
  /* each */ BEGIN
   PERFORM public.job_mark_changed(j,src);
   PERFORM pg_temp.cm_assert(public.job_story_stored_profit_as_at(j,now()) IS NULL,'mark source '||src||' did not count');
   RAISE EXCEPTION USING ERRCODE='P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
 END LOOP;
END $c$;
SELECT pg_temp.cm_assert(pg_temp.cm_stored(id),'store not used once the marks are gone') FROM cm_one;

-- 5. A folded mark keeps no source: newer than the refresh start it counts
--    (fail closed); older it does not.
SAVEPOINT folded;
INSERT INTO public.job_change_marks_base(job_id,last_marked_at,first_marked_at,sources,page_pending)
SELECT id,clock_timestamp(),clock_timestamp(),'{}',false FROM cm_one
ON CONFLICT(job_id) DO UPDATE SET last_marked_at=EXCLUDED.last_marked_at;
SELECT pg_temp.cm_assert(pg_temp.cm_live(id),'newer folded mark must fall back') FROM cm_one;
UPDATE public.job_change_marks_base b SET last_marked_at=now()-interval '1 second' FROM cm_one o WHERE b.job_id=o.id;
SELECT pg_temp.cm_assert(pg_temp.cm_stored(id),'older folded mark made the store stale') FROM cm_one;
ROLLBACK TO folded;

-- 6. The earlier refusals still hold beside the new one: a queued source
--    change (a bill edit) and a dirty row each fall back.
SAVEPOINT earlier;
UPDATE public.job_materials_facts SET amount_ex_gst=amount_ex_gst+1 WHERE xero_invoice_id='MB-BILL-1';
SELECT pg_temp.cm_assert(EXISTS(SELECT 1 FROM public.job_profit_change_events q JOIN cm_one o ON o.id=q.job_id),'bill edit did not queue');
SELECT pg_temp.cm_assert(pg_temp.cm_live(id),'queued bill edit must fall back') FROM cm_one;
ROLLBACK TO earlier;
SAVEPOINT earlier;
SELECT public.job_profit_mark(id,'office') FROM cm_one;
SELECT pg_temp.cm_assert(pg_temp.cm_live(id),'dirty row must fall back') FROM cm_one;
ROLLBACK TO earlier;

-- 7. Switch off: the installed book exactly, whatever the marks say.
UPDATE public.feature_flags SET enabled=false WHERE flag_name='job_story_stored_profit_v1';
SELECT pg_temp.cm_assert(pg_temp.cm_live(id),'switch off must not use the store') FROM cm_one;
UPDATE public.feature_flags SET enabled=true WHERE flag_name='job_story_stored_profit_v1';
-- A mark table that cannot be read refuses (the wrapper serves the live book).
SAVEPOINT unreadable;
ALTER TABLE public.job_change_mark_events RENAME TO job_change_mark_events_gone;
SELECT pg_temp.cm_assert(pg_temp.cm_live(id),'unreadable marks must fall back') FROM cm_one;
ROLLBACK TO unreadable;
SELECT pg_temp.cm_assert(pg_temp.cm_stored(id),'store not used after the read is back') FROM cm_one;

-- 8. Rule 16: each mark probe reads by the job key. Dense unrelated marks.
SAVEPOINT plan_rows;
INSERT INTO public.job_change_mark_events(job_id,source,marked_at,page_pending)
 SELECT md5('cm-job-'||(n%10000))::uuid,'status',clock_timestamp(),(n%2=0) FROM generate_series(1,20000) n;
-- Unrelated folded rows need no job row here: the job key is dropped inside this savepoint only.
DO $c$ DECLARE c text; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='public.job_change_marks_base'::regclass AND contype='f' LOOP
  EXECUTE format('ALTER TABLE public.job_change_marks_base DROP CONSTRAINT %I',c); END LOOP;
END $c$;
INSERT INTO public.job_change_marks_base(job_id,last_marked_at,first_marked_at,sources,page_pending)
 SELECT md5('cm-base-'||n)::uuid,clock_timestamp(),clock_timestamp(),'{}',false FROM generate_series(1,10000) n
 ON CONFLICT(job_id) DO NOTHING;
ANALYZE public.job_change_mark_events; ANALYZE public.job_change_marks_base;
DO $plans$ DECLARE src text; q text; p jsonb; node jsonb; j text; BEGIN
 SELECT quote_literal(id)||'::uuid' INTO j FROM cm_one;
 SELECT prosrc INTO src FROM pg_proc WHERE oid='public.job_story_stored_profit_as_at(uuid,timestamptz)'::regprocedure;
 src:=regexp_replace(src,E'--[^\\n]*','','g');
 FOREACH q IN ARRAY ARRAY[
   substring(src FROM '(SELECT 1 FROM public\.job_change_mark_events m WHERE .*?k\.refresh_started_at)'),
   substring(src FROM '(SELECT 1 FROM public\.job_change_marks_base b WHERE .*?k\.refresh_started_at)')] LOOP
  PERFORM pg_temp.cm_assert(q IS NOT NULL,'mark probe not found');
  q:=replace(replace(q,'p_job_id',j),'k.refresh_started_at',$q$(now()-interval '1 day')$q$);
  EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON, TIMING OFF) '||q INTO p;
  PERFORM pg_temp.cm_assert(NOT jsonb_path_exists(p,'$.** ? (@."Node Type" == "Seq Scan")'),'sequential scan: '||p::text);
  PERFORM pg_temp.cm_assert(jsonb_path_exists(p,'$.** ? (@."Node Type" == "Index Scan" || @."Node Type" == "Index Only Scan" || @."Node Type" == "Bitmap Index Scan")'),'no index scan: '||p::text);
  FOR node IN SELECT value FROM jsonb_path_query(p,'$.** ? (exists(@."Relation Name"))') AS nodes(value) LOOP
   PERFORM pg_temp.cm_assert(coalesce((node->>'Actual Rows')::numeric,0)+coalesce((node->>'Rows Removed by Filter')::numeric,0)<=16,'read grew with company: '||node::text);
  END LOOP;
  RAISE NOTICE 'FU32 change marks plan: %',p;
 END LOOP;
END $plans$;
ROLLBACK TO plan_rows;

-- 9. Re-apply keeps this body; no browser role reaches it.
\ir ../../../migrations/20261118153102_job_story_stored_profit_change_marks.sql
SELECT pg_temp.cm_assert((SELECT md5(prosrc)='ea1bd9b50d9191e704653525370d74e3' FROM pg_proc WHERE oid='public.job_story_stored_profit_as_at(uuid,timestamptz)'::regprocedure),'re-apply changed the body');
SELECT pg_temp.cm_assert(NOT has_function_privilege('anon','public.job_story_stored_profit_as_at(uuid,timestamptz)','EXECUTE')
 AND NOT has_function_privilege('authenticated','public.job_story_stored_profit_as_at(uuid,timestamptz)','EXECUTE'),'browser privilege');
-- A different body in the slot refuses the migration.
DO $c$ BEGIN
 EXECUTE replace(pg_get_functiondef('public.job_story_stored_profit_as_at(uuid,timestamptz)'::regprocedure),'RETURN stamp;','RETURN  stamp;');
END $c$;
DO $c$ BEGIN
 BEGIN
  EXECUTE (SELECT string_agg(l,E'\n') FROM unnest(ARRAY[
   $s$DO $g$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.job_story_stored_profit_as_at(uuid,timestamptz)')) NOT IN ('48d8c171c00cb3015688a27abffd4800','ea1bd9b50d9191e704653525370d74e3') THEN RAISE EXCEPTION 'story_stored_profit_change_marks_preimage: job_story_stored_profit_as_at'; END IF; END $g$;$s$]) l);
  RAISE EXCEPTION 'changed body accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'story_stored_profit_change_marks_preimage: job_story_stored_profit_as_at' THEN RAISE; END IF;
 END;
END $c$;
ROLLBACK;
\echo FU32 change marks PASS: own profit and bulk marks keep the store, a newer real mark of every source falls back to the live book exactly, older and other-job marks do not, folded marks fail closed, earlier refusals kept, switch off, unreadable marks, 2 indexed plans, guard
