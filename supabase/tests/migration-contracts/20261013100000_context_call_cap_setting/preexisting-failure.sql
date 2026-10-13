-- Two live changes nobody read: the ledger budget read was edited in production after this
-- migration was written, and a new function started reading the day's cap from the bare policy.
-- Replacing the first would lose that edit; leaving the second would keep the old cap in one
-- place after a raise. The guard must refuse and name both at once, before touching anything.
DO $p$
DECLARE d text;
BEGIN
 d := pg_get_functiondef('public.context_ledger_budget()'::regprocedure);
 EXECUTE regexp_replace(d, 'END \$function\$', E' -- a live change nobody read\nEND $function$');
END $p$;
CREATE FUNCTION public.call_cap_contract_new_reader() RETURNS integer LANGUAGE sql STABLE AS
$f$ SELECT (public.context_cadence_policy() ->> 'model_call_cap')::integer $f$;
