-- A later unrelated body change must refuse even though the facts token survives.
DO $drift$
DECLARE definition text := pg_get_functiondef('public.context_worker_state()'::regprocedure);
BEGIN
  EXECUTE replace(definition, '''marks_newest'', public.context_worker_marks_newest()',
    '''marks_newest'', NULL');
END $drift$;
