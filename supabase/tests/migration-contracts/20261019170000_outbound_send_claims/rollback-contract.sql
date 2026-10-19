-- The runner has just run the down migration against the forward stack, which
-- holds no claim rows, so it dropped the doors.
-- 1. Every door is gone; both tables, their guards and their rows are kept.
DO $$
BEGIN
  IF to_regclass('public.outbound_send_claims') IS NULL
     OR to_regclass('public.outbound_send_claim_events') IS NULL THEN
    RAISE EXCEPTION 'rollback contract: the rollback dropped a claim table';
  END IF;
  IF to_regprocedure('public.claim_outbound_send(text[], text, text, jsonb, integer)') IS NOT NULL
     OR to_regprocedure('public.extend_outbound_send_claim(text, text[], text, text, jsonb)') IS NOT NULL
     OR to_regprocedure('public.confirm_outbound_dispatch(text, text)') IS NOT NULL
     OR to_regprocedure('public.settle_outbound_send(text, text, jsonb, text, text)') IS NOT NULL
     OR to_regprocedure('public.reconcile_outbound_send(text, text, text, text, timestamptz, text)') IS NOT NULL
     OR to_regprocedure('public.read_outbound_send_holds(text[])') IS NOT NULL
     OR to_regprocedure('public.outbound_send_claim_insert(text[], text, text, jsonb, timestamptz, uuid, text, text)') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: a claim door is still there';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'outbound_send_claim_events_append_only')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'outbound_send_claims_no_truncate') THEN
    RAISE EXCEPTION 'rollback contract: the rollback dropped a guard on the kept tables';
  END IF;
END $$;
-- Re-running the rollback is a no-op.
\ir ../../../rollbacks/20261019170000_outbound_send_claims_down.sql

-- 2. With the doors back and an unresolved claim on record, the rollback refuses
-- and changes nothing.
\ir ../../../migrations/20261019170000_outbound_send_claims.sql
SET ROLE service_role;
SELECT public.claim_outbound_send(ARRAY['rollback:held'], 'rollback-a1', 'rollback-contract', '{}'::jsonb) ->> 'ok' AS claimed \gset
RESET ROLE;
\if :claimed
\else
  DO $$ BEGIN RAISE EXCEPTION 'rollback contract: the fixture claim was refused'; END $$;
\endif
\set ON_ERROR_STOP 0
\ir ../../../rollbacks/20261019170000_outbound_send_claims_down.sql
\set ON_ERROR_STOP 1
SELECT position('outbound send claims unresolved' IN :'LAST_ERROR_MESSAGE') > 0 AS down_refused \gset
\if :down_refused
\else
  DO $$ BEGIN RAISE EXCEPTION 'rollback contract: the rollback did not refuse an unresolved claim'; END $$;
\endif
DO $$
BEGIN
  IF to_regprocedure('public.reconcile_outbound_send(text, text, text, text, timestamptz, text)') IS NULL
     OR to_regprocedure('public.settle_outbound_send(text, text, jsonb, text, text)') IS NULL THEN
    RAISE EXCEPTION 'rollback contract: a refused rollback still dropped a door';
  END IF;
END $$;

-- 3. Once the claim is settled the rollback runs, and the row and its trail stay.
SET ROLE service_role;
SELECT public.settle_outbound_send('rollback-a1', 'sent', '{}'::jsonb);
RESET ROLE;
\ir ../../../rollbacks/20261019170000_outbound_send_claims_down.sql
DO $$
BEGIN
  IF to_regprocedure('public.claim_outbound_send(text[], text, text, jsonb, integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: the settled rollback kept a door';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.outbound_send_claims WHERE attempt_id = 'rollback-a1' AND state = 'sent')
     OR (SELECT count(*) FROM public.outbound_send_claim_events WHERE attempt_id = 'rollback-a1') < 2 THEN
    RAISE EXCEPTION 'rollback contract: the rollback lost a claim row or its trail';
  END IF;
END $$;

-- 4. The forward migration applies again over the kept tables.
BEGIN;
\ir ../../../migrations/20261019170000_outbound_send_claims.sql
DO $$
BEGIN
  IF to_regprocedure('public.claim_outbound_send(text[], text, text, jsonb, integer)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.outbound_send_claims WHERE attempt_id = 'rollback-a1') THEN
    RAISE EXCEPTION 'rollback contract: the forward migration did not re-apply over the kept rows';
  END IF;
END $$;
ROLLBACK;
