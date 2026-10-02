-- The two network-reaching Group A functions are closed to the public key:
-- anon and authenticated are refused, service_role and postgres (pg_cron)
-- still run them, a postgres-owned definer chain still reaches them, and the
-- pre-apply ACLs were snapshotted for the rollback.
DO $$
DECLARE
  v_sig text;
  v_fn regprocedure;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.send_outlook_email_b64(text,text,text,text,text,text,text)',
    'public.deliver_proposed_actions()'
  ]
  LOOP
    v_fn := to_regprocedure(v_sig);
    IF v_fn IS NULL THEN
      RAISE EXCEPTION 'group A urgent contract: % was dropped', v_sig;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) THEN
      RAISE EXCEPTION 'group A urgent contract: % is no longer SECURITY DEFINER', v_sig;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'group A urgent contract: anon can still execute %', v_sig;
    END IF;
    IF has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'group A urgent contract: authenticated can still execute %', v_sig;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
               WHERE p.oid = v_fn AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
      RAISE EXCEPTION 'group A urgent contract: PUBLIC still holds execute on %', v_sig;
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'group A urgent contract: service_role lost execute on %', v_sig;
    END IF;
    IF NOT has_function_privilege('postgres', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'group A urgent contract: postgres lost execute on %', v_sig;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.function_grant_snapshots s
      WHERE s.migration = '20261002200100' AND to_regprocedure(s.signature) = v_fn
        AND EXISTS (SELECT 1 FROM aclexplode(s.proacl) a
                    WHERE a.grantee = 'anon'::regrole AND a.privilege_type = 'EXECUTE')
    ) THEN
      RAISE EXCEPTION 'group A urgent contract: no pre-apply snapshot for %', v_sig;
    END IF;
  END LOOP;
  IF has_table_privilege('anon', 'public.function_grant_snapshots', 'SELECT')
     OR has_table_privilege('authenticated', 'public.function_grant_snapshots', 'SELECT') THEN
    RAISE EXCEPTION 'group A urgent contract: the grant snapshot table is readable by the public key';
  END IF;
END $$;

-- anon and authenticated: a real call of each function is refused.
BEGIN;
SET LOCAL ROLE anon;
DO $$
BEGIN
  BEGIN
    PERFORM public.send_outlook_email_b64('a@example.com', 's', 'b', 'eA==', 'f.pdf');
    RAISE EXCEPTION 'group A urgent contract: anon send_outlook_email_b64 was not refused';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.deliver_proposed_actions();
    RAISE EXCEPTION 'group A urgent contract: anon deliver_proposed_actions was not refused';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.send_outlook_email_b64('a@example.com', 's', 'b', 'eA==', 'f.pdf');
    RAISE EXCEPTION 'group A urgent contract: authenticated send_outlook_email_b64 was not refused';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.deliver_proposed_actions();
    RAISE EXCEPTION 'group A urgent contract: authenticated deliver_proposed_actions was not refused';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;

-- service_role (edge functions) still runs both as the owner.
BEGIN;
SET LOCAL ROLE service_role;
DO $$
BEGIN
  PERFORM public.send_outlook_email_b64('a@example.com', 's', 'b', 'eA==', 'f.pdf');
  PERFORM public.deliver_proposed_actions();
END $$;
RESET ROLE;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.group_a_contract_calls
      WHERE fn IN ('send_outlook_email_b64', 'deliver_proposed_actions')) <> 2 THEN
    RAISE EXCEPTION 'group A urgent contract: service_role calls did not run';
  END IF;
END $$;
ROLLBACK;

-- postgres (the owner, and the role every pg_cron job runs as) still runs it.
BEGIN;
SELECT public.deliver_proposed_actions();
ROLLBACK;

-- A postgres-owned SECURITY DEFINER chain reaches the revoked function even
-- when its caller is service_role, because the inner call runs as the owner.
BEGIN;
CREATE FUNCTION public.group_a_contract_chain() RETURNS integer
LANGUAGE sql SECURITY DEFINER AS $$ SELECT public.deliver_proposed_actions() $$;
REVOKE ALL ON FUNCTION public.group_a_contract_chain() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.group_a_contract_chain() TO service_role;
SET LOCAL ROLE service_role;
DO $$
BEGIN
  IF public.group_a_contract_chain() <> 1 THEN
    RAISE EXCEPTION 'group A urgent contract: definer chain did not reach deliver_proposed_actions';
  END IF;
END $$;
ROLLBACK;
