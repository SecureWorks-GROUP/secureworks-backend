-- Named door onto reconcile_item_raise (director, 18 Nov 2026 16:40).
-- Both reconcile_item_raise overloads declare their arguments by position
-- (proargnames is null), so a PostgREST call with named arguments, which is
-- the only way supabase-js calls an rpc, finds no function (PGRST202). This
-- adds ONE wrapper with named parameters that calls the eight-argument form by
-- position. It replaces nothing: the two existing overloads keep their
-- positional signatures, because later positional re-creates and the contract
-- stand-ins depend on them.
-- Creates one function only: no table, column, trigger, schedule, switch or
-- row write. Granted to service_role only.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Install guard: the eight-argument form this calls must exist, and the name
-- must be free or hold only this file's own signature (so re-applying is a
-- no-op replace of the same body).
DO $guard$
DECLARE r record;
/* block */ BEGIN
  IF pg_catalog.to_regprocedure('public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'reconcile_item_raise_named: reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text,uuid) is missing; apply 20261118124439 first';
  END IF;
  FOR r IN SELECT p.oid::regprocedure::text AS sig
    FROM pg_catalog.pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'reconcile_item_raise_named'
  LOOP
    IF r.sig <> 'reconcile_item_raise_named(text,text,text,uuid[],jsonb,jsonb,text,uuid)' THEN
      RAISE EXCEPTION 'reconcile_item_raise_named: % already exists; refusing to add an overload', r.sig;
    END IF;
  END LOOP;
END $guard$;

-- Same arguments, in the same order, as reconcile_item_raise; p_org_id is
-- optional, so a seven-argument named call works unchanged. Every rule, the
-- organisation check and the idempotency stay in reconcile_item_raise.
CREATE OR REPLACE FUNCTION public.reconcile_item_raise_named(
  p_kind text,
  p_subject_table text,
  p_subject_id text,
  p_job_ids uuid[],
  p_suggestion jsonb,
  p_evidence jsonb,
  p_raised_by text,
  p_org_id uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = '' AS $fn$
/* block */ BEGIN
  RETURN public.reconcile_item_raise(
    p_kind, p_subject_table, p_subject_id, p_job_ids,
    p_suggestion, p_evidence, p_raised_by, p_org_id);
END $fn$;

COMMENT ON FUNCTION public.reconcile_item_raise_named(text,text,text,uuid[],jsonb,jsonb,text,uuid) IS
  'Named-argument door onto reconcile_item_raise for PostgREST callers (supabase-js rpc). Calls the eight-argument form by position; adds no rule of its own. Service role only.';

REVOKE ALL ON FUNCTION public.reconcile_item_raise_named(text,text,text,uuid[],jsonb,jsonb,text,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_item_raise_named(text,text,text,uuid[],jsonb,jsonb,text,uuid)
  TO service_role;
