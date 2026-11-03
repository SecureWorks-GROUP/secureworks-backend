-- Deliberately take back the new transition key: a move naming the note it repeats is invalid_shape again, and the
-- contract must catch it.
DO $b$ DECLARE v_def text := pg_get_functiondef('public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)'::regprocedure); BEGIN
 EXECUTE replace(v_def, $o$'reason','replaced_by'))$o$, $n$'reason'))$n$);
END $b$;
