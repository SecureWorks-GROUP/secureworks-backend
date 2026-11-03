-- A v_job_profit that is not production's 20261104080000 definition (one more column after the last): the migration
-- must refuse rather than edit a definition it was not written against.
DO $$
DECLARE
  v_def text := pg_get_viewdef('public.v_job_profit'::regclass, true);
BEGIN
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_profit AS '
    || replace(v_def, E'        END AS expected_cost_missing\n   FROM flagged f;', E'        END AS expected_cost_missing,\n    1 AS another_change\n   FROM flagged f;');
END $$;
