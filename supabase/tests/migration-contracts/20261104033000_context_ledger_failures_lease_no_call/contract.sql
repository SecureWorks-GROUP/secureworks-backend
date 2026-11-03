-- Synthetic jobs and runs (finish line C3, 3 Nov 2026): which ended notes runs the backoff counts.
BEGIN;
CREATE FUNCTION pg_temp.lb_assert(ok boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS NOT TRUE THEN RAISE EXCEPTION 'notes backoff: %', msg; END IF; END $$;
CREATE TEMP TABLE lb_job (k text PRIMARY KEY, id uuid NOT NULL DEFAULT gen_random_uuid());
INSERT INTO lb_job (k) VALUES ('answer'), ('transient'), ('lease_no_call'), ('lease_call'), ('no_escalate');
INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, site_suburb, metadata, created_at)
SELECT id, '00000000-0000-0000-0000-000000000001', 'scheduled', 'fencing', 'SWF-9' || row_number() OVER (ORDER BY k) || '104', 'Fixture ' || k, 'Testville', '{}', '2026-09-01'
FROM lb_job;
CREATE FUNCTION pg_temp.lb_run(p_job text, p_error text, p_at timestamptz, p_seq integer) RETURNS uuid LANGUAGE sql AS $$
 INSERT INTO public.context_extraction_runs (job_id, run_date, phase, status, error, started_at, finished_at, lease_token, run_seq)
 SELECT id, '2026-11-03', 'ledger', 'failed', p_error, p_at - interval '2 seconds', p_at, gen_random_uuid(), p_seq FROM lb_job WHERE k = p_job
 RETURNING id $$;
DO $$
DECLARE v_run uuid; f record;
BEGIN
 -- The job's own failure: a refusal its data raised, recorded with what the database said.
 PERFORM pg_temp.lb_run('answer', 'context_ledger_rebuild_packet_failed: P0001 context_rebuild_prior_source_unresolved: phase_note:none:fixture', '2026-11-03 03:02:59+00', 1);
 -- The database's passing trouble, released by the worker.
 PERFORM pg_temp.lb_run('transient', 'released:transient_db: context_ledger_rebuild_packet_failed: 57014 canceling statement due to statement timeout', '2026-11-03 03:02:59+00', 1);
 -- A lease that lapsed with no model call reserved for its run.
 PERFORM pg_temp.lb_run('lease_no_call', 'lease_expired', '2026-11-03 07:55:52+00', 1);
 -- A lease that lapsed after the run reserved a model call.
 v_run := pg_temp.lb_run('lease_call', 'lease_expired', '2026-11-03 07:57:05+00', 1);
 INSERT INTO public.context_model_call_reservations (run_date, ordinal, phase, run_id, lease_token, reserved_at)
 SELECT '2026-11-03', coalesce((SELECT max(m.ordinal) FROM public.context_model_call_reservations m WHERE m.run_date = '2026-11-03'), 0) + 1,
  'ledger', r.id, r.lease_token, '2026-11-03 05:25:47+00' FROM public.context_extraction_runs r WHERE r.id = v_run;
 -- The job's own failure, then a no-call lapse after it.
 PERFORM pg_temp.lb_run('no_escalate', 'context_ledger_rebuild_packet_failed: P0001 fixture', '2026-11-03 03:00:00+00', 1);
 PERFORM pg_temp.lb_run('no_escalate', 'lease_expired', '2026-11-03 05:00:00+00', 2);

 FOR f IN SELECT j.k, x.* FROM lb_job j JOIN public.context_ledger_failures(ARRAY(SELECT id FROM lb_job)) x ON x.job_id = j.id LOOP
  CASE f.k
   WHEN 'answer' THEN PERFORM pg_temp.lb_assert(f.failures = 1 AND f.backoff_until = '2026-11-03 05:02:59+00', 'a real failure no longer backs off 2 hours: ' || f.failures || ' ' || coalesce(f.backoff_until::text, 'null'));
   WHEN 'transient' THEN PERFORM pg_temp.lb_assert(f.failures = 0 AND f.backoff_until IS NULL, 'a released transient failure counted');
   WHEN 'lease_no_call' THEN PERFORM pg_temp.lb_assert(f.failures = 0 AND f.last_failure_at = '2026-11-03 07:55:52+00' AND f.backoff_until = '2026-11-03 08:10:52+00', 'a lapsed lease with no model call is not a 15 minute hold that never counts: ' || f.failures || ' ' || coalesce(f.backoff_until::text, 'null'));
   WHEN 'lease_call' THEN PERFORM pg_temp.lb_assert(f.failures = 1 AND f.backoff_until = '2026-11-03 09:57:05+00', 'a lapsed lease after a model call no longer counts');
   WHEN 'no_escalate' THEN PERFORM pg_temp.lb_assert(f.failures = 1 AND f.last_failure_at = '2026-11-03 05:00:00+00' AND f.backoff_until = '2026-11-03 05:15:00+00', 'a no-call lapse escalated the backoff: ' || f.failures || ' ' || coalesce(f.backoff_until::text, 'null'));
  END CASE;
 END LOOP;
 PERFORM pg_temp.lb_assert((SELECT count(*) FROM public.context_ledger_failures(ARRAY(SELECT id FROM lb_job))) = 5, 'a job missing from the answer');
 PERFORM pg_temp.lb_assert(NOT has_function_privilege('anon', 'public.context_ledger_failures(uuid[])', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.context_ledger_failures(uuid[])', 'EXECUTE'), 'public access widened');
END $$;
ROLLBACK;
