-- A live ladder entry nobody read: the guard must refuse to replace it.
CREATE OR REPLACE FUNCTION public.attribute_business_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- hand-applied change
  NEW := public.resolve_context_attribution(NEW);
  RETURN NEW;
END $$;
