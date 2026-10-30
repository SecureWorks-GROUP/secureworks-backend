-- Put back the 20260504090757 lock condition (frozen only), so a superseded
-- row's contract columns can change again. The contract must fail.
DO $$
DECLARE d text := pg_get_functiondef('public.scope_revisions_controlled_immutable()'::regprocedure);
BEGIN
  IF position('IF OLD.status IN (''frozen'',''superseded'') THEN' IN d) = 0 THEN
    RAISE EXCEPTION 'break: superseded lock not found';
  END IF;
  EXECUTE replace(d, 'IF OLD.status IN (''frozen'',''superseded'') THEN', 'IF OLD.status = ''frozen'' THEN');
END $$;
