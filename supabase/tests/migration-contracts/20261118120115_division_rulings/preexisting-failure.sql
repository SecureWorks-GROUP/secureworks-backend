CREATE OR REPLACE FUNCTION public.stock_division_option(p_division text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'changed'::text $$;
