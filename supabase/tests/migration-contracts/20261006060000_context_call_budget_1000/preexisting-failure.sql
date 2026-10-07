-- A live change nobody read: the admission and the policy were edited in
-- production after this migration was written. The guard must refuse to
-- replace either, and name both at once.
DO $p$
DECLARE d text; src text;
BEGIN
 d := pg_get_functiondef('public.reserve_context_model_call(text,uuid,uuid)'::regprocedure);
 EXECUTE regexp_replace(d, 'END \$function\$', E' -- a live change nobody read\nEND $function$');
 SELECT prosrc INTO src FROM pg_proc WHERE oid = 'public.context_cadence_policy()'::regprocedure;
 EXECUTE format('CREATE OR REPLACE FUNCTION public.context_cadence_policy() RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS %L',
  replace(src, $o$'morning_until','12:00'$o$, $n$'morning_until','11:00'$n$));
END $p$;
