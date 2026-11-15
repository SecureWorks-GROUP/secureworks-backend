-- Deliberately stop a named reason holding the close: a finished job with a bill still missing (no materials
-- linked, no cost at all, an open order) would be called final once it had been quiet. The contract must fail.
DO $$
DECLARE d text := pg_get_functiondef('public.job_cost_close(uuid[],date)'::regprocedure);
        old constant text := 'WHEN cardinality(g.cost_reasons) > 0 OR g.quiet_from IS NULL THEN ''waiting''';
BEGIN
  IF position(old IN d) = 0 THEN
    RAISE EXCEPTION 'break: the waiting rule was not found';
  END IF;
  EXECUTE replace(d, old, 'WHEN g.quiet_from IS NULL THEN ''waiting''');
END $$;
