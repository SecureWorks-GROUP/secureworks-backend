-- A capture policy that is not the 3 Nov live definition: the migration must refuse, not overwrite it.
CREATE OR REPLACE FUNCTION public.context_source_freshness_policy() RETURNS jsonb
 LANGUAGE sql IMMUTABLE SET search_path TO 'pg_catalog' AS $f$ SELECT '{"quiet_business_minutes":120}'::jsonb $f$;
