-- Deliberately drop the priced extras from the quote line again (the 11 Oct shape, where SWF-261469's
-- $240 extra never reached the reader); the scope summary stays. Everything else (flags, comment,
-- grants, the vision policy) stays as this migration left it.
-- contract.sql must fail on it.
DO $break$
DECLARE def text;
 k text := '                || coalesce(''; extras: '' || s.extras, '''') AS w';
BEGIN
 def := pg_get_functiondef('public.context_job_record_timeline(uuid[],timestamptz)'::regprocedure);
 IF position(k IN def) = 0 THEN
  RAISE EXCEPTION 'break-contract: the record scope words were not found';
 END IF;
 EXECUTE replace(def, k, '                || '''' AS w');
END $break$;
