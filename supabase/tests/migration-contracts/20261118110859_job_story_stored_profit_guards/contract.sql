\set ON_ERROR_STOP on
BEGIN;
SET LOCAL jit=off;
SET LOCAL TimeZone='UTC';
SET LOCAL statement_timeout='120s';
-- Rule 17: FU26.0's and FU26.1's objects and this case's own are re-applied
-- first (FU26.1's re-apply restores its own bodies; this one replaces them).
\ir ../../../migrations/20261118024514_context_story_book_speed.sql
\ir ../../../migrations/20261118065939_job_story_stored_profit.sql
\ir ../../../migrations/20261118110859_job_story_stored_profit_guards.sql
-- Rule 17: an earlier contract in the shard may have rebuilt the stored tables.
-- These are the store's own job indexes (20261117195801), restored if missing.
CREATE INDEX IF NOT EXISTS job_cost_events_stored_job_idx ON public.job_cost_events_stored(job_id);
CREATE INDEX IF NOT EXISTS job_revenue_events_stored_job_idx ON public.job_revenue_events_stored(job_id);
CREATE FUNCTION pg_temp.sp_assert(ok boolean,msg text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN IF ok IS NOT TRUE THEN RAISE EXCEPTION 'FU26.1 follow-up: %',msg; END IF; END $f$;

-- 1. Merge changes no entry point and seeds the switch off.
SELECT pg_temp.sp_assert((SELECT md5(prosrc)='fc9a1c8f605a1dfd6c7d1ef7667bfa0d' FROM pg_proc WHERE oid='public.context_job_story_book(uuid,timestamptz)'::regprocedure),'merge changed the book');
SELECT pg_temp.sp_assert((SELECT md5(prosrc)='ac51513f6164fa256011d67c1bd82b10' FROM pg_proc WHERE oid='public.context_job_story_text_get(uuid,jsonb,boolean)'::regprocedure),'merge changed the staff read');
SELECT pg_temp.sp_assert((SELECT md5(prosrc)='7a7798901a26351b8e910da3f1392509' FROM pg_proc WHERE oid='public.context_job_story_money_sig(uuid)'::regprocedure),'merge changed the money signature');
SELECT pg_temp.sp_assert((SELECT NOT enabled FROM public.feature_flags WHERE flag_name='job_story_stored_profit_v1'),'switch not seeded off');
SELECT pg_temp.sp_assert((SELECT prosrc FROM pg_proc WHERE oid='public.context_job_story_text_get_unstamped(uuid,jsonb,boolean)'::regprocedure)
 =(SELECT prosrc FROM pg_proc WHERE oid='public.context_job_story_text_get(uuid,jsonb,boolean)'::regprocedure),'unstamped copy is not the current read');

SELECT pg_temp.sp_assert((SELECT md5(prosrc)='a712ec6772216f23eb8791e1d9cefb7d' FROM pg_proc WHERE oid='public.context_job_story_text_get_stamped(uuid,jsonb,boolean)'::regprocedure)
 AND (SELECT md5(prosrc)='48d8c171c00cb3015688a27abffd4800' FROM pg_proc WHERE oid='public.job_story_stored_profit_as_at(uuid,timestamptz)'::regprocedure)
 AND (SELECT md5(prosrc)='48ddebb7caa8539699d770b5eca774b7' FROM pg_proc WHERE oid='public.install_job_story_stored_profit()'::regprocedure)
 AND (SELECT md5(prosrc)='404751117e0e76af73d0b32e0388ded1' FROM pg_proc WHERE oid='public.remove_job_story_stored_profit()'::regprocedure),'follow-up bodies not in place');
SELECT pg_temp.sp_assert(NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname IN ('job_story_stored_profit_rearm','job_story_stored_profit_counts')),'merge created a trigger');
-- A different body in a replaced slot refuses the migration: preexisting-failure.sql.
-- FU26.1 installed before this migration: its live staff read moves to the
-- new stamped body, and the store answers nothing until install re-arms.
SAVEPOINT installed_before;
SELECT public.install_context_story_book_speed();
\ir ../../../migrations/20261118065939_job_story_stored_profit.sql
SELECT public.install_job_story_stored_profit();
SELECT pg_temp.sp_assert((SELECT md5(prosrc)='935cecb054f2ff9cc77e05df5e1a199a' FROM pg_proc WHERE oid='public.context_job_story_text_get(uuid,jsonb,boolean)'::regprocedure),'FU26.1 install not in place');
\ir ../../../migrations/20261118110859_job_story_stored_profit_guards.sql
SELECT pg_temp.sp_assert((SELECT md5(prosrc)='a712ec6772216f23eb8791e1d9cefb7d' FROM pg_proc WHERE oid='public.context_job_story_text_get(uuid,jsonb,boolean)'::regprocedure),'installed staff read did not move');
SELECT pg_temp.sp_assert(NOT EXISTS(SELECT 1 FROM public.job_story_stored_profit_arm),'store armed without install');
SELECT public.remove_job_story_stored_profit();
SELECT pg_temp.sp_assert((SELECT md5(prosrc)='ac51513f6164fa256011d67c1bd82b10' FROM pg_proc WHERE oid='public.context_job_story_text_get(uuid,jsonb,boolean)'::regprocedure),'remove after follow-up did not restore the staff read');
ROLLBACK TO installed_before;

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
-- refresh's stamps and the arm stamp to just before now(), keeping their
-- order and day (the counts trigger follows the summary's new stamp; the
-- refresh's start is now(), after the moved arm stamp).
CREATE FUNCTION pg_temp.sp_settle() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE top timestamptz; BEGIN
 SELECT greatest((SELECT max(computed_at) FROM public.job_profit_stored),(SELECT max(computed_at) FROM public.job_cost_events_stored),
  (SELECT max(computed_at) FROM public.job_revenue_events_stored),(SELECT max(armed_at) FROM public.job_story_stored_profit_arm)) INTO top;
 IF top<now() THEN RETURN; END IF;
 -- Events before the summary, as the refresh writes them: the counts trigger
 -- re-fingerprints on the summary's update and must see the moved events.
 UPDATE public.job_cost_events_stored SET computed_at=now()-(top-computed_at)-interval '1 microsecond' WHERE computed_at>=now();
 UPDATE public.job_revenue_events_stored SET computed_at=now()-(top-computed_at)-interval '1 microsecond' WHERE computed_at>=now();
 UPDATE public.job_profit_stored SET computed_at=now()-(top-computed_at)-interval '1 microsecond' WHERE computed_at>=now();
 UPDATE public.job_story_stored_profit_arm SET armed_at=now()-(top-armed_at)-interval '1 microsecond' WHERE armed_at>=now();
END $f$;
-- Rule 15: a changed stamped or switch helper is never copied.
SAVEPOINT tamper_before;
DO $c$ BEGIN
 EXECUTE replace(pg_get_functiondef('public.context_job_story_text_get_stamped(uuid,jsonb,boolean)'::regprocedure),$o$'job-story-text-v1'$o$,$o$'job-story-text-v1' $o$);
 BEGIN PERFORM public.install_job_story_stored_profit(); RAISE EXCEPTION 'installed a changed stamped helper';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'story_stored_profit_helper_changed' THEN RAISE; END IF; END;
END $c$;
ROLLBACK TO tamper_before;
SAVEPOINT tamper_before;
DO $c$ BEGIN
 EXECUTE replace(pg_get_functiondef('public.context_job_story_book_switch(uuid,timestamptz)'::regprocedure),'RETURN public.context_job_story_book_fast(','RETURN  public.context_job_story_book_fast(');
 BEGIN PERFORM public.install_job_story_stored_profit(); RAISE EXCEPTION 'installed a changed switch';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'story_stored_profit_helper_changed' THEN RAISE; END IF; END;
END $c$;
ROLLBACK TO tamper_before;
-- Arming waits on in-flight source writes: it holds SHARE (which conflicts
-- with a writer's ROW EXCLUSIVE) on all 11 source tables to its commit.
CREATE TEMP TABLE sp_src AS SELECT to_regclass('public.'||t) AS rel FROM unnest(ARRAY['job_materials_facts','trade_invoice_lines','trade_invoices','purchase_orders',
 'job_budgets','xero_invoices','xero_supplier_credit_note_allocations','jobs','work_orders','group_work_order_shares','group_work_orders']) t;
CREATE FUNCTION pg_temp.sp_share_locks() RETURNS bigint LANGUAGE sql AS $f$
 SELECT count(*) FROM pg_locks l JOIN sp_src s ON s.rel=l.relation
 WHERE l.locktype='relation' AND l.pid=pg_backend_pid() AND l.mode='ShareLock' AND l.granted $f$;
-- (The fixtures' own index builds already share-lock some; arming adds the rest.)
SAVEPOINT arm_locks;
SELECT pg_temp.sp_assert((SELECT count(rel)=11 FROM sp_src) AND pg_temp.sp_share_locks()<=2,'source tables already share-locked');
SELECT public.job_story_stored_profit_arm();
SELECT pg_temp.sp_assert(pg_temp.sp_share_locks()=11,'arming did not wait on in-flight source writes');
ROLLBACK TO arm_locks;
SELECT public.install_job_story_stored_profit();
SELECT pg_temp.sp_assert(pg_temp.sp_share_locks()=11,'install did not wait on in-flight source writes');
SELECT public.install_job_story_stored_profit();
SELECT pg_temp.sp_assert((SELECT prosrc FROM pg_proc WHERE oid='public.context_job_story_book(uuid,timestamptz)'::regprocedure)
 =(SELECT prosrc FROM pg_proc WHERE oid='public.context_job_story_book_switch(uuid,timestamptz)'::regprocedure),'install did not place the switch');
SAVEPOINT tamper_installed;
DO $c$ BEGIN
 EXECUTE replace(pg_get_functiondef('public.context_job_story_text_get_stamped(uuid,jsonb,boolean)'::regprocedure),$o$'job-story-text-v1'$o$,$o$'job-story-text-v1' $o$);
 BEGIN PERFORM public.install_job_story_stored_profit(); RAISE EXCEPTION 'idempotent install trusted a changed stamped helper';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'story_stored_profit_helper_changed' THEN RAISE; END IF; END;
 EXECUTE replace(pg_get_functiondef('public.context_job_story_text_get_unstamped(uuid,jsonb,boolean)'::regprocedure),$o$'job-story-text-v1'$o$,$o$'job-story-text-v1' $o$);
 BEGIN PERFORM public.remove_job_story_stored_profit(); RAISE EXCEPTION 'remove restored a changed unstamped helper';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'story_stored_profit_remove_source_changed' THEN RAISE; END IF; END;
END $c$;
ROLLBACK TO tamper_installed;
SAVEPOINT tamper_installed;
DO $c$ BEGIN
 EXECUTE replace(pg_get_functiondef('public.context_job_story_book_fast(uuid,timestamptz)'::regprocedure),'p_as_of','p_as_of ');
 BEGIN PERFORM public.remove_job_story_stored_profit(); RAISE EXCEPTION 'remove restored a changed fast book';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'story_stored_profit_remove_source_changed' THEN RAISE; END IF; END;
END $c$;
ROLLBACK TO tamper_installed;
DO $c$ BEGIN
 BEGIN PERFORM public.remove_context_story_book_speed(); RAISE EXCEPTION 'FU26.0 remove ran under this install';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'story_book_remove_preimage_changed' THEN RAISE; END IF; END;
END $c$;

-- 3. Switch off, missing, or on with no usable snapshot: every answer equals
--    the installed book exactly, every field.
SELECT pg_temp.sp_assert(NOT EXISTS(SELECT 1 FROM sp_before b WHERE b.answer IS DISTINCT FROM pg_temp.sp_front(b.job_id,b.kind)),'switch off differs from installed book');
DELETE FROM public.feature_flags WHERE flag_name='job_story_stored_profit_v1';
SELECT pg_temp.sp_assert(NOT EXISTS(SELECT 1 FROM sp_before b WHERE b.answer IS DISTINCT FROM pg_temp.sp_front(b.job_id,b.kind)),'missing switch differs');
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
SELECT pg_temp.sp_assert((SELECT count(*)=11 FROM pg_trigger WHERE tgname='job_profit_changed' AND tgenabled IN ('O','A')),'refresh triggers not installed');
SELECT pg_temp.sp_assert(public.job_story_stored_profit_setup() IS NOT NULL,'trigger set not seen');
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
-- A stored priced-order event removed after its refresh, summary and stamps
-- kept: the event set is not the one the refresh counted, so it falls back.
CREATE TEMP TABLE sp_po AS SELECT DISTINCT c.job_id AS id FROM public.job_cost_events_stored c JOIN sp_jobs j ON j.id=c.job_id WHERE c.source='po_committed' LIMIT 1;
SELECT pg_temp.sp_assert((SELECT count(*)=1 FROM sp_po),'no fixture job with a stored priced order');
SAVEPOINT event_gone;
DELETE FROM public.job_cost_events_stored c USING sp_po o WHERE c.ctid=(SELECT x.ctid FROM public.job_cost_events_stored x WHERE x.job_id=o.id AND x.source='po_committed' LIMIT 1);
SELECT pg_temp.sp_assert(NOT (public.context_job_story_book(id) ? 'computed_at') AND public.context_job_story_book(id)=public.context_job_story_book_fast(id),'missing stored event must fall back') FROM sp_po;
ROLLBACK TO event_gone;
SAVEPOINT event_gone;
UPDATE public.job_cost_events_stored c SET amount_ex=coalesce(c.amount_ex,0)+1 FROM sp_po o WHERE c.ctid=(SELECT x.ctid FROM public.job_cost_events_stored x WHERE x.job_id=o.id AND x.source='po_committed' LIMIT 1);
SELECT pg_temp.sp_assert(NOT (public.context_job_story_book(id) ? 'computed_at'),'changed stored amount must fall back') FROM sp_po;
ROLLBACK TO event_gone;
SAVEPOINT event_gone;
DELETE FROM public.job_story_stored_profit_counts k USING sp_po o WHERE k.job_id=o.id;
SELECT pg_temp.sp_assert(NOT (public.context_job_story_book(id) ? 'computed_at'),'uncounted refresh must fall back') FROM sp_po;
ROLLBACK TO event_gone;
SELECT pg_temp.sp_assert(public.context_job_story_book(id) ? 'computed_at','store not used with its events back') FROM sp_po;
-- An amount moved from one supplier's stored event to another's after the
-- refresh: same count and same sum, both supplier figures changed. The
-- fingerprint of every field of every row catches it.
CREATE TEMP TABLE sp_two AS SELECT c.job_id AS id,min(c.party) AS p1,max(c.party) AS p2 FROM public.job_cost_events_stored c JOIN sp_jobs j ON j.id=c.job_id
 WHERE c.amount_ex IS NOT NULL AND c.party IS NOT NULL AND c.source IN ('trade_line','po_committed')
 GROUP BY c.job_id HAVING count(DISTINCT c.party)>=2 ORDER BY c.job_id LIMIT 1;
SELECT pg_temp.sp_assert((SELECT count(*)=1 FROM sp_two),'no fixture job with two stored suppliers');
SELECT pg_temp.sp_assert(public.context_job_story_book(id) ? 'computed_at','store not used before the move') FROM sp_two;
CREATE TEMP TABLE sp_two_before AS SELECT count(*) n,sum(c.amount_ex) a FROM public.job_cost_events_stored c JOIN sp_two t ON t.id=c.job_id;
SAVEPOINT event_moved;
UPDATE public.job_cost_events_stored c SET amount_ex=c.amount_ex-1 FROM sp_two t WHERE c.ctid=(SELECT x.ctid FROM public.job_cost_events_stored x
 WHERE x.job_id=t.id AND x.party=t.p1 AND x.amount_ex IS NOT NULL AND x.source IN ('trade_line','po_committed') LIMIT 1);
UPDATE public.job_cost_events_stored c SET amount_ex=c.amount_ex+1 FROM sp_two t WHERE c.ctid=(SELECT x.ctid FROM public.job_cost_events_stored x
 WHERE x.job_id=t.id AND x.party=t.p2 AND x.amount_ex IS NOT NULL AND x.source IN ('trade_line','po_committed') LIMIT 1);
SELECT pg_temp.sp_assert((SELECT x.n=b.n AND x.a=b.a FROM (SELECT count(*) n,sum(c.amount_ex) a FROM public.job_cost_events_stored c JOIN sp_two t ON t.id=c.job_id) x,sp_two_before b),'move changed the count or the sum');
SELECT pg_temp.sp_assert(NOT (public.context_job_story_book(id) ? 'computed_at') AND public.context_job_story_book(id)=public.context_job_story_book_fast(id),'amount moved between suppliers must fall back') FROM sp_two;
ROLLBACK TO event_moved;
SELECT pg_temp.sp_assert(public.context_job_story_book(id) ? 'computed_at','store not used with the amounts back') FROM sp_two;

-- 5. Bad paths with the switch on: each falls back to the installed book's
--    current answer, with no as-at time; a retry after recovery uses the store.
CREATE FUNCTION pg_temp.sp_live(j uuid) RETURNS boolean LANGUAGE sql AS $f$
 SELECT NOT (public.context_job_story_book(j) ? 'computed_at') AND public.context_job_story_book(j)=public.context_job_story_book_fast(j) $f$;
CREATE TEMP TABLE sp_one AS SELECT id FROM public.jobs WHERE job_number='MB-1';
-- A writer card cached while the store answered (its book carries the as-at).
CREATE TEMP TABLE sp_wcard AS SELECT id,public.context_job_story_writer_input(id)->'card' AS card FROM sp_one;
SELECT pg_temp.sp_assert(card->'book' ? 'computed_at','writer card did not carry the stored book') FROM sp_wcard;
-- A real source write queues a change (not yet folded): live answer at once.
UPDATE public.job_materials_facts SET amount_ex_gst=amount_ex_gst+1 WHERE xero_invoice_id='MB-BILL-1';
SELECT pg_temp.sp_assert(EXISTS(SELECT 1 FROM public.job_profit_change_events q JOIN sp_one o ON o.id=q.job_id) AND NOT EXISTS(SELECT 1 FROM public.job_profit_dirty d JOIN sp_one o ON o.id=d.job_id),'fixture write did not queue');
SELECT pg_temp.sp_assert(public.context_job_story_book_stored(id,now())->>'digest' IS DISTINCT FROM public.context_job_story_book_fast(id)->>'digest','fixture write did not change money') FROM sp_one;
SELECT pg_temp.sp_assert(pg_temp.sp_live(id),'queued source change must fall back') FROM sp_one;
-- Switch on: no supplied book is reused, stored or fallback. The staff read
-- answers exactly as main's read does with the card's book left out (the
-- current book, with every edit so far).
CREATE FUNCTION pg_temp.sp_card_ok(j uuid,c jsonb) RETURNS boolean LANGUAGE sql AS $f$
 SELECT public.context_job_story_text_get(j,c,true)=public.context_job_story_text_get_unstamped(j,c-'book',true)
  AND public.context_job_story_text_get(j,c,false)=public.context_job_story_text_get_unstamped(j,c-'book',false)
  AND NOT (public.context_job_story_text_get(j,c,true)->'money') ? 'computed_at'
  AND public.context_job_story_text_get(j,c,true)->'money'->'lines'=public.context_job_story_book_fast(j)->'lines' $f$;
-- Switch off: the installed read's own behaviour, the card's book kept.
CREATE FUNCTION pg_temp.sp_card_off(j uuid,c jsonb) RETURNS boolean LANGUAGE sql AS $f$
 SELECT public.context_job_story_text_get(j,c,true)=public.context_job_story_text_get_unstamped(j,c,true)
  AND public.context_job_story_text_get(j,c,false)=public.context_job_story_text_get_unstamped(j,c,false)
  AND public.context_job_story_text_get(j,c,true)->'money'->'lines'=c->'book'->'lines' $f$;
SELECT pg_temp.sp_assert(card->'book'->'lines' IS DISTINCT FROM public.context_job_story_book_fast(id)->'lines','edit did not change the money lines') FROM sp_wcard;
SELECT pg_temp.sp_assert(pg_temp.sp_card_ok(id,card),'cached writer card served stale money') FROM sp_wcard;
-- A writer card cached while that edit waited: its book is the fallback book,
-- with no as-at time. A second bill edit changes the cost again.
CREATE TEMP TABLE sp_fcard AS SELECT id,public.context_job_story_writer_input(id)->'card' AS card FROM sp_one;
SELECT pg_temp.sp_assert(jsonb_typeof(card->'book')='object' AND NOT (card->'book' ? 'computed_at') AND card->'book'->'lines'=public.context_job_story_book_fast(id)->'lines','writer card did not carry the fallback book') FROM sp_fcard;
UPDATE public.job_materials_facts SET amount_ex_gst=amount_ex_gst+1 WHERE xero_invoice_id='MB-BILL-1';
SELECT pg_temp.sp_assert(card->'book'->'lines' IS DISTINCT FROM public.context_job_story_book_fast(id)->'lines','second edit did not change the money lines') FROM sp_fcard;
SELECT pg_temp.sp_assert(pg_temp.sp_card_ok(id,card),'cached fallback card served stale money') FROM sp_fcard;
UPDATE public.feature_flags SET enabled=false WHERE flag_name='job_story_stored_profit_v1';
SELECT pg_temp.sp_assert(pg_temp.sp_card_off(id,card),'switch off: stored card not read as the installed read does') FROM sp_wcard;
SELECT pg_temp.sp_assert(pg_temp.sp_card_off(id,card),'switch off: fallback card not read as the installed read does') FROM sp_fcard;
UPDATE public.feature_flags SET enabled=true WHERE flag_name='job_story_stored_profit_v1';
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
-- The refresh switched off: falls back. A bill edit while it is off is not
-- queued; switched back on the same day, the old snapshot must not answer
-- until a refresh after the re-activation.
UPDATE public.feature_flags SET enabled=false WHERE flag_name='job_profit_refresh_v1';
SELECT pg_temp.sp_assert(pg_temp.sp_live(id),'refresh off must fall back') FROM sp_one;
UPDATE public.job_materials_facts SET amount_ex_gst=amount_ex_gst+1 WHERE xero_invoice_id='MB-BILL-1';
SELECT pg_temp.sp_assert(NOT EXISTS(SELECT 1 FROM public.job_profit_change_events q JOIN sp_one o ON o.id=q.job_id) AND NOT EXISTS(SELECT 1 FROM public.job_profit_dirty d JOIN sp_one o ON o.id=d.job_id),'write while refresh off was queued');
UPDATE public.feature_flags SET enabled=true WHERE flag_name='job_profit_refresh_v1';
SELECT pg_temp.sp_assert(public.context_job_story_book_stored(id,now())->>'digest' IS DISTINCT FROM public.context_job_story_book_fast(id)->>'digest','edit while off did not change money') FROM sp_one;
SELECT pg_temp.sp_assert(pg_temp.sp_live(id),'re-activation without a refresh must fall back') FROM sp_one;
SET LOCAL statement_timeout='120s';
SELECT public.job_profit_refresh(id) FROM sp_one;
SELECT pg_temp.sp_settle();
SELECT pg_temp.sp_assert(public.context_job_story_book(id) ? 'computed_at' AND public.context_job_story_book(id)-'computed_at'=public.context_job_story_book_fast(id),'refresh after re-activation not used') FROM sp_one;
-- A refresh whose transaction began before the re-activation's arm may have
-- read before a write made while the refresh was off committed: it never
-- counts, even with its summary stamped after the arm.
SAVEPOINT early_refresh;
UPDATE public.job_story_stored_profit_counts k SET refresh_started_at=(SELECT a.armed_at FROM public.job_story_stored_profit_arm a)-interval '1 microsecond'
 FROM sp_one o WHERE k.job_id=o.id;
SELECT pg_temp.sp_assert((SELECT s.computed_at>a.armed_at FROM public.job_profit_stored s JOIN sp_one o ON o.id=s.job_id,public.job_story_stored_profit_arm a),'summary not after the arm');
SELECT pg_temp.sp_assert(pg_temp.sp_live(id),'refresh begun before the arm must fall back') FROM sp_one;
ROLLBACK TO early_refresh;
SELECT pg_temp.sp_assert(public.context_job_story_book(id) ? 'computed_at','store not used with the refresh start back') FROM sp_one;
-- A replica-only source trigger skips ordinary writes: falls back.
SAVEPOINT trigger_gone;
ALTER TABLE public.work_orders ENABLE REPLICA TRIGGER job_profit_changed;
SELECT pg_temp.sp_assert(pg_temp.sp_live(id),'replica-only source trigger must fall back') FROM sp_one;
-- Armed and refreshed while replica-only: still never counts.
SELECT public.install_job_story_stored_profit();
SET LOCAL statement_timeout='120s';
SELECT public.job_profit_refresh(id) FROM sp_one;
SELECT pg_temp.sp_settle();
SELECT pg_temp.sp_assert(pg_temp.sp_live(id),'armed with a replica-only trigger must fall back') FROM sp_one;
ROLLBACK TO trigger_gone;
-- One source trigger missing: falls back. Recreated, a refresh alone does not
-- count until the store is re-armed (install again), then refreshed.
SAVEPOINT trigger_gone;
DROP TRIGGER job_profit_changed ON public.work_orders;
SELECT pg_temp.sp_assert(pg_temp.sp_live(id),'missing source trigger must fall back') FROM sp_one;
CREATE TRIGGER job_profit_changed AFTER INSERT OR UPDATE OR DELETE ON public.work_orders FOR EACH ROW EXECUTE FUNCTION public.job_profit_work_orders_trg();
SELECT pg_temp.sp_assert(pg_temp.sp_live(id),'recreated source trigger must fall back') FROM sp_one;
SET LOCAL statement_timeout='120s';
SELECT public.job_profit_refresh(id) FROM sp_one;
SELECT pg_temp.sp_settle();
SELECT pg_temp.sp_assert(pg_temp.sp_live(id),'refresh before re-arm must fall back') FROM sp_one;
SELECT public.install_job_story_stored_profit();
SELECT pg_temp.sp_assert(pg_temp.sp_live(id),'snapshot before re-arm must fall back') FROM sp_one;
SET LOCAL statement_timeout='120s';
SELECT public.job_profit_refresh(id) FROM sp_one;
SELECT pg_temp.sp_settle();
SELECT pg_temp.sp_assert(public.context_job_story_book(id) ? 'computed_at','refresh after re-arm not used') FROM sp_one;
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
ANALYZE public.job_cost_events_stored; ANALYZE public.job_revenue_events_stored; ANALYZE public.job_story_stored_profit_counts;
SELECT pg_temp.sp_assert((SELECT count(*)>=10000 FROM public.job_story_stored_profit_counts),'counts trigger did not count the dense rows');
DO $plans$ DECLARE src text; q text; p jsonb; node jsonb; j text; BEGIN
 SELECT quote_literal(id)||'::uuid' INTO j FROM sp_one;
 SELECT prosrc INTO src FROM pg_proc WHERE oid='public.job_story_stored_profit_as_at(uuid,timestamptz)'::regprocedure;
 src:=regexp_replace(src,E'--[^\\n]*','','g');
 q:=substring(src FROM 'SELECT s\.computed_at INTO stamp(.*?);');
 PERFORM pg_temp.sp_assert(q IS NOT NULL,'freshness probe not found');
 FOREACH src IN ARRAY ARRAY['SELECT s.computed_at '||q,
   (SELECT 'SELECT * FROM ('||split_part(split_part(prosrc,'$fn$',1),';',1)||') x' FROM pg_proc WHERE oid='public.context_story_book_costs_stored(uuid)'::regprocedure)] LOOP
  src:=replace(replace(replace(src,'p_job_id',j),'p_as_of','now()'),'v_armed_at',$q$'-infinity'::timestamptz$q$);
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
SELECT pg_temp.sp_assert(NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname IN ('job_story_stored_profit_rearm','job_story_stored_profit_counts'))
 AND NOT EXISTS(SELECT 1 FROM public.job_story_stored_profit_arm) AND NOT EXISTS(SELECT 1 FROM public.job_story_stored_profit_counts),'remove left its triggers, stamp or counts');
SELECT public.remove_context_story_book_speed();
SELECT pg_temp.sp_assert((SELECT md5(prosrc)='fc9a1c8f605a1dfd6c7d1ef7667bfa0d' FROM pg_proc WHERE oid='public.context_job_story_book(uuid,timestamptz)'::regprocedure),'FU26.0 remove after this remove failed');
-- Re-apply while removed keeps the switch as it is and replaces no entry point.
\ir ../../../migrations/20261118065939_job_story_stored_profit.sql
\ir ../../../migrations/20261118110859_job_story_stored_profit_guards.sql
SELECT pg_temp.sp_assert((SELECT md5(prosrc)='fc9a1c8f605a1dfd6c7d1ef7667bfa0d' FROM pg_proc WHERE oid='public.context_job_story_book(uuid,timestamptz)'::regprocedure),'re-apply touched the book');

-- 8. No browser role reaches any new door.
DO $c$ DECLARE f text; BEGIN
 FOREACH f IN ARRAY ARRAY['job_story_stored_profit_on()','job_story_stored_profit_as_at(uuid,timestamptz)','context_story_book_costs_stored(uuid)',
  'context_job_story_money_sig_stored(uuid)','context_job_story_book_stored(uuid,timestamptz)','context_job_story_book_switch(uuid,timestamptz)',
  'context_job_story_text_get_stamped(uuid,jsonb,boolean)','context_job_story_text_get_unstamped(uuid,jsonb,boolean)',
  'install_job_story_stored_profit()','remove_job_story_stored_profit()','job_story_stored_profit_setup()','job_story_stored_profit_arm()',
  'job_story_stored_profit_rearm_trg()','job_story_stored_profit_count_trg()'] LOOP
  PERFORM pg_temp.sp_assert(NOT has_function_privilege('anon','public.'||f,'EXECUTE') AND NOT has_function_privilege('authenticated','public.'||f,'EXECUTE'),'browser privilege: '||f);
 END LOOP;
END $c$;
SELECT pg_temp.sp_assert(NOT has_table_privilege('anon','public.job_story_stored_profit_arm','SELECT') AND NOT has_table_privilege('authenticated','public.job_story_stored_profit_counts','SELECT'),'browser privilege: new tables');
ROLLBACK;
\echo FU26.1 follow-up PASS: 27-fixture stored parity, front door, stale stored and fallback cards (switch on and off), re-activation (arm locks, refresh begun before arm), replica/recreated triggers, missing and moved events, Rule 15 pins, install/remove, privileges, 2 indexed plans
