-- Deliberately take the not-received rule out of R7: a quote whose every email
-- bounced or failed waits on the customer's answer again. contract.sql must fail
-- on it (its sort-order and date sections still pass).
DO $break$
DECLARE def text;
 key text := 'CASE WHEN de.undelivered THEN ''us'' ELSE ''customer'' END, CASE WHEN de.undelivered THEN ''customer'' ELSE ''us'' END';
BEGIN
 def := pg_get_functiondef('public.context_job_record_loops(uuid[],timestamptz)'::regprocedure);
 IF position(key IN def) = 0 THEN RAISE EXCEPTION 'break-contract: the not-received owner rule was not found'; END IF;
 EXECUTE replace(def, key, '''customer'', ''us''');
END $break$;
