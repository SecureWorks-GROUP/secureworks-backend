-- Deliberately put back the sweep's earlier rule: a shadow is promoted whatever it has not read
-- (the 9 Oct shape). The scan and the re-check under the row locks both lose the unread test;
-- everything else (flags, comment, grants) stays as this migration left it. contract.sql must fail
-- on it.
DO $break$
DECLARE def text;
 k1 text := 'coalesce(c.skip, CASE WHEN u.job_id IS NOT NULL THEN ''unread_rows'' END)';
 k2 text := 'WHEN EXISTS (SELECT 1 FROM public.context_ledger_evidence_rows(ARRAY[x.job_id], now()) r';
BEGIN
 def := pg_get_functiondef('public.context_ledger_promote_shadow(text,uuid[],integer)'::regprocedure);
 IF position(k1 IN def) = 0 OR position(k2 IN def) = 0 THEN
  RAISE EXCEPTION 'break-contract: the sweep''s unread rule was not found';
 END IF;
 EXECUTE replace(replace(def, k1, 'c.skip'), k2,
  'WHEN false AND EXISTS (SELECT 1 FROM public.context_ledger_evidence_rows(ARRAY[x.job_id], now()) r');
END $break$;
