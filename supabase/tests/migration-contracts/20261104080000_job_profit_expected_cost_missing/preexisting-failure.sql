-- A v_job_profit that is not production's 20261103171500 definition (one more column after the last): the migration
-- must refuse rather than edit a definition it was not written against.
DO $$
DECLARE
  v_def text := pg_get_viewdef('public.v_job_profit'::regclass, true);
BEGIN
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_profit AS '
    || replace(v_def, E'    invoice_emailed_ex\n   FROM flagged f;', E'    invoice_emailed_ex,\n    1 AS another_change\n   FROM flagged f;');
END $$;
