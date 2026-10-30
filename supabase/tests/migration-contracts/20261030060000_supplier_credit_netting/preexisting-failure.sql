-- Another slice replaced v_job_cost_events first: the migration must refuse
-- rather than overwrite that body with its own.
COMMENT ON VIEW public.v_job_cost_events IS 'Job profit engine (another slice): a body this migration was not built on.';
