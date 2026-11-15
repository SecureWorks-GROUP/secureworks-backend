-- Deliberately let a day on the job finish it again, as the first version did: a job at scheduled with an old
-- sign-off, or at in_progress with a stale completed_at, would be called final once it had been quiet. The
-- contract must fail.
DO $$
DECLARE d text := pg_get_functiondef('public.job_cost_close(uuid[],date)'::regprocedure);
        old constant text := 'ELSE m.finished_status OR m.invoice_finish_on IS NOT NULL';
BEGIN
  IF position(old IN d) = 0 THEN
    RAISE EXCEPTION 'break: the finish rule was not found';
  END IF;
  EXECUTE replace(d, old, 'ELSE m.finished_status OR m.invoice_finish_on IS NOT NULL OR m.work_done_on IS NOT NULL');
END $$;
