-- Live changes nobody read: someone else's finish where the pass rule's should be, a function the
-- guard calls gone, and a policy function that is not this migration's. The guard must refuse and
-- name all three before replacing anything.
CREATE OR REPLACE FUNCTION public.context_ledger_finish(p_run_id uuid, p_lease_token uuid, p_generation_id uuid, p_outcome text, p_meta jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN RETURN jsonb_build_object('outcome', 'refused', 'reason', 'someone_elses_finish'); END $fn$;
DROP FUNCTION public.context_ledger_promote(uuid, text);
CREATE FUNCTION public.context_ledger_thin_rebuild_policy() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $fn$ SELECT '{}'::jsonb $fn$;
