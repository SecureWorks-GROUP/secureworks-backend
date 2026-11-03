-- A live reason step that is not the definition the migration was written against (here one comment word differs):
-- the migration must refuse before it changes anything.
DO $p$ DECLARE v_def text := pg_get_functiondef('public.context_bucket_reason_detail(public.business_events,jsonb)'::regprocedure); BEGIN
 EXECUTE replace(v_def, '-- No customer identity: a site address', '-- No customer identity: one site address');
END $p$;
