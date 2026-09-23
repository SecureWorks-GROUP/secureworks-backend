-- Down for 20260924160000 (P1b): restore the live job-created trigger body byte
-- for byte and drop context_reconsider_contact and its eligibility helper. Rows reconsidered under P1b
-- keep their placement, review state and metadata (a later logged re-run, not
-- a rollback, moves rows).
--   context_job_created_reconsider()  md5(prosrc) f351722c0a1ae9a77e6e3ac7168aab34 (live,
--   hand-applied; the repository text less one comment line)
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Refuse to overwrite a later change: the trigger body must be P1b's (or
-- already the restored live body, for a repeated rollback), and the new
-- function P1b's (or already gone).
DO $guard$
DECLARE problems text[]:='{}'; live text;
BEGIN
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure('public.context_job_created_reconsider()');
 IF live IS NULL OR NOT live=ANY(ARRAY['2e199e27d38730e95bd5f2b0b8a9b165','f351722c0a1ae9a77e6e3ac7168aab34']) THEN
  problems:=problems||format('public.context_job_created_reconsider() md5 %s',coalesce(live,'<missing>'));
 END IF;
 live:=NULL;
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure('public.context_reconsider_contact(text,timestamptz,text,uuid)');
 IF live IS NOT NULL AND live<>'c4353d7e562bd5e92a5fd847d80c6238' THEN
  problems:=problems||format('public.context_reconsider_contact(text,timestamptz,text,uuid) md5 %s',live);
 END IF;
 live:=NULL;
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure('public.context_reconsider_eligible(public.business_events,uuid)');
 IF live IS NOT NULL AND live<>'375857877700389aa8f6f730095b8800' THEN
  problems:=problems||format('public.context_reconsider_eligible(public.business_events,uuid) md5 %s',live);
 END IF;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_reconsider_rollback_mismatch: %; a later change must be rolled back first',array_to_string(problems,'; ');
 END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.context_job_created_reconsider() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM public.rerun_context_attribution(250,NEW.ghl_contact_id); RETURN NEW;
EXCEPTION WHEN OTHERS THEN RAISE WARNING 'context job reconsideration failed: %',SQLERRM; RETURN NEW;
END $$;
COMMENT ON FUNCTION public.context_job_created_reconsider() IS NULL;
REVOKE ALL ON FUNCTION public.context_job_created_reconsider() FROM PUBLIC,anon,authenticated;

DROP FUNCTION IF EXISTS public.context_reconsider_contact(text,timestamptz,text,uuid);
DROP FUNCTION IF EXISTS public.context_reconsider_eligible(public.business_events,uuid);
