-- Put back 1107's rule (any person source with a non-blank actor is a person).
-- The contract must fail on the first placeholder it reads as a person.
CREATE OR REPLACE FUNCTION public.cfo_recorded_person(p_source text, p_actor text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(p_source IN ('manual_queue', 'manual_split'), false) AND NULLIF(btrim(p_actor), '') IS NOT NULL
$$;
