DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='jobs_preserve_first_acceptance_stamp') THEN RAISE EXCEPTION 'acceptance trigger remains after rollback'; END IF;
 IF (SELECT accepted_at_evidence->>'quality' FROM public.jobs WHERE id='ea000000-0000-4000-8000-000000000002') IS DISTINCT FROM 'BACKFILLED' THEN RAISE EXCEPTION 'rollback erased acquired provenance'; END IF;
END $$;
