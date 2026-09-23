-- Roll back MN1 (20260924190000_money_open_book_sweep).
--
-- Behaviour rollback needs no migration: set feature flag money_open_book_v1
-- off and the sweep stops (money.md §12).
--
-- This down restores the F1b stub of context_money_status() (with its comment,
-- which F1b's own rollback checks), checked by md5 afterwards
-- (155104bfb08b8b3c2f98bdec089d4ee4), and drops context_money_open_book_mode()
-- and context_money_policy(). It deliberately KEEPS xero_invoices.xero_verified_at:
-- the MN1 xero-sync writes that column on every invoice upsert, so dropping it
-- while that code is deployed would make every invoice write fail. A reverted
-- xero-sync ignores the column. Drop it by hand only after the code rollback
-- is deployed. No row is touched. Refuses if a later money slice has already
-- replaced the money block (roll that slice back first).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_money_status()')) NOT IN ('7724232a153c9d795b5d4bcd26e3dd6b','155104bfb08b8b3c2f98bdec089d4ee4')
 THEN RAISE EXCEPTION 'mn1_rollback_refused: context_money_status is no longer the MN1 body; roll back its later owner first'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.context_money_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT NULL::jsonb $$;
COMMENT ON FUNCTION public.context_money_status() IS
 'F1b stub. Status block money, owned by money slice MN1, which replaces this body. Null means not built yet.';
REVOKE ALL ON FUNCTION public.context_money_status() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_money_status() TO service_role;

DROP FUNCTION IF EXISTS public.context_money_open_book_mode();
DROP FUNCTION IF EXISTS public.context_money_policy();

DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_money_status()'))<>'155104bfb08b8b3c2f98bdec089d4ee4'
 THEN RAISE EXCEPTION 'mn1_rollback_failed: context_money_status stub md5 mismatch'; END IF;
END $$;
