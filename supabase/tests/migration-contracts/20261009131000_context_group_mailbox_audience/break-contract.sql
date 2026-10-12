-- Deliberately take out the promise that a relabelled row is read again: the relabel keeps the
-- row's landed time (context_captured_at) where it was, everything else (labels, the kept original,
-- the comment, grants, attributes) as this migration left it. A reading built before the relabel
-- would then count the relabelled row as read and never be rebuilt; contract.sql must fail on it.
DO $b$
DECLARE d text;
BEGIN
 d := pg_get_functiondef('public.context_email_audience_backfill(boolean)'::regprocedure);
 IF position('context_captured_at = v_at' IN d) = 0 THEN
  RAISE EXCEPTION 'break: the landed time move is not in the live body';
 END IF;
 EXECUTE replace(d, 'context_captured_at = v_at', 'context_captured_at = b.context_captured_at');
END $b$;
