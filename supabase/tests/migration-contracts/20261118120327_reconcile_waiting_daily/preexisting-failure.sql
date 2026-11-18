CREATE FUNCTION public.reconcile_waiting_summary()
RETURNS jsonb LANGUAGE sql AS $foreign$
  SELECT '{}'::jsonb;
$foreign$;
