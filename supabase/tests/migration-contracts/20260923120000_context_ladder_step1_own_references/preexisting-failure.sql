-- A live ladder body that is neither the repository pre-image nor the L1 body
-- (for example a hand-applied change) must stop the migration before it replaces it.
CREATE OR REPLACE FUNCTION public.resolve_context_attribution(e public.business_events) RETURNS public.business_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 -- hand-applied drift
 RETURN e;
END $$;
