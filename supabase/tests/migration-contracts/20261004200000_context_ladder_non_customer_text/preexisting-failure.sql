-- The rules-off ladder is no longer L1b's body (a change this migration was
-- not written against): the guard must refuse rather than overwrite it.
CREATE OR REPLACE FUNCTION public.context_ladder_p1a(e public.business_events,p_preview boolean) RETURNS public.business_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 RETURN e;
END $$;
