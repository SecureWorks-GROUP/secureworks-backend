-- P1b setup. Earlier registered fixtures supply jobs, business_events,
-- event_threads, automation_switches, the P1a ladder and candidate set, A1 and
-- K1. The job-created trigger body there is the 20260911171000 text, which is
-- production's live body (md5(prosrc) 5345aed90185a1e2366f38ee76b3ec36, read
-- 23 Sep 2026). Prove it before the migration replaces it.
DO $$
DECLARE live text;
BEGIN
 SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid=to_regprocedure('public.context_job_created_reconsider()');
 IF live IS DISTINCT FROM '5345aed90185a1e2366f38ee76b3ec36' THEN
  RAISE EXCEPTION 'p1b setup: context_job_created_reconsider() is %, not the production pre-image',live;
 END IF;
END $$;
