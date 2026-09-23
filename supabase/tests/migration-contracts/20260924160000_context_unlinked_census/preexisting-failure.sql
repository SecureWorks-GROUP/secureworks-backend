-- A function of a B0 name that B0 did not write (a hand-applied live change)
-- must stop the migration rather than be silently replaced.
CREATE FUNCTION public.context_phone_key(p_phone text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT right(p_phone,9) $$;
