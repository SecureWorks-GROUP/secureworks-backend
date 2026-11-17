-- P0-01.3 follow-up. The previous install remains explicit.
-- Rewrite only the pinned reader so the saved-text and money clauses stay in sync with main.
SET LOCAL lock_timeout = '5s';

DO $patch$
DECLARE
 reader regprocedure := 'public.context_client_story_stored(uuid,timestamptz)'::regprocedure;
 original_body text;
 body text;
 definition text;
/* patch block */ BEGIN
 SELECT prosrc INTO STRICT original_body FROM pg_proc WHERE oid = reader;
 IF md5(original_body) = '567827aaa49310c86cd600058533b2d5' THEN RETURN; END IF;
 IF md5(original_body) IS DISTINCT FROM '1500b7b747061ddce4c5a44ac16b6ff5' THEN
  RAISE EXCEPTION 'client_story_stored_freshness_preimage_changed';
 END IF;

 definition := pg_get_functiondef(reader);
 body := original_body;
 body := replace(body, $old$
 WITH me AS ($old$, $new$
/* reader block */ BEGIN
 IF p_as_of < now() - interval '10 minutes' THEN
  RETURN public.context_client_story_saved_main(p_job_id, p_as_of);
 END IF;

 RETURN (
 WITH me AS ($new$);
 body := replace(body, $old$ -- P0-01.3: saved-text sv and its provenance remain unchanged. The newest 20
 -- additionally get phase/open items from a ready page, or a live historical story.
 st AS MATERIALIZED (
  SELECT cj.id,
   CASE WHEN p_as_of < now() - interval '10 minutes' THEN public.context_job_story(cj.id, p_as_of)
    ELSE (SELECT jsonb_build_object('loops',jp.page #> '{summary,loops}',
                 'now',jsonb_build_object('phase',jp.page #>> '{summary,phase}',
                                         'line',jp.page #>> '{summary,now_line}'))
          FROM public.job_pages jp WHERE jp.job_id=cj.id AND jp.status='ready') END AS s
  FROM cj WHERE cj.n<=20
 ),
$old$, $new$ -- Page summaries supplement the saved headlines for the newest twenty jobs.
 st AS MATERIALIZED (
  SELECT cj.id,
   (SELECT jsonb_build_object('loops', jp.page #> '{summary,loops}',
            'now', jsonb_build_object('phase', jp.page #>> '{summary,phase}',
                                      'line', jp.page #>> '{summary,now_line}'))
    FROM public.job_pages jp
    WHERE jp.job_id = cj.id AND jp.status = 'ready'
      -- Same freshness rule as job_page_get, without its build-on-miss path.
      AND NOT EXISTS (
       SELECT 1 FROM public.job_change_marks m
       WHERE m.job_id = jp.job_id AND m.mark_version IS DISTINCT FROM jp.covers_mark_version
      )) AS s
  FROM cj WHERE cj.n <= 20
 ),
$new$);
 body := replace(body, $old$SELECT 2, jsonb_build_object('what', 'Phase and open items cover at most the newest 20 jobs with a ready page; open a job for its current details.',
                          'why', 'Current asks read stored summaries; asks more than 10 minutes in the past build those summaries live.')$old$, $new$SELECT 2, jsonb_build_object('what', 'Phase and open items cover at most the newest 20 jobs with a current page; open a job for its current details.',
                          'why', 'This answer uses saved page summaries for current requests.')$new$);
 body := replace(body, $old$'why', 'Missing or failed pages supply no phase or open items.')$old$, $new$'why', 'Missing, failed or stale pages supply no phase or open items.')$new$);
 body := replace(body, $old$ WHERE EXISTS (SELECT 1 FROM me)
$old$, $new$ WHERE EXISTS (SELECT 1 FROM me)
 );
END;
$new$);
 IF md5(body) IS DISTINCT FROM '567827aaa49310c86cd600058533b2d5' THEN
  RAISE EXCEPTION 'client_story_stored_freshness_body_mismatch';
 END IF;
 EXECUTE replace(replace(definition, 'LANGUAGE sql', 'LANGUAGE plpgsql'),
                 original_body, body);
END $patch$;

COMMENT ON FUNCTION public.context_client_story_stored(uuid, timestamptz) IS
 'Job story (20261006014000), story fixes (20261006033000), story safety (20261006040000): Earlier (client story saved, 20261117090000) built no job story: each job''s now line is its saved story''s headline as current at p_as_of (context_job_story_texts), with now_source saved_story (null when it has none), story_written_at and story_checked_at; phase is null and open_loops is empty, since only a job story build works them out, and not_known says so and names the jobs with no saved story. Everything else as story safety left it: identity (CRM contact, else exact client email, never a name), every job of the client with owing, overdue and owed_by_others, money across jobs (owing and overdue are what the client owes, plus their own Xero contact as a payer on another client''s job or on an invoice placed on no job; by_party, other_jobs, placed_on_no_job, owed_by_others), past issues and standing preferences or access constraints from live ledgers, other parties per job, and not_known, sorted in C order. client-story-v1. Service role only. Builds phase and open items from current stored pages for at most the newest twenty jobs. Requests more than ten minutes in the past use the saved-text answer.';
