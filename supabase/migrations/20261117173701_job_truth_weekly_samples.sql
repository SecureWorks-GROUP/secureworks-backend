-- P4-10.1: kept weekly page samples and a person's read. No schedule runs on merge.
-- Retention ruling: keep sample history, at most 20 rows per drawn week, about 1000 a year.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.job_truth_weekly_samples (
  week date NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  drawn_at timestamptz NOT NULL DEFAULT now(),
  page jsonb NOT NULL,
  story jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes jsonb NOT NULL DEFAULT '[]'::jsonb,
  story_source text NOT NULL DEFAULT 'live' CHECK (story_source IN ('live','candidate')),
  notes_source text NOT NULL DEFAULT 'live' CHECK (notes_source IN ('live','candidate')),
  story_total integer NOT NULL DEFAULT 0,
  notes_total integer NOT NULL DEFAULT 0,
  marks jsonb,
  missing jsonb,
  read_by uuid REFERENCES public.users(id),
  read_at timestamptz,
  PRIMARY KEY (week, job_id)
);
ALTER TABLE public.job_truth_weekly_samples ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_truth_weekly_samples FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_truth_weekly_samples TO service_role;

CREATE OR REPLACE FUNCTION public.job_truth_story_sentences(p_sections jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
 SELECT coalesce(jsonb_agg(jsonb_build_object('ref',part || ':' || n,'part',part,'text',sentence)
   ORDER BY part_order,n),'[]'::jsonb)
 FROM (
   SELECT part,part_order,btrim(piece) AS sentence,
     row_number() OVER (PARTITION BY part ORDER BY sentence_order) AS n
   FROM unnest(ARRAY['headline','the_job','how_we_got_here','where_it_is_at','watch_out'])
     WITH ORDINALITY AS parts(part,part_order)
   CROSS JOIN LATERAL regexp_split_to_table(btrim(p_sections ->> part),'(?<=[.!?])\s+')
     WITH ORDINALITY AS sentences(piece,sentence_order)
   WHERE btrim(piece) <> ''
 ) s
$fn$;

CREATE OR REPLACE FUNCTION public.job_truth_notes_of(p_generation_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
 -- context_ledger_items_generation indexes this equality read.
 SELECT coalesce(jsonb_agg(jsonb_build_object('item_id',i.id,'item_key',i.item_key,
   'status',i.status,'what',i.what,'closed_how',to_jsonb(i) ->> 'closed_how')
   ORDER BY i.item_key COLLATE "C",i.id),'[]'::jsonb)
 FROM public.context_ledger_items i
 WHERE i.generation_id=p_generation_id AND i.status IN ('open','closed','declined','disputed')
$fn$;

CREATE OR REPLACE FUNCTION public.job_truth_weekly_draw(p_week date DEFAULT NULL,p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
 v_week date := coalesce(p_week,date_trunc('week',now() AT TIME ZONE 'Australia/Perth')::date);
 v_job uuid; v_page jsonb; v_story jsonb; v_notes jsonb; v_ids jsonb := '[]'::jsonb; BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 5 AND 20 THEN RAISE EXCEPTION 'weekly_draw_bad_limit'; END IF;
 -- Serialise only draws for this week. No business writer uses this lock.
 PERFORM pg_advisory_xact_lock(173701,v_week - DATE '2000-01-01');
 IF EXISTS (SELECT 1 FROM public.job_truth_weekly_samples WHERE week=v_week) THEN
   RETURN jsonb_build_object('outcome','already_drawn','week',v_week);
 END IF;
 -- Keep-ready ids join jobs_pkey, job_pages_pkey and job_change_marks_pkey.
 -- Random order scans the eligible set once, only on the explicit weekly draw.
 FOR v_job IN
   SELECT j.id FROM public.job_pages_keep_ready_set() AS k(id)
   JOIN public.jobs j ON j.id=k.id
   JOIN public.job_pages p ON p.job_id=j.id AND p.status='ready'
   JOIN public.job_change_marks m ON m.job_id=j.id
   WHERE m.last_marked_at >= now() - interval '28 days' AND j.job_number NOT LIKE 'ZZTEST%'
   ORDER BY random() LIMIT p_limit
 LOOP
   PERFORM public.job_page_refresh(v_job);
   SELECT page INTO v_page FROM public.job_pages WHERE job_id=v_job AND status='ready';
   IF NOT FOUND THEN RAISE EXCEPTION 'weekly_draw_page_unavailable'; END IF;
   v_story := public.job_truth_story_sentences(v_page #> '{story_text,text,sections}');
   -- context_ledger_generations_one_live is unique for this job and status.
   v_notes := public.job_truth_notes_of((SELECT id FROM public.context_ledger_generations
     WHERE job_id=v_job AND status='live'));
   INSERT INTO public.job_truth_weekly_samples(week,job_id,page,story,notes,story_total,notes_total)
   VALUES(v_week,v_job,v_page,v_story,v_notes,jsonb_array_length(v_story),jsonb_array_length(v_notes));
   v_ids := v_ids || jsonb_build_array(v_job);
 END LOOP;
 RETURN jsonb_build_object('outcome','drawn','week',v_week,'jobs',jsonb_array_length(v_ids),'job_ids',v_ids);
END $fn$;

CREATE OR REPLACE FUNCTION public.job_truth_weekly_set_candidate(
 p_week date,p_job_id uuid,p_story_sections jsonb DEFAULT NULL,p_notes_generation uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_row public.job_truth_weekly_samples; v_story jsonb; v_notes jsonb; BEGIN
 SELECT * INTO v_row FROM public.job_truth_weekly_samples WHERE week=p_week AND job_id=p_job_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'weekly_candidate_no_row'; END IF;
 IF v_row.read_at IS NOT NULL THEN RAISE EXCEPTION 'weekly_candidate_already_read'; END IF;
 -- context_ledger_generations_pkey reads this single generation's owner.
 IF p_notes_generation IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.context_ledger_generations
   WHERE id=p_notes_generation AND job_id=p_job_id) THEN RAISE EXCEPTION 'weekly_candidate_bad_generation'; END IF;
 v_story := CASE WHEN p_story_sections IS NOT NULL THEN public.job_truth_story_sentences(p_story_sections) ELSE v_row.story END;
 v_notes := CASE WHEN p_notes_generation IS NOT NULL THEN public.job_truth_notes_of(p_notes_generation) ELSE v_row.notes END;
 UPDATE public.job_truth_weekly_samples SET story=v_story,notes=v_notes,
   story_source=CASE WHEN p_story_sections IS NOT NULL THEN 'candidate' ELSE story_source END,
   notes_source=CASE WHEN p_notes_generation IS NOT NULL THEN 'candidate' ELSE notes_source END,
   story_total=jsonb_array_length(v_story),notes_total=jsonb_array_length(v_notes)
 WHERE week=p_week AND job_id=p_job_id;
 RETURN jsonb_build_object('outcome','set','story_total',jsonb_array_length(v_story),'notes_total',jsonb_array_length(v_notes));
END $fn$;

CREATE OR REPLACE FUNCTION public.job_truth_weekly_record(
 p_week date,p_job_id uuid,p_user uuid,p_marks jsonb,p_missing jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_row public.job_truth_weekly_samples; v_mark jsonb; v_line jsonb; v_seen text[] := '{}';
 v_marks jsonb := coalesce(p_marks,'[]'::jsonb); v_missing jsonb := coalesce(p_missing,'[]'::jsonb); BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.users WHERE id=p_user AND role IN ('admin','owner','ops_manager')) THEN
   RAISE EXCEPTION 'weekly_record_not_staff';
 END IF;
 SELECT * INTO v_row FROM public.job_truth_weekly_samples WHERE week=p_week AND job_id=p_job_id FOR UPDATE;
 IF NOT FOUND OR jsonb_typeof(v_marks) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'weekly_record_bad_mark'; END IF;
 FOR v_mark IN SELECT value FROM jsonb_array_elements(v_marks) LOOP
   IF jsonb_typeof(v_mark) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_mark->'target') IS DISTINCT FROM 'string'
     OR jsonb_typeof(v_mark->'ref') IS DISTINCT FROM 'string'
     OR jsonb_typeof(v_mark->'problem') IS DISTINCT FROM 'string'
     OR jsonb_typeof(v_mark->'why') IS DISTINCT FROM 'string'
     OR v_mark->>'target' NOT IN ('story','note')
     OR v_mark->>'problem' NOT IN ('unsupported','wrong_money','wrongly_open','wrongly_closed','made_up')
     OR length(btrim(v_mark->>'why')) NOT BETWEEN 3 AND 300
     OR v_mark->>'ref'=ANY(v_seen) THEN RAISE EXCEPTION 'weekly_record_bad_mark'; END IF;
   IF NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements(CASE WHEN v_mark->>'target'='story' THEN v_row.story ELSE v_row.notes END) e
     WHERE e->>CASE WHEN v_mark->>'target'='story' THEN 'ref' ELSE 'item_key' END=v_mark->>'ref'
   ) THEN RAISE EXCEPTION 'weekly_record_bad_mark'; END IF;
   v_seen := array_append(v_seen,v_mark->>'ref');
 END LOOP;
 IF jsonb_typeof(v_missing) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'weekly_record_bad_missing'; END IF;
 IF jsonb_array_length(v_missing)>20 THEN RAISE EXCEPTION 'weekly_record_bad_missing'; END IF;
 FOR v_line IN SELECT value FROM jsonb_array_elements(v_missing) LOOP
   IF jsonb_typeof(v_line) IS DISTINCT FROM 'string' OR length(btrim(v_line #>> '{}')) NOT BETWEEN 3 AND 300 THEN
     RAISE EXCEPTION 'weekly_record_bad_missing';
   END IF;
 END LOOP;
 UPDATE public.job_truth_weekly_samples SET marks=v_marks,missing=v_missing,read_by=p_user,read_at=now()
 WHERE week=p_week AND job_id=p_job_id;
 RETURN jsonb_build_object('outcome','recorded','wrong',jsonb_array_length(v_marks)+jsonb_array_length(v_missing),
   'of',v_row.story_total+v_row.notes_total);
END $fn$;

CREATE OR REPLACE VIEW public.job_truth_weekly_scores WITH (security_invoker=true) AS
WITH samples AS (
 SELECT s.*,j.job_number,
   coalesce(s.marks,'[]'::jsonb) AS mark_list,coalesce(s.missing,'[]'::jsonb) AS missing_list
 FROM public.job_truth_weekly_samples s JOIN public.jobs j ON j.id=s.job_id
), counted AS (
 SELECT s.*,
   (SELECT count(*) FROM jsonb_array_elements(mark_list) m WHERE m->>'target'='story') AS story_misses,
   (SELECT count(*) FROM jsonb_array_elements(mark_list) m WHERE m->>'target'='note') AS note_misses,
   (SELECT count(*) FROM jsonb_array_elements(notes) n WHERE n->>'closed_how'='words_two_models') AS word_read,
   (SELECT count(*) FROM jsonb_array_elements(notes) n WHERE n->>'closed_how'='record') AS record_read,
   (SELECT count(*) FROM jsonb_array_elements(mark_list) m JOIN jsonb_array_elements(notes) n ON n->>'item_key'=m->>'ref'
     WHERE m->>'target'='note' AND m->>'problem'='wrongly_closed' AND n->>'closed_how'='words_two_models') AS word_wrong,
   (SELECT count(*) FROM jsonb_array_elements(mark_list) m JOIN jsonb_array_elements(notes) n ON n->>'item_key'=m->>'ref'
     WHERE m->>'target'='note' AND m->>'problem'='wrongly_closed' AND n->>'closed_how'='record') AS record_wrong
 FROM samples s
), totals AS (
 SELECT week,count(*) AS drawn,count(read_at) AS read,
   coalesce(sum(story_total+notes_total) FILTER (WHERE read_at IS NOT NULL),0) AS things,
   coalesce(sum(jsonb_array_length(mark_list)+jsonb_array_length(missing_list)) FILTER (WHERE read_at IS NOT NULL),0) AS wrong,
   coalesce(sum(story_misses) FILTER (WHERE read_at IS NOT NULL),0) AS story_wrong,
   coalesce(sum(note_misses) FILTER (WHERE read_at IS NOT NULL),0) AS notes_wrong,
   coalesce(sum(jsonb_array_length(missing_list)) FILTER (WHERE read_at IS NOT NULL),0) AS missing_count,
   count(*) FILTER (WHERE read_at IS NOT NULL AND story_misses>0) AS stories_with_miss,
   count(*) FILTER (WHERE read_at IS NOT NULL AND jsonb_array_length(mark_list)+jsonb_array_length(missing_list)>0) AS jobs_with_miss,
   count(*) FILTER (WHERE story_source='candidate' OR notes_source='candidate') AS candidate_rows,
   -- Before the closed_how migration, its three close measures are unknown.
   CASE WHEN EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.context_ledger_items'::regclass
     AND attname='closed_how' AND NOT attisdropped)
     THEN coalesce(sum(word_read) FILTER (WHERE read_at IS NOT NULL),0) END AS word_closes_read,
   CASE WHEN EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.context_ledger_items'::regclass
     AND attname='closed_how' AND NOT attisdropped)
     THEN coalesce(sum(word_wrong) FILTER (WHERE read_at IS NOT NULL),0) END AS word_closes_wrong,
   CASE WHEN EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.context_ledger_items'::regclass
     AND attname='closed_how' AND NOT attisdropped)
     THEN coalesce(sum(record_read) FILTER (WHERE read_at IS NOT NULL),0) END AS record_closes_read,
   CASE WHEN EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.context_ledger_items'::regclass
     AND attname='closed_how' AND NOT attisdropped)
     THEN coalesce(sum(record_wrong) FILTER (WHERE read_at IS NOT NULL),0) END AS record_closes_wrong
 FROM counted GROUP BY week
), misses AS (
 SELECT s.week,s.job_id,s.read_at,0 AS kind,m.ord,
   m.value || jsonb_build_object('job_number',s.job_number,'text',
     (SELECT e->>CASE WHEN m.value->>'target'='story' THEN 'text' ELSE 'what' END
      FROM jsonb_array_elements(CASE WHEN m.value->>'target'='story' THEN s.story ELSE s.notes END) e
      WHERE e->>CASE WHEN m.value->>'target'='story' THEN 'ref' ELSE 'item_key' END=m.value->>'ref')) AS miss
 FROM samples s CROSS JOIN LATERAL jsonb_array_elements(mark_list) WITH ORDINALITY m(value,ord)
 WHERE s.read_at IS NOT NULL
 UNION ALL
 SELECT s.week,s.job_id,s.read_at,1,m.ord,jsonb_build_object('job_number',s.job_number,'target','missing','why',m.value #>> '{}')
 FROM samples s CROSS JOIN LATERAL jsonb_array_elements(missing_list) WITH ORDINALITY m(value,ord)
 WHERE s.read_at IS NOT NULL
)
SELECT t.week,t.drawn,t.read,t.things,t.wrong,round(1-t.wrong::numeric/nullif(t.things,0),4) AS score,
 t.story_wrong,t.notes_wrong,t.missing_count,t.stories_with_miss,t.jobs_with_miss,t.read=t.drawn AS complete,t.candidate_rows,
 coalesce((SELECT jsonb_agg(m.miss ORDER BY m.read_at DESC,m.job_id,m.kind,m.ord) FROM misses m WHERE m.week=t.week),'[]'::jsonb) AS misses,
 t.word_closes_read,t.word_closes_wrong,round(1-t.word_closes_wrong::numeric/nullif(t.word_closes_read,0),4) AS word_close_accuracy,
 t.record_closes_read,t.record_closes_wrong,round(1-t.record_closes_wrong::numeric/nullif(t.record_closes_read,0),4) AS record_close_accuracy
FROM totals t;
REVOKE ALL ON public.job_truth_weekly_scores FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.job_truth_weekly_scores TO service_role;

-- Explicit activation only after the director's copy proof. Merge never schedules a draw.
CREATE OR REPLACE FUNCTION public.job_truth_weekly_install() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$ BEGIN
 IF to_regclass('cron.job') IS NULL THEN RAISE EXCEPTION 'weekly_draw_cron_unavailable'; END IF;
 PERFORM cron.schedule('job-truth-weekly-draw','0 22 * * 0',$cmd$SELECT public.job_truth_weekly_draw();$cmd$);
END $fn$;
CREATE OR REPLACE FUNCTION public.job_truth_weekly_remove() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v_job bigint; BEGIN
 IF to_regclass('cron.job') IS NOT NULL THEN
   FOR v_job IN SELECT jobid FROM cron.job WHERE jobname='job-truth-weekly-draw' LOOP
     PERFORM cron.unschedule(v_job);
   END LOOP;
 END IF;
END $fn$;

REVOKE ALL ON FUNCTION public.job_truth_story_sentences(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_truth_notes_of(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_truth_weekly_draw(date,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_truth_weekly_set_candidate(date,uuid,jsonb,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_truth_weekly_record(date,uuid,uuid,jsonb,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_truth_weekly_install() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_truth_weekly_remove() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_truth_story_sentences(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.job_truth_notes_of(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.job_truth_weekly_draw(date,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.job_truth_weekly_set_candidate(date,uuid,jsonb,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.job_truth_weekly_record(date,uuid,uuid,jsonb,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.job_truth_weekly_install() TO service_role;
GRANT EXECUTE ON FUNCTION public.job_truth_weekly_remove() TO service_role;
