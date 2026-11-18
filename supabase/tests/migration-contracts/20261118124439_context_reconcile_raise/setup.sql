-- CI: registered prerequisites already hold P2-03.1, P2-03.2 and Phase 4's
-- four subject tables. Isolated local proof builds them from their migrations
-- (plus minimal users and business_events table shapes). No function stand-ins.
SELECT to_regprocedure('public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text)') IS NULL AS isolated_p4_01_6_setup \gset
\if :isolated_p4_01_6_setup
\ir ../20261118073218_reconcile_item_raise/setup.sql
\ir ../../../migrations/20261118073218_reconcile_item_raise.sql
\endif

SELECT to_regclass('public.users') IS NULL AS p4_01_6_needs_users \gset
\if :p4_01_6_needs_users
CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  org_id uuid,
  name text,
  role text
);
\endif

SELECT to_regclass('public.business_events') IS NULL AS p4_01_6_needs_events \gset
\if :p4_01_6_needs_events
CREATE TABLE public.business_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL DEFAULT 'message',
  source text NOT NULL DEFAULT 'zztest',
  entity_type text NOT NULL DEFAULT 'message',
  entity_id text NOT NULL DEFAULT 'zztest',
  job_id uuid,
  candidate_job_ids uuid[],
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
\endif

SELECT to_regclass('public.context_extraction_runs') IS NULL AS p4_01_6_needs_runs \gset
\if :p4_01_6_needs_runs
CREATE TABLE public.context_extraction_runs (id uuid PRIMARY KEY);
\endif

SELECT to_regclass('public.context_ledger_items') IS NULL AS p4_01_6_needs_ledger \gset
\if :p4_01_6_needs_ledger
\ir ../../../migrations/20261006010000_context_ledger_model.sql
\endif

SELECT to_regclass('public.agent_action_proposals') IS NULL AS p4_01_6_needs_proposals \gset
\if :p4_01_6_needs_proposals
\ir ../../../migrations/20261117172001_agent_action_proposals.sql
\endif

SELECT to_regclass('public.context_ai_calls') IS NULL AS p4_01_6_needs_ai_calls \gset
\if :p4_01_6_needs_ai_calls
\ir ../../../migrations/20261117173601_context_ai_calls.sql
\endif

-- CI stack walk: P4-02.3's setup (20261117195203) creates a five-argument
-- context_reconcile_raise stand-in, a void context_reconcile_withdraw stand-in,
-- and record_close_fixture_queue when the real adapter is not yet registered.
-- Remove only those stand-ins by their body so this migration's install guard
-- meets an empty name, as on live, and 20261117195203's contract uses the real
-- adapter once registered.
DO $standin$
/* block */ BEGIN
  IF (SELECT prosrc FROM pg_proc
      WHERE oid = to_regprocedure('public.context_reconcile_raise(text,uuid,text,text,jsonb)'))
     LIKE '%record_close_fixture_queue%' THEN
    DROP FUNCTION public.context_reconcile_raise(text,uuid,text,text,jsonb);
  END IF;
  IF (SELECT prosrc FROM pg_proc
      WHERE oid = to_regprocedure('public.context_reconcile_withdraw(text,text,text)'))
     LIKE '%record_close_fixture_queue%' THEN
    DROP FUNCTION public.context_reconcile_withdraw(text,text,text);
  END IF;
  IF to_regclass('public.record_close_fixture_queue') IS NOT NULL
     AND to_regprocedure('public.context_reconcile_raise(text,uuid,text,text,jsonb)') IS NULL THEN
    DROP TABLE public.record_close_fixture_queue;
  END IF;
END $standin$;
