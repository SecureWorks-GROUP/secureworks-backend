-- P1b setup. Earlier registered fixtures supply jobs, business_events,
-- event_threads, automation_switches, the P1a ladder and candidate set, A1 and
-- K1. The job-created trigger body there is the 20260911171000 text; production
-- runs a hand-applied copy without its comment line (md5(prosrc)
-- f351722c0a1ae9a77e6e3ac7168aab34, read 23 Sep 2026). Install that body byte
-- for byte, with production's grants, and prove it before the migration.
CREATE OR REPLACE FUNCTION public.context_job_created_reconsider() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM public.rerun_context_attribution(250,NEW.ghl_contact_id); RETURN NEW;
EXCEPTION WHEN OTHERS THEN RAISE WARNING 'context job reconsideration failed: %',SQLERRM; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.context_job_created_reconsider() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_job_created_reconsider() TO service_role;
DO $$
DECLARE live text;
BEGIN
 SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid=to_regprocedure('public.context_job_created_reconsider()');
 IF live IS DISTINCT FROM 'f351722c0a1ae9a77e6e3ac7168aab34' THEN
  RAISE EXCEPTION 'p1b setup: context_job_created_reconsider() is %, not the production pre-image',live;
 END IF;
END $$;
