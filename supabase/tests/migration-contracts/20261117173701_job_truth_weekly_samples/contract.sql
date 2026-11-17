-- P4-10.1: a kept random sample, validated human reads and independent scores.
BEGIN;
CREATE TEMP TABLE weekly_fixture AS
 SELECT ('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid AS id,n
 FROM generate_series(401,435) n;
INSERT INTO public.organisations(id,name) VALUES ('00000000-0000-4000-8000-000000000401','Organisation')
 ON CONFLICT (id) DO NOTHING;
INSERT INTO public.users(id,org_id,name,role) VALUES
 ('00000000-0000-4000-8000-000000003701','00000000-0000-4000-8000-000000000401','Office','ops_manager'),
 ('00000000-0000-4000-8000-000000003702','00000000-0000-4000-8000-000000000401','Trade','installer');
INSERT INTO public.jobs(id,org_id,job_number,type,status)
 SELECT id,'00000000-0000-4000-8000-000000000401','ZZTEST-' || n,'fencing','accepted' FROM weekly_fixture;
-- The draw must refuse ZZTEST. Rename only these 30 disposable rows within this
-- transaction to exercise the real draw predicate; no business rows are present.
UPDATE public.jobs SET job_number='SWTEST-' || f.n FROM weekly_fixture f WHERE jobs.id=f.id AND f.n<=430;
-- job_change_marks is the canonical read view over append-only mark events.
INSERT INTO public.job_change_mark_events(job_id,marked_at,source)
 SELECT id,CASE WHEN n=432 THEN now()-interval '29 days' ELSE now() END,'weekly-fixture' FROM weekly_fixture;
INSERT INTO public.job_pages(job_id,page,built_at,build_ms,status)
 SELECT id,'{}',now(),0,CASE WHEN n=433 THEN 'failed' ELSE 'ready' END FROM weekly_fixture;
-- Stand-ins isolate weekly snapshot custody from expensive story construction.
CREATE OR REPLACE FUNCTION public.job_pages_keep_ready_set() RETURNS SETOF uuid
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT id FROM pg_temp.weekly_fixture WHERE n<>434
$$;
CREATE OR REPLACE FUNCTION public.job_page_refresh(p_job_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE sections jsonb; BEGIN
 sections := jsonb_build_object('headline',(SELECT string_agg('Sentence ' || n || '.',' ' ORDER BY n) FROM generate_series(1,20) n));
 UPDATE public.job_pages SET page=jsonb_build_object('as_at',now(),'story_text',jsonb_build_object('text',jsonb_build_object('sections',sections)))
 WHERE job_id=p_job_id;
 RETURN '{"outcome":"built"}'::jsonb;
END $$;
INSERT INTO public.context_ledger_generations(id,job_id,kind,status,reader,promoted_at)
 SELECT id,id,'rebuild','live','weekly-fixture',now() FROM weekly_fixture;
INSERT INTO public.context_ledger_items(generation_id,job_id,item_key,item_type,status,from_role,what,opened_at,opened_by,written_by)
 SELECT f.id,f.id,'note:' || notes.n,'claim','open','unknown','Note ' || notes.n,now(),'[{"table":"job_events","id":"fixture","excerpt":"Note"}]','model:fixture'
 FROM weekly_fixture f CROSS JOIN generate_series(1,10) AS notes(n);

DO $c$
DECLARE r jsonb; split jsonb; BEGIN
 r := public.job_truth_weekly_draw('2026-11-16',20);
 IF r->>'jobs' <> '20' OR (SELECT count(*) FROM public.job_truth_weekly_samples WHERE week='2026-11-16')<>20
   OR (SELECT count(DISTINCT job_id) FROM public.job_truth_weekly_samples WHERE week='2026-11-16')<>20 THEN
   RAISE EXCEPTION 'weekly draw must keep exactly 20 different jobs';
 END IF;
 IF EXISTS (SELECT 1 FROM public.job_truth_weekly_samples s JOIN public.jobs j ON j.id=s.job_id WHERE j.job_number LIKE 'ZZTEST%') THEN
   RAISE EXCEPTION 'weekly draw included a ZZTEST job';
 END IF;
 IF EXISTS (SELECT 1 FROM public.job_truth_weekly_samples WHERE story_total<>20 OR notes_total<>10
   OR page #> '{story_text,text,sections}' IS NULL) THEN RAISE EXCEPTION 'weekly draw lost refreshed page or notes'; END IF;
 IF public.job_truth_weekly_draw('2026-11-16',20)->>'outcome'<>'already_drawn' THEN RAISE EXCEPTION 'weekly draw repeated a week'; END IF;
 IF public.job_truth_weekly_draw('2026-11-23',15)->>'jobs'<>'15' THEN RAISE EXCEPTION 'weekly first sample must draw 15'; END IF;
 BEGIN PERFORM public.job_truth_weekly_draw('2026-11-30',4); RAISE EXCEPTION 'bad limit accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'weekly_draw_bad_limit' THEN RAISE; END IF; END;
 BEGIN PERFORM public.job_truth_weekly_draw('2026-11-30',21); RAISE EXCEPTION 'bad limit accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'weekly_draw_bad_limit' THEN RAISE; END IF; END;
 split := public.job_truth_story_sentences(jsonb_build_object('where_it_is_at','Quote sent Tue 3 Nov. It is the customer''s move.'));
 IF jsonb_array_length(split)<>2 OR split->0->>'ref'<>'where_it_is_at:1' OR split->1->>'ref'<>'where_it_is_at:2' THEN
   RAISE EXCEPTION 'weekly sentences lost their ordered refs'; END IF;
 IF public.job_truth_story_sentences(NULL)<>'[]' OR public.job_truth_story_sentences('{}')<>'[]'
   OR public.job_truth_notes_of(NULL)<>'[]' THEN RAISE EXCEPTION 'weekly empty input must stay empty'; END IF;
END $c$;

-- Candidate story and generation validation leave the kept page unchanged.
DO $c$
DECLARE j uuid; other_j uuid; r jsonb; old_page jsonb; BEGIN
 SELECT job_id,page INTO j,old_page FROM public.job_truth_weekly_samples WHERE week='2026-11-23' ORDER BY job_id LIMIT 1;
 SELECT id INTO other_j FROM weekly_fixture WHERE id<>j LIMIT 1;
 r := public.job_truth_weekly_set_candidate('2026-11-23',j,
   '{"headline":"Ready.","the_job":"Work agreed.","how_we_got_here":"Quote sent.","where_it_is_at":"Visit arranged.","watch_out":"Access needed."}',j);
 IF r->>'story_total'<>'5' OR NOT EXISTS (SELECT 1 FROM public.job_truth_weekly_samples
   WHERE week='2026-11-23' AND job_id=j AND story_source='candidate' AND notes_source='candidate' AND page=old_page) THEN
   RAISE EXCEPTION 'weekly candidate did not replace all five parts'; END IF;
 BEGIN PERFORM public.job_truth_weekly_set_candidate('2026-11-23',j,NULL,other_j); RAISE EXCEPTION 'wrong generation accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'weekly_candidate_bad_generation' THEN RAISE; END IF; END;
 BEGIN PERFORM public.job_truth_weekly_set_candidate('2026-11-30',j); RAISE EXCEPTION 'absent candidate accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'weekly_candidate_no_row' THEN RAISE; END IF; END;
 BEGIN PERFORM public.job_truth_weekly_record('2026-11-23',j,'00000000-0000-4000-8000-000000003702','[]','[]'); RAISE EXCEPTION 'trade read accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'weekly_record_not_staff' THEN RAISE; END IF; END;
 BEGIN PERFORM public.job_truth_weekly_record('2026-11-23',j,'00000000-0000-4000-8000-000000003701',
   '[{"target":"story","ref":"absent","problem":"unsupported","why":"Not in records"}]','[]'); RAISE EXCEPTION 'unknown mark accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'weekly_record_bad_mark' THEN RAISE; END IF; END;
 BEGIN PERFORM public.job_truth_weekly_record('2026-11-23',j,'00000000-0000-4000-8000-000000003701','[]','[" "]'); RAISE EXCEPTION 'blank missing accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'weekly_record_bad_missing' THEN RAISE; END IF; END;
 PERFORM public.job_truth_weekly_record('2026-11-23',j,'00000000-0000-4000-8000-000000003701','[]','[]');
 BEGIN PERFORM public.job_truth_weekly_set_candidate('2026-11-23',j,'{}'); RAISE EXCEPTION 'read candidate accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'weekly_candidate_already_read' THEN RAISE; END IF; END;
END $c$;

-- The closed_how slice may land after this one. Stand in for that column only,
-- inside this transaction, so both close accuracy measures can be exercised.
ALTER TABLE public.context_ledger_items ADD COLUMN IF NOT EXISTS closed_how text;
CREATE TEMP TABLE read_jobs AS SELECT job_id,row_number() OVER (ORDER BY job_id) AS n
 FROM public.job_truth_weekly_samples WHERE week='2026-11-16';
UPDATE public.context_ledger_items SET closed_how='words_two_models',status='closed',closed_at=now(),closed_by='[{"table":"job_events","id":"fixture","excerpt":"Closed"}]'
 WHERE generation_id=(SELECT job_id FROM read_jobs WHERE n=4);
UPDATE public.context_ledger_items SET closed_how='record',status='closed',closed_at=now(),closed_by='[{"table":"job_events","id":"fixture","excerpt":"Closed"}]'
 WHERE generation_id=(SELECT job_id FROM read_jobs WHERE n=5);
SELECT public.job_truth_weekly_set_candidate('2026-11-16',job_id,NULL,job_id) FROM read_jobs WHERE n IN (4,5);
DO $c$
DECLARE j record; marks jsonb; score record; result jsonb; BEGIN
 FOR j IN SELECT * FROM read_jobs ORDER BY n LOOP
   marks := CASE WHEN j.n<=3 THEN '[{"target":"story","ref":"headline:1","problem":"unsupported","why":"Not in records"}]'::jsonb
     WHEN j.n=4 THEN (SELECT jsonb_agg(jsonb_build_object('target','note','ref','note:' || n,
       'problem',CASE WHEN n=1 THEN 'wrongly_closed' ELSE 'made_up' END,'why','Not in records')) FROM generate_series(1,6) n)
     ELSE '[]'::jsonb END;
   result := public.job_truth_weekly_record('2026-11-16',j.job_id,'00000000-0000-4000-8000-000000003701',marks,'[]');
   IF result->>'of'<>'30' THEN RAISE EXCEPTION 'weekly record denominator is not 30'; END IF;
 END LOOP;
 SELECT * INTO score FROM public.job_truth_weekly_scores WHERE week='2026-11-16';
 IF score.things<>600 OR score.wrong<>9 OR score.score<>0.9850 OR score.read<>20 OR NOT score.complete THEN
   RAISE EXCEPTION 'weekly 600 things with 9 wrong must score 0.9850: %',row_to_json(score); END IF;
 IF score.stories_with_miss<>3 OR score.jobs_with_miss<>4 OR score.story_wrong<>3 OR score.notes_wrong<>6 THEN
   RAISE EXCEPTION 'weekly story/job miss counts are wrong'; END IF;
 IF score.word_closes_read<>10 OR score.word_closes_wrong<>1 OR score.word_close_accuracy<>0.9000
   OR score.record_closes_read<>10 OR score.record_closes_wrong<>0 OR score.record_close_accuracy<>1.0000 THEN
   RAISE EXCEPTION 'weekly close accuracy is wrong'; END IF;
 IF jsonb_array_length(score.misses)<>9 OR EXISTS (SELECT 1 FROM jsonb_array_elements(score.misses) m
   WHERE m->>'job_number' NOT LIKE 'SWTEST-%' OR nullif(m->>'text','') IS NULL OR m->>'why'<>'Not in records') THEN
   RAISE EXCEPTION 'weekly misses did not retain job, words and reason'; END IF;
 SELECT job_id INTO j FROM read_jobs WHERE n=1;
 PERFORM public.job_truth_weekly_record('2026-11-16',j.job_id,'00000000-0000-4000-8000-000000003701',
   '[{"target":"story","ref":"headline:1","problem":"unsupported","why":"Not in records"}]',
   '["Missing visit","Missing reply","Missing scope","Missing request"]');
 SELECT * INTO score FROM public.job_truth_weekly_scores WHERE week='2026-11-16';
 IF score.things<>600 OR score.wrong<>13 OR score.score<>0.9783 OR score.missing_count<>4
   OR jsonb_array_length(score.misses)<>13 THEN RAISE EXCEPTION 'weekly replacement read must score 0.9783'; END IF;
END $c$;

-- No browser can read retained pages or call the privileged mutation functions.
DO $c$
BEGIN
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.job_truth_weekly_samples'::regclass)
   OR has_table_privilege('anon','public.job_truth_weekly_samples','SELECT')
   OR has_table_privilege('authenticated','public.job_truth_weekly_scores','SELECT')
   OR has_function_privilege('authenticated','public.job_truth_weekly_record(date,uuid,uuid,jsonb,jsonb)','EXECUTE') THEN
   RAISE EXCEPTION 'weekly sample is exposed to a browser role'; END IF;
 IF to_regclass('cron.job') IS NOT NULL THEN
   IF EXISTS (SELECT 1 FROM cron.job WHERE jobname='job-truth-weekly-draw') THEN RAISE EXCEPTION 'weekly migration scheduled a draw'; END IF;
 END IF;
END $c$;
-- Disposable pg_cron boundary only. No actual timer is installed by this contract.
CREATE SCHEMA cron;
CREATE TABLE cron.job(jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,jobname text UNIQUE,schedule text,command text);
CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS $$
 INSERT INTO cron.job(jobname,schedule,command) VALUES($1,$2,$3)
 ON CONFLICT (jobname) DO UPDATE SET schedule=excluded.schedule,command=excluded.command RETURNING jobid
$$;
CREATE FUNCTION cron.unschedule(bigint) RETURNS boolean LANGUAGE sql AS $$
 WITH d AS (DELETE FROM cron.job WHERE jobid=$1 RETURNING 1) SELECT EXISTS(SELECT 1 FROM d)
$$;
SELECT public.job_truth_weekly_install();
SELECT public.job_truth_weekly_install();
DO $c$ BEGIN
 IF (SELECT count(*) FROM cron.job WHERE jobname='job-truth-weekly-draw' AND schedule='0 22 * * 0'
   AND command='SELECT public.job_truth_weekly_draw();')<>1 THEN RAISE EXCEPTION 'weekly install must keep one Monday draw'; END IF;
END $c$;
SELECT public.job_truth_weekly_remove();
DO $c$ BEGIN IF EXISTS (SELECT 1 FROM cron.job) THEN RAISE EXCEPTION 'weekly remove left a schedule'; END IF; END $c$;
ROLLBACK;
