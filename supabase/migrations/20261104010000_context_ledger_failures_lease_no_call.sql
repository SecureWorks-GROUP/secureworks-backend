-- (finish line C3, 3 Nov 2026) A notes run whose lease lapsed before any model call was reserved for it
-- no longer counts toward the job's notes backoff: it holds the job 15 minutes and never escalates.
--
-- Backoff (context_ledger_failures) exists so a job that keeps failing does not keep spending model
-- calls. A run closed lease_expired (by context_ledger_claim, when a later claim finds its lease lapsed)
-- with no row in context_model_call_reservations spent nothing: the worker stopped, lost the claim's
-- answer, or could not reach the store to release it. Such a run is no longer counted (the job's failure
-- count and so its 2 h, 8 h, Perth midnight, 7 day steps ignore it); the newest one since the newest
-- success is still the job's last_failure_at (so the judge's new-evidence freshness reads it as before)
-- and holds the job 15 minutes from the lapse (backoff_until is the later of the two), so a job whose
-- reading stops the worker before any model call is still not claimed again at once (the guard the
-- ledger store contract keeps: "a lapsed build backs off"). A lease_expired run that reserved a call still counts exactly as
-- before, as does every other failure.
--
-- Why reservations and not context_ledger_generations.calls: calls is written only by
-- context_ledger_finish, so a lapsed run's generation always reads 0. On 3 Nov SWMS-261204 and
-- SWMS-26918 read calls = 0 yet each had reserved one call (05:25:01Z, 05:25:47Z) before their release
-- met the database overload at 05:26Z. Under this rule they still count (they spent a call); the worker
-- fix (secureworks-jarvis, same branch name) asks such a release again so the run is released instead.
--
-- Changes: the `runs` filter, a `lapse` CTE, last_failure_at and backoff_until as the later of the old
-- answer and the lapse (plus 15 minutes); everything else is byte for byte the live definition.
-- Guard: the live function must be the definition this was written against (md5 d660f505...).
-- Rollback: supabase/rollbacks/20261104010000_context_ledger_failures_lease_no_call_down.sql.
SET LOCAL lock_timeout = '5s';

DO $mig$
DECLARE
  v_def text;
  v_old0 text := $o$   AND coalesce(r.error, '') NOT LIKE 'released:%'
 ),$o$;
  v_new0 text := $n$   AND coalesce(r.error, '') NOT LIKE 'released:%'
   -- (20261104010000) a lease that lapsed with no model call reserved for the run is not counted (lapse below)
   AND NOT (coalesce(r.error, '') = 'lease_expired' AND NOT EXISTS (SELECT 1 FROM public.context_model_call_reservations m WHERE m.run_id = r.id))
 ),
 lapse AS (  -- (20261104010000) the newest such lapse since the newest success: the last failed read's time
             -- and a 15 minute hold, never a count, so it never escalates
  SELECT r.job_id, max(r.finished_at) AS at
  FROM public.context_extraction_runs r JOIN ids ON ids.id = r.job_id
  WHERE r.phase = 'ledger' AND r.status = 'failed' AND r.error = 'lease_expired' AND r.finished_at IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.context_model_call_reservations m WHERE m.run_id = r.id)
   AND r.finished_at > coalesce((SELECT max(s.finished_at) FROM runs s WHERE s.job_id = r.job_id AND NOT s.failed), '-infinity'::timestamptz)
  GROUP BY r.job_id
 ),$n$;
  v_old1 text := $o$ SELECT ids.id, coalesce(st.failures, 0), st.last_failure_at,$o$;
  v_new1 text := $n$ SELECT ids.id, coalesce(st.failures, 0), greatest(st.last_failure_at, lp.at),$n$;
  v_old2 text := $o$  CASE WHEN st.failures IS NULL THEN NULL$o$;
  v_new2 text := $n$  greatest(CASE WHEN st.failures IS NULL THEN NULL$n$;
  v_old3 text := $o$   ELSE st.last_failure_at + interval '7 days' END,$o$;
  v_new3 text := $n$   ELSE st.last_failure_at + interval '7 days' END, lp.at + interval '15 minutes'),$n$;
  v_old4 text := $o$ FROM ids LEFT JOIN streak st ON st.job_id = ids.id LEFT JOIN fb ON fb.job_id = ids.id$o$;
  v_new4 text := $n$ FROM ids LEFT JOIN streak st ON st.job_id = ids.id LEFT JOIN fb ON fb.job_id = ids.id LEFT JOIN lapse lp ON lp.job_id = ids.id$n$;
BEGIN
  SELECT pg_get_functiondef('public.context_ledger_failures(uuid[])'::regprocedure) INTO v_def;
  IF md5(v_def) = '131250979ba19a939a75bfbd05f5e05e' THEN
    RAISE NOTICE 'context_ledger_failures already carries 20261104010000';
    RETURN;
  END IF;
  IF md5(v_def) <> 'd660f50592ef542e5e4205dc3a4ef7ba' THEN
    RAISE EXCEPTION 'context_ledger_failures is not the definition this migration was written against (md5 %)', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old0, ''))) / length(v_old0) <> 1 THEN
    RAISE EXCEPTION 'context_ledger_failures: change 1 does not match exactly once';
  END IF;
  v_def := replace(v_def, v_old0, v_new0);
  IF (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1) <> 1 THEN
    RAISE EXCEPTION 'context_ledger_failures: change 2 does not match exactly once';
  END IF;
  v_def := replace(v_def, v_old1, v_new1);
  IF (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2) <> 1 THEN
    RAISE EXCEPTION 'context_ledger_failures: change 3 does not match exactly once';
  END IF;
  v_def := replace(v_def, v_old2, v_new2);
  IF (length(v_def) - length(replace(v_def, v_old3, ''))) / length(v_old3) <> 1 THEN
    RAISE EXCEPTION 'context_ledger_failures: change 4 does not match exactly once';
  END IF;
  v_def := replace(v_def, v_old3, v_new3);
  IF (length(v_def) - length(replace(v_def, v_old4, ''))) / length(v_old4) <> 1 THEN
    RAISE EXCEPTION 'context_ledger_failures: change 5 does not match exactly once';
  END IF;
  v_def := replace(v_def, v_old4, v_new4);
  EXECUTE v_def;
  SELECT pg_get_functiondef('public.context_ledger_failures(uuid[])'::regprocedure) INTO v_def;
  IF md5(v_def) <> '131250979ba19a939a75bfbd05f5e05e' THEN
    RAISE EXCEPTION 'context_ledger_failures after the change is not the rehearsed definition (md5 %)', md5(v_def);
  END IF;
END
$mig$;

COMMENT ON FUNCTION public.context_ledger_failures(uuid[]) IS
 'Context ledger store (20261006013000), 20261104010000: per job, consecutive failed ledger runs since the newest success (status failed, or done with error checks_failed; runs released with error released:<code> never count), the backoff they earn from the last one (1: 2 hours, 2: 8 hours, 3: the next Perth midnight, 4 or more: 7 days), and consecutive check-failed builds by the current settings reader (a shadow whose checks.passed is false; a live or retired reading breaks the run). needs_person when three in a row failed their checks. Read by the judge and the scorecard. Service role only. A run closed lease_expired with no model call reserved for it (context_model_call_reservations.run_id) is not counted either: it spent nothing and the lapse was the worker''s, not the job''s; the newest such lapse since the newest success is the job''s last_failure_at and holds it 15 minutes from it (backoff_until is the later of the two), which never escalates.';
