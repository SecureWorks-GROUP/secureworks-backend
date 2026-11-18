-- The defect this fixes: a positional wrapper (no parameter names) cannot be
-- called by name, as PostgREST calls it.
DROP FUNCTION public.reconcile_item_raise_named(text,text,text,uuid[],jsonb,jsonb,text,uuid);
CREATE FUNCTION public.reconcile_item_raise_named(text,text,text,uuid[],jsonb,jsonb,text,uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SET search_path = '' AS $fn$
/* block */ BEGIN
  RETURN public.reconcile_item_raise($1, $2, $3, $4, $5, $6, $7, $8);
END $fn$;
GRANT EXECUTE ON FUNCTION public.reconcile_item_raise_named(text,text,text,uuid[],jsonb,jsonb,text,uuid) TO service_role;
