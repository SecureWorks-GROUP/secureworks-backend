-- A live write that is not the definition the migration was written against (here one comment line differs): the
-- migration must refuse before it changes anything.
DO $p$ DECLARE v_def text := pg_get_functiondef('public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)'::regprocedure); BEGIN
 EXECUTE replace(v_def, '-- Pass 1: each item on its own.', '-- Pass 1: each item, on its own.');
END $p$;
