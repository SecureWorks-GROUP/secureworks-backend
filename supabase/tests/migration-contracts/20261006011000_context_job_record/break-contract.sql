-- Deliberately break the record layer's who-to-whom rule: every message is
-- treated as customer-facing, so a crew alert counts as a reply to the customer.
-- contract.sql must then fail on job A's loops.
DO $break$
DECLARE def text;
BEGIN
 def := pg_get_functiondef('public.context_job_record_messages(uuid[],timestamptz)'::regprocedure);
 IF position('(l.is_msg AND CASE WHEN l.rr IS NOT NULL THEN false' IN def) = 0 THEN
  RAISE EXCEPTION 'break-contract: the customer-facing rule was not found';
 END IF;
 EXECUTE replace(def, '(l.is_msg AND CASE WHEN l.rr IS NOT NULL THEN false', '(l.is_msg OR CASE WHEN l.rr IS NOT NULL THEN false');
END $break$;
