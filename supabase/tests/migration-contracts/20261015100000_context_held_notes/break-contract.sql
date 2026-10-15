-- Remove the promised behaviour: a held message can no longer be cited, so the contract's
-- "on" section must fail where a held promise should open a not-certain item.
CREATE OR REPLACE FUNCTION public.context_ledger_held_cite(p_job_id uuid, p_cite jsonb)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
 SELECT jsonb_build_object('ok', false, 'code', 'held_not_candidate', 'detail', 'broken on purpose') $fn$;
COMMENT ON FUNCTION public.context_ledger_held_cite(uuid, jsonb) IS 'Held notes (20261015100000): broken on purpose.';
