-- The lock backfill is a one-off DML pass, so the fixtures it acts on live in
-- setup.sql and this file only observes the result. Everything below, including
-- the deliberate second run of the migration, is rolled back.
BEGIN;

CREATE TEMP TABLE wo_lock_expected (assignment_id uuid PRIMARY KEY, invoiced_in uuid, why text NOT NULL)
ON COMMIT DROP;
INSERT INTO wo_lock_expected VALUES
  ('a4019f76-8b8c-4c7e-86bd-8ae0758e8635', 'e4000000-0000-4000-8000-000000000001',
   'paid invoice work order line did not lock the trade''s in-week card'),
  ('e5000000-0000-4000-8000-000000000002', NULL,
   'another trade''s card on the billed job was stamped'),
  ('e5000000-0000-4000-8000-000000000003', 'e4000000-0000-4000-8000-000000000002',
   'an already stamped card was overwritten'),
  ('e5000000-0000-4000-8000-000000000004', NULL,
   'a card outside the invoice week was stamped'),
  ('e5000000-0000-4000-8000-000000000005', NULL,
   'an ops-reject invoice stamped a card'),
  ('e5000000-0000-4000-8000-000000000006', NULL,
   'a draft invoice stamped a card'),
  ('e5000000-0000-4000-8000-000000000007', 'e4000000-0000-4000-8000-000000000005',
   'a live non-week commission line did not lock the trade''s past card'),
  ('e5000000-0000-4000-8000-000000000008', NULL,
   'a card scheduled after the non-week invoice was submitted was stamped'),
  ('e5000000-0000-4000-8000-000000000009', 'e4000000-0000-4000-8000-000000000006',
   'a weekly work-order scope line did not lock the trade''s in-week card'),
  ('e5000000-0000-4000-8000-000000000010', NULL,
   'a weekly deduction line stamped a card'),
  ('e5000000-0000-4000-8000-000000000011', NULL,
   'an hours line was treated as a work order line');

CREATE OR REPLACE FUNCTION pg_temp.assert_wo_lock_state(pass_label text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  mismatch record;
  events integer;
  event_row record;
BEGIN
  FOR mismatch IN
    SELECT e.why, e.invoiced_in AS expected, ja.invoiced_in AS actual
    FROM wo_lock_expected e
    JOIN public.job_assignments ja ON ja.id = e.assignment_id
    WHERE ja.invoiced_in IS DISTINCT FROM e.invoiced_in
    ORDER BY e.assignment_id
  LOOP
    RAISE EXCEPTION '%: % (expected %, got %)', pass_label, mismatch.why, mismatch.expected, mismatch.actual;
  END LOOP;

  IF (SELECT count(*) FROM wo_lock_expected e JOIN public.job_assignments ja ON ja.id = e.assignment_id) <> 11 THEN
    RAISE EXCEPTION '%: a fixture card is missing', pass_label;
  END IF;

  -- One business event per stamped card, and only for stamped cards.
  SELECT count(*) INTO events
  FROM public.business_events
  WHERE source = 'cio_trade_wo_backfill'
    AND event_type = 'trade_invoice.assignment_lock_backfilled';
  IF events <> 3 THEN
    RAISE EXCEPTION '%: expected 3 backfill events, found %', pass_label, events;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.business_events be
    LEFT JOIN wo_lock_expected e ON e.assignment_id::text = be.entity_id
    WHERE be.source = 'cio_trade_wo_backfill'
      AND (e.invoiced_in IS NULL OR be.entity_type <> 'job_assignment')
  ) THEN
    RAISE EXCEPTION '%: a backfill event names a card that must not be stamped', pass_label;
  END IF;

  SELECT be.job_id, be.payload INTO event_row
  FROM public.business_events be
  WHERE be.source = 'cio_trade_wo_backfill'
    AND be.entity_id = 'a4019f76-8b8c-4c7e-86bd-8ae0758e8635';
  IF event_row.job_id IS DISTINCT FROM 'e2000000-0000-4000-8000-000000000001'::uuid THEN
    RAISE EXCEPTION '%: backfill event did not carry the job uuid (got %)', pass_label, event_row.job_id;
  END IF;
  IF event_row.payload->>'invoice_id' IS DISTINCT FROM 'e4000000-0000-4000-8000-000000000001'
     OR event_row.payload->>'invoice_number' IS DISTINCT FROM 'SW-INV-A-260830-025'
     OR event_row.payload->>'line_type' IS DISTINCT FROM 'work order' THEN
    RAISE EXCEPTION '%: backfill event does not identify the invoice and line it locked from: %',
      pass_label, event_row.payload;
  END IF;
END;
$$;

SELECT pg_temp.assert_wo_lock_state('first pass');

-- Invoice headers, lines and job card statuses are money and dispatch facts the
-- backfill must never move.
DO $$
BEGIN
  IF (SELECT string_agg(invoice_number || '=' || status, ',' ORDER BY invoice_number)
      FROM public.trade_invoices WHERE invoice_number LIKE 'SW-INV-A-%')
     IS DISTINCT FROM
     'SW-INV-A-260830-025=paid,SW-INV-A-WOLOCK-COMMISSION=pushed_to_xero,'
     'SW-INV-A-WOLOCK-DRAFT=draft,SW-INV-A-WOLOCK-HELD=pushed_to_xero,'
     'SW-INV-A-WOLOCK-REJECT=ops-reject,SW-INV-A-WOLOCK-WEEKLY=pending_acknowledgment' THEN
    RAISE EXCEPTION 'the backfill changed a trade invoice status';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.job_assignments
    WHERE id IN (SELECT assignment_id FROM wo_lock_expected)
      AND status <> CASE
        WHEN id IN ('e5000000-0000-4000-8000-000000000004', 'e5000000-0000-4000-8000-000000000008')
          THEN 'scheduled' ELSE 'complete' END
  ) THEN
    RAISE EXCEPTION 'the backfill changed a job card status';
  END IF;
END;
$$;

-- Re-running the real migration is a no-op: the invoiced_in IS NULL guard
-- matches nothing, so no card moves and no second event is written.
\ir ../../../migrations/20260911080000_trade_wo_lines_lock_assignments.sql

SELECT pg_temp.assert_wo_lock_state('second pass');

ROLLBACK;
