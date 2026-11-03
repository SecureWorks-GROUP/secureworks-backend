-- Deliberately take the new question out of the reason step: a bank alert reads no_identity again, and the contract
-- must catch it.
DO $b$ DECLARE v_def text := pg_get_functiondef('public.context_bucket_reason_detail(public.business_events,jsonb)'::regprocedure); BEGIN
 EXECUTE replace(v_def, $o$ IF nj IS NOT NULL THEN RETURN d||nj; END IF;$o$, '');
END $b$;
