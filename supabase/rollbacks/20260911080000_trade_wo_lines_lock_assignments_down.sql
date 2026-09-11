-- Down for 20260911080000_trade_wo_lines_lock_assignments.
--
-- The forward migration is a one-off DML pass, so this cannot simply drop an
-- object. It reverses precisely the stamps that pass made, and nothing else:
-- every stamped card left a 'trade_invoice.assignment_lock_backfilled' event
-- from source 'cio_trade_wo_backfill' naming the card and the invoice it was
-- stamped to. A card is released ONLY when its invoiced_in still equals the
-- invoice that event recorded, so a later runtime stamp, a re-assignment or an
-- operator correction is left alone.
--
-- The reversal events stay in business_events: the money trail is append-only.
-- Running this twice is harmless — the second pass matches nothing because the
-- cards no longer carry the backfilled invoice id.

WITH backfilled AS (
  SELECT DISTINCT
    be.entity_id::uuid                       AS assignment_id,
    (be.payload->>'invoice_id')::uuid        AS invoice_id
  FROM public.business_events be
  WHERE be.source = 'cio_trade_wo_backfill'
    AND be.event_type = 'trade_invoice.assignment_lock_backfilled'
    AND be.entity_type = 'job_assignment'
    AND be.payload->>'invoice_id' IS NOT NULL
),
released AS (
  UPDATE public.job_assignments ja
  SET invoiced_in = NULL
  FROM backfilled b
  WHERE ja.id = b.assignment_id
    AND ja.invoiced_in = b.invoice_id
  RETURNING ja.id AS assignment_id, ja.job_id, b.invoice_id
)
INSERT INTO public.business_events (
  event_type, source, entity_type, entity_id, job_id, payload
)
SELECT
  'trade_invoice.assignment_lock_backfill_reverted',
  'cio_trade_wo_backfill',
  'job_assignment',
  r.assignment_id::text,
  r.job_id,
  jsonb_build_object('invoice_id', r.invoice_id, 'rollback', true)
FROM released r;
