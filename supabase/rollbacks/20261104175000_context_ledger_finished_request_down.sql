-- Undo 20261104175000_context_ledger_finished_request: the judge and the due list back to the definitions before
-- it (judge md5 4b8ea581f9a98351aa5a651a5fc950fd, due md5 47b7d2327b018aeaa17d7bbaf453d824). A pending request on a finished job then waits again, never read.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $mig$
DECLARE
  v_def text;
  v_old1 text := $o$    WHERE m.state = 'finished_awake'
    UNION ALL
    -- (finished request, 20261104175000) finished jobs with an operator's request to read them again whole
    -- still pending (context_ledger_rebuild_request_state); the judge calls each live until it is read
    SELECT q.job_id FROM public.context_ledger_rebuild_request_state(ARRAY(
      SELECT DISTINCT r.job_id FROM public.context_ledger_rebuild_requests r JOIN public.jobs jb ON jb.id = r.job_id, st
      WHERE jb.status::text IN ('cancelled','archived','complete','completed','lost') AND st.mode <> 'off'
       AND public.automation_lane_enabled('extraction')
       AND (st.job_ids IS NULL OR jb.id = ANY(st.job_ids)))) q
    WHERE q.state = 'pending')) jd
$o$;
  v_new1 text := $n$    WHERE m.state = 'finished_awake')) jd
$n$;
BEGIN
  SELECT pg_get_functiondef('public.context_ledger_due(integer)'::regprocedure) INTO v_def;
  IF md5(v_def) = '47b7d2327b018aeaa17d7bbaf453d824' THEN
    RAISE NOTICE 'context_ledger_due is already the earlier definition';
    RETURN;
  END IF;
  IF md5(v_def) <> '45a8acdef4407d21d2f68f2118c9efd9' THEN
    RAISE EXCEPTION 'context_ledger_due is not the definition this was written against (md5 %)', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1) <> 1 THEN
    RAISE EXCEPTION 'context_ledger_due: edit 1 is not there exactly once';
  END IF;
  v_def := replace(v_def, v_old1, v_new1);
  EXECUTE v_def;
  SELECT pg_get_functiondef('public.context_ledger_due(integer)'::regprocedure) INTO v_def;
  IF md5(v_def) <> '47b7d2327b018aeaa17d7bbaf453d824' THEN
    RAISE EXCEPTION 'context_ledger_due after the change is not the built definition (md5 %)', md5(v_def);
  END IF;
END
$mig$;

DO $mig$
DECLARE
  v_def text;
  v_old1 text := $o$ ), rqf AS MATERIALIZED (
  -- (finished request, 20261104175000) the finished jobs asked about with an operator's request to read
  -- them again whole still pending (context_ledger_rebuild_request_state: no reading since has answered
  -- it and fewer than three failed)
  SELECT DISTINCT q.job_id FROM public.context_ledger_rebuild_request_state(ARRAY(SELECT j0.id FROM j0 WHERE NOT j0.open_job)) q
  WHERE q.state = 'pending'
 ), j AS (
  -- (scoping pipeline, 20261009133000) a draft is live only while the rule monitors it (real activity
$o$;
  v_new1 text := $n$ ), j AS (
  -- (scoping pipeline, 20261009133000) a draft is live only while the rule monitors it (real activity
$n$;
  v_old2 text := $o$                OR (NOT j0.open_job AND coalesce(lr.state = 'finished_awake', false))
                -- (finished request, 20261104175000) or while an operator's request to read it again whole is
                -- pending: the reading it causes answers the request and the job is quiet again (C6, 3 Nov 2026:
                -- the CIO's requests on archived SWF-261053 and SWP-26321 waited 10 hours, never read)
                OR (NOT j0.open_job AND rqf.job_id IS NOT NULL) AS live_job, j0.schedulable
  FROM j0 LEFT JOIN lr ON lr.job_id = j0.id LEFT JOIN rqf ON rqf.job_id = j0.id
$o$;
  v_new2 text := $n$                OR (NOT j0.open_job AND coalesce(lr.state = 'finished_awake', false)) AS live_job, j0.schedulable
  FROM j0 LEFT JOIN lr ON lr.job_id = j0.id
$n$;
BEGIN
  SELECT pg_get_functiondef('public.context_ledger_judge(uuid[])'::regprocedure) INTO v_def;
  IF md5(v_def) = '4b8ea581f9a98351aa5a651a5fc950fd' THEN
    RAISE NOTICE 'context_ledger_judge is already the earlier definition';
    RETURN;
  END IF;
  IF md5(v_def) <> '7d553db616fc65759c15e5aac64db21e' THEN
    RAISE EXCEPTION 'context_ledger_judge is not the definition this was written against (md5 %)', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1) <> 1 THEN
    RAISE EXCEPTION 'context_ledger_judge: edit 1 is not there exactly once';
  END IF;
  v_def := replace(v_def, v_old1, v_new1);
  IF (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2) <> 1 THEN
    RAISE EXCEPTION 'context_ledger_judge: edit 2 is not there exactly once';
  END IF;
  v_def := replace(v_def, v_old2, v_new2);
  EXECUTE v_def;
  SELECT pg_get_functiondef('public.context_ledger_judge(uuid[])'::regprocedure) INTO v_def;
  IF md5(v_def) <> '4b8ea581f9a98351aa5a651a5fc950fd' THEN
    RAISE EXCEPTION 'context_ledger_judge after the change is not the built definition (md5 %)', md5(v_def);
  END IF;
END
$mig$;
