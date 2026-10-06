-- Deliberately take the no-all-clear rule out: without a live reading of every row on
-- the job, nothing open on record is nobody's move again (the launch state the
-- records-only grade failed). contract.sql must fail on it.
DO $break$
DECLARE def text; key text := 'WHEN NOT (SELECT led.words_read FROM led) THEN ''unknown''';
BEGIN
 def := pg_get_functiondef('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)'::regprocedure);
 IF position(key IN def) = 0 THEN RAISE EXCEPTION 'break-contract: the no-all-clear rule was not found'; END IF;
 EXECUTE replace(def, key, 'WHEN false THEN ''unknown''');
END $break$;
