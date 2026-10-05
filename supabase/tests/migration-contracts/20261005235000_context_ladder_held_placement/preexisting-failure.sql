-- The rules ladder is no longer L1e's body (a change this migration was not
-- written against): the guard must refuse rather than overwrite it.
CREATE OR REPLACE FUNCTION public.resolve_context_attribution(e public.business_events,p_preview boolean,p_rules_on boolean)
RETURNS public.business_events LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 RETURN e;
END $$;
