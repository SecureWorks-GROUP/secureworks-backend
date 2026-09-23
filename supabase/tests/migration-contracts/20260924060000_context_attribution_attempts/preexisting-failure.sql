-- reserve_context_model_call has drifted from production's pre-image (a
-- hand-applied change nobody read) and a stray overload of the new error
-- recorder already exists. The guard must stop before replacing anything and
-- name both.
CREATE OR REPLACE FUNCTION public.reserve_context_model_call(p_phase text,p_run_id uuid,p_lease_token uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT '{"outcome":"drift"}'::jsonb $$;
CREATE FUNCTION public.record_attribution_error(p_event_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT '{}'::jsonb $$;
