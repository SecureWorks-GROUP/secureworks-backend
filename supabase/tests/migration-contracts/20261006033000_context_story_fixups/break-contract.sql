-- Deliberately take the not-received rule out of R7: a quote whose every email
-- bounced or failed waits on the customer's answer again. contract.sql must fail
-- on it (its sort-order and date sections still pass). The break phase runs on the
-- whole registered stack, so the live R7 is 20261006040000's when that case is
-- registered (its owner also says unknown when the customer was in touch after the
-- quote: story safety, fourth review), else this migration's; either rule is taken out.
DO $break$
DECLARE def text;
 key_033 text := 'CASE WHEN de.undelivered THEN ''us'' ELSE ''customer'' END, CASE WHEN de.undelivered THEN ''customer'' ELSE ''us'' END';
 key_040 text := 'CASE WHEN de.undelivered THEN ''us'' WHEN h.at IS NOT NULL THEN ''unknown'' ELSE ''customer'' END, '
                 || 'CASE WHEN de.undelivered THEN ''customer'' WHEN h.at IS NOT NULL THEN ''unknown'' ELSE ''us'' END';
BEGIN
 def := pg_get_functiondef('public.context_job_record_loops(uuid[],timestamptz)'::regprocedure);
 IF position(key_040 IN def) > 0 THEN
  EXECUTE replace(def, key_040, '''customer'', ''us''');
 ELSIF position(key_033 IN def) > 0 THEN
  EXECUTE replace(def, key_033, '''customer'', ''us''');
 ELSE
  RAISE EXCEPTION 'break-contract: the not-received owner rule was not found';
 END IF;
END $break$;
