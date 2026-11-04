-- Break the supplier half of the rule: every supplier name now agrees with every other, so a bill from
-- another supplier that names the job gets through, and the contract must catch it.
CREATE OR REPLACE FUNCTION public.dispatch_supplier_name_key(p_name text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $fn$
  SELECT 'any supplier'::text
$fn$;
