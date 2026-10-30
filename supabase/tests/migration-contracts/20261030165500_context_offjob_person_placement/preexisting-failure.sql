DO $$ DECLARE s text; BEGIN SELECT pg_get_functiondef('context_unplaced_for_job(uuid)'::regprocedure) INTO s; EXECUTE replace(s,'WITH job AS (','WITH job AS ( /* unrecognized source */'); END $$;
