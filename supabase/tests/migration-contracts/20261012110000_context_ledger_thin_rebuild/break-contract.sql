-- Deliberately take the guard out: the block still runs but no rebuild is ever thin, everything else
-- (the variables, the comment, grants, attributes) as this migration left it. A 6-note rebuild
-- replaces a 37-note live reading again; contract.sql must fail on it.
DO $b$
DECLARE d text;
BEGIN
 d := pg_get_functiondef('public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)'::regprocedure);
 IF position('AND v_new_items < (v_pol ->> ''min_share'')::numeric * v_live_items THEN' IN d) = 0 THEN
  RAISE EXCEPTION 'break: the thin rebuild test is not in the live body';
 END IF;
 EXECUTE replace(d, 'AND v_new_items < (v_pol ->> ''min_share'')::numeric * v_live_items THEN', 'AND false THEN');
END $b$;
