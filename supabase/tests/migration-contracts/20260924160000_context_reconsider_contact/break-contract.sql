-- Ship the legacy job-created body (re-run the contact's whole bucket, no
-- lead window, no sibling reopen, no relink stamp). The contract must catch it.
CREATE OR REPLACE FUNCTION public.context_job_created_reconsider() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM public.rerun_context_attribution(250,NEW.ghl_contact_id); RETURN NEW;
EXCEPTION WHEN OTHERS THEN RAISE WARNING 'context job reconsideration failed: %',SQLERRM; RETURN NEW;
END $$;
