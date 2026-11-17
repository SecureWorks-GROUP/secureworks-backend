DO $$ DECLARE d text; BEGIN
  d := pg_get_viewdef('public.v_job_revenue_events'::regclass,true);
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_revenue_events AS SELECT * FROM (' || trim(trailing ';' FROM d) || ') unknown_definition WHERE false';
END $$;
