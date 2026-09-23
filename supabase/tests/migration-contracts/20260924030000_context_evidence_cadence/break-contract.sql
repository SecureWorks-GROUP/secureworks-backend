-- Ship K1 without the writer record: the trigger goes back to the live body,
-- so rows carry no written_as and nothing can tell a public-key row from a
-- service-role one. The contract must catch it.
CREATE OR REPLACE FUNCTION public.attribute_business_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.context_captured_at IS NULL THEN
    NEW.context_captured_at := clock_timestamp();
  END IF;
  NEW := public.resolve_context_attribution(NEW);
  RETURN NEW;
END $$;
