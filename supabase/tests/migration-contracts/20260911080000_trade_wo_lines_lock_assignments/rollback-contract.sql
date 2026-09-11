-- Runs after supabase/rollbacks/20260911080000_trade_wo_lines_lock_assignments_down.sql
-- against the exact forward stack it reverses.
--
-- The forward pass is DML, so the down migration reverses stamps, not objects.
-- It must release EXACTLY the three cards the backfill stamped and nothing
-- else: a stamp that predates the backfill is someone else's money record.
BEGIN;

DO $$
DECLARE
  still_held text;
  wrongly_released text;
  reverts integer;
BEGIN
  SELECT string_agg(id::text, ',' ORDER BY id) INTO still_held
  FROM public.job_assignments
  WHERE id IN (
    'a4019f76-8b8c-4c7e-86bd-8ae0758e8635',
    'e5000000-0000-4000-8000-000000000007',
    'e5000000-0000-4000-8000-000000000009'
  ) AND invoiced_in IS NOT NULL;
  IF still_held IS NOT NULL THEN
    RAISE EXCEPTION 'the down migration left a backfilled card stamped: %', still_held;
  END IF;

  -- Stamped by the fixture, never by the backfill. The down must not touch it.
  SELECT string_agg(id::text, ',' ORDER BY id) INTO wrongly_released
  FROM public.job_assignments
  WHERE id = 'e5000000-0000-4000-8000-000000000003'
    AND invoiced_in IS DISTINCT FROM 'e4000000-0000-4000-8000-000000000002'::uuid;
  IF wrongly_released IS NOT NULL THEN
    RAISE EXCEPTION 'the down migration released a card the backfill never stamped: %', wrongly_released;
  END IF;

  SELECT count(*) INTO reverts
  FROM public.business_events
  WHERE source = 'cio_trade_wo_backfill'
    AND event_type = 'trade_invoice.assignment_lock_backfill_reverted';
  IF reverts <> 3 THEN
    RAISE EXCEPTION 'expected 3 revert events, found %', reverts;
  END IF;

  -- The forward events stay: the money trail is append-only.
  IF (SELECT count(*) FROM public.business_events
      WHERE source = 'cio_trade_wo_backfill'
        AND event_type = 'trade_invoice.assignment_lock_backfilled') <> 3 THEN
    RAISE EXCEPTION 'the down migration deleted the forward backfill events';
  END IF;
END;
$$;

-- Running the down a second time is a no-op.
\ir ../../../rollbacks/20260911080000_trade_wo_lines_lock_assignments_down.sql

DO $$
BEGIN
  IF (SELECT count(*) FROM public.business_events
      WHERE source = 'cio_trade_wo_backfill'
        AND event_type = 'trade_invoice.assignment_lock_backfill_reverted') <> 3 THEN
    RAISE EXCEPTION 'a second down pass wrote more revert events';
  END IF;
END;
$$;

ROLLBACK;
