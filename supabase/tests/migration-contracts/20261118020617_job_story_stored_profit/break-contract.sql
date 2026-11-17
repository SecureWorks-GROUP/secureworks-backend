DO $break$
DECLARE f text;
BEGIN
 SELECT pg_get_functiondef('public.context_job_story_book(uuid,timestamptz)'::regprocedure) INTO f;
 EXECUTE replace(f, 'IF public.job_story_stored_profit_on() THEN', 'IF false THEN');
END $break$;
