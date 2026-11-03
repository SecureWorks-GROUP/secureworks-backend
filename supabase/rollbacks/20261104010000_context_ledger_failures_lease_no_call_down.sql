-- Undo 20261104010000_context_ledger_failures_lease_no_call: context_ledger_failures counts every
-- lease_expired notes run again, with or without a model call (md5 d660f50592ef542e5e4205dc3a4ef7ba).
SET LOCAL lock_timeout = '5s';

DO $down$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef('public.context_ledger_failures(uuid[])'::regprocedure) INTO v_def;
  IF md5(v_def) = 'd660f50592ef542e5e4205dc3a4ef7ba' THEN
    RAISE NOTICE 'context_ledger_failures is already the old definition';
    RETURN;
  END IF;
  IF md5(v_def) <> '131250979ba19a939a75bfbd05f5e05e' THEN
    RAISE EXCEPTION 'context_ledger_failures is not the 20261104010000 definition (md5 %)', md5(v_def);
  END IF;
  -- The exact definition before 20261104010000 (md5 d660f50592ef542e5e4205dc3a4ef7ba), as pg_get_functiondef printed it.
  EXECUTE $old_def$CREATE OR REPLACE FUNCTION public.context_ledger_failures(p_job_ids uuid[])
 RETURNS TABLE(job_id uuid, failures integer, last_failure_at timestamp with time zone, backoff_until timestamp with time zone, failed_builds integer, needs_person boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH ids AS (SELECT DISTINCT x.id FROM unnest(p_job_ids) AS x(id) WHERE x.id IS NOT NULL),
 s AS (SELECT (SELECT st.reader FROM public.context_ledger_settings st WHERE st.id) AS reader),
 runs AS (  -- every ended ledger run that was not released, newest first
  SELECT r.job_id, r.finished_at, (r.status = 'failed' OR coalesce(r.error, '') = 'checks_failed') AS failed,
   row_number() OVER (PARTITION BY r.job_id ORDER BY r.finished_at DESC, r.id DESC) AS n
  FROM public.context_extraction_runs r JOIN ids ON ids.id = r.job_id
  WHERE r.phase = 'ledger' AND r.status IN ('done', 'failed') AND r.finished_at IS NOT NULL
   AND coalesce(r.error, '') NOT LIKE 'released:%'
 ),
 streak AS (  -- the failures since the newest success
  SELECT r.job_id, count(*)::integer AS failures, max(r.finished_at) AS last_failure_at
  FROM runs r
  WHERE r.failed AND r.n < coalesce((SELECT min(r2.n) FROM runs r2 WHERE r2.job_id = r.job_id AND NOT r2.failed), 2147483647)
  GROUP BY r.job_id
 ),
 builds AS (  -- completed readings by the current reader, newest first (a failed or released build is not a reading)
  SELECT g.job_id, (g.status = 'shadow' AND NOT public.context_ledger_checks_pass(g.checks)) AS check_failed,
   row_number() OVER (PARTITION BY g.job_id ORDER BY g.finished_at DESC NULLS LAST, g.created_at DESC, g.id DESC) AS n
  FROM public.context_ledger_generations g JOIN ids ON ids.id = g.job_id CROSS JOIN s
  WHERE g.kind IN ('backfill', 'rebuild') AND g.status IN ('shadow', 'live', 'retired') AND g.reader = s.reader
 ),
 fb AS (
  SELECT b.job_id, count(*)::integer AS failed_builds
  FROM builds b
  WHERE b.check_failed AND b.n < coalesce((SELECT min(b2.n) FROM builds b2 WHERE b2.job_id = b.job_id AND NOT b2.check_failed), 2147483647)
  GROUP BY b.job_id
 )
 SELECT ids.id, coalesce(st.failures, 0), st.last_failure_at,
  CASE WHEN st.failures IS NULL THEN NULL
   WHEN st.failures = 1 THEN st.last_failure_at + interval '2 hours'
   WHEN st.failures = 2 THEN st.last_failure_at + interval '8 hours'
   WHEN st.failures = 3 THEN (date_trunc('day', st.last_failure_at AT TIME ZONE 'Australia/Perth') + interval '1 day') AT TIME ZONE 'Australia/Perth'
   ELSE st.last_failure_at + interval '7 days' END,
  coalesce(fb.failed_builds, 0), coalesce(fb.failed_builds, 0) >= 3
 FROM ids LEFT JOIN streak st ON st.job_id = ids.id LEFT JOIN fb ON fb.job_id = ids.id
$function$
$old_def$;
  SELECT pg_get_functiondef('public.context_ledger_failures(uuid[])'::regprocedure) INTO v_def;
  IF md5(v_def) <> 'd660f50592ef542e5e4205dc3a4ef7ba' THEN
    RAISE EXCEPTION 'context_ledger_failures after undo is not the old definition (md5 %)', md5(v_def);
  END IF;
END
$down$;

COMMENT ON FUNCTION public.context_ledger_failures(uuid[]) IS
 'Context ledger store (20261006013000): per job, consecutive failed ledger runs since the newest success (status failed, or done with error checks_failed; runs released with error released:<code> never count), the backoff they earn from the last one (1: 2 hours, 2: 8 hours, 3: the next Perth midnight, 4 or more: 7 days), and consecutive check-failed builds by the current settings reader (a shadow whose checks.passed is false; a live or retired reading breaks the run). needs_person when three in a row failed their checks. Read by the judge and the scorecard. Service role only.';
