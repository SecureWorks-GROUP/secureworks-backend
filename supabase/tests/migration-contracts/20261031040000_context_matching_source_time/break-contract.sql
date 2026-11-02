DO $$ DECLARE d text:=pg_get_functiondef('context_recon_job_items(uuid)'::regprocedure);BEGIN EXECUTE replace(d,'q.direction, public.context_recon_source_at(be)','q.direction, q.occurred_at');END $$;
