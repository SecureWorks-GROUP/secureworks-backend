CREATE OR REPLACE FUNCTION public.context_ledger_close_on_records(uuid,boolean DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"wrote":false,"would_close":1,"closed":0}'::jsonb $$;
