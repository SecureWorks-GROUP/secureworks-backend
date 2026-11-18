-- A reconcile_undo body that is neither main's nor this migration's. The
-- contract's first statement re-applies the migration, whose guard refuses it.
CREATE OR REPLACE FUNCTION public.reconcile_undo(p_decision_id bigint, p_user_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $fn$ SELECT '{}'::jsonb $fn$;
