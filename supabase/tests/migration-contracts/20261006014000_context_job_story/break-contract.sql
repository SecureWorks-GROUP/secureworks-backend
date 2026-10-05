-- Deliberately break the promotion rule: no ledger item can say a reply is owed, so
-- an R5 candidate is never promoted. contract.sql must fail on job A's top loop.
DO $break$
DECLARE def text; key text := '(coalesce(v.needs_reply, false) OR v.item_type = ''request'')';
BEGIN
 def := pg_get_functiondef('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)'::regprocedure);
 IF position(key IN def) = 0 THEN RAISE EXCEPTION 'break-contract: the promotion rule was not found'; END IF;
 EXECUTE replace(def, key, 'false');
END $break$;
