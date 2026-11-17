CREATE OR REPLACE FUNCTION public.supplier_name_key(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT p $$;
