-- 2026-09-11 (CIO): jobs that already took a deposit read as "no deposit".
--
-- jobs.deposit_at was only ever written as a side effect of a human moving a
-- job into status 'deposit' (ops-api update_job_status). A job that took its
-- deposit while sitting in any other status kept deposit_at null forever, so
-- the sales desks and BOOKKEEPING disagreed about the same money.
-- SWF-261334 is the case that surfaced it: at order_materials, deposit invoice
-- PAID in Xero, deposit_at null.
--
-- xero-sync now stamps deposit_at when it sees a deposit invoice go PAID, but
-- an invoice that was ALREADY paid never re-enters the incremental window and
-- is never picked up by the stale reconciler (which only looks at AUTHORISED /
-- SUBMITTED rows). Without this one-off pass the existing backlog, SWF-261334
-- included, would never be stamped.
--
-- Rules, identical to the runtime stamp:
--   * only the job's OWN deposit invoice (jobs.deposit_invoice_id) counts;
--   * only ACCREC invoices Xero reports as PAID;
--   * only jobs whose deposit_at is still null. An existing stamp is never
--     overwritten;
--   * jobs.status is never touched. Status transitions belong to the desks.
-- Re-running this migration is harmless: the deposit_at IS NULL guard makes the
-- second pass match nothing.

-- The runtime stamp looks a job up by deposit_invoice_id on every PAID ACCREC
-- invoice. Only a few thousand jobs carry one, so keep the index partial.
CREATE INDEX IF NOT EXISTS jobs_deposit_invoice_id_idx
  ON public.jobs (deposit_invoice_id)
  WHERE deposit_invoice_id IS NOT NULL;

-- fully_paid_on is a date in the cache, so the stamp lands at the start of the
-- day Xero says the invoice was settled. When Xero recorded no such date we
-- fall back to when the cached invoice last changed, and the event says which
-- of the two the stamp came from.
WITH stamped AS (
  UPDATE public.jobs j
  SET deposit_at = COALESCE(x.fully_paid_on::timestamptz, x.updated_at),
      updated_at = now()
  FROM public.xero_invoices x
  WHERE x.xero_invoice_id = j.deposit_invoice_id
    AND x.org_id = j.org_id
    AND x.invoice_type = 'ACCREC'
    AND x.status = 'PAID'
    AND j.deposit_invoice_id IS NOT NULL
    AND j.deposit_at IS NULL
  RETURNING
    j.id AS job_id,
    j.job_number,
    j.deposit_at,
    x.xero_invoice_id,
    x.invoice_number,
    x.fully_paid_on
)
INSERT INTO public.business_events (
  event_type, source, entity_type, entity_id, job_id, payload
)
SELECT
  'job.deposit_stamped',
  'cio_deposit_backfill',
  'invoice',
  s.xero_invoice_id,
  COALESCE(s.job_number, s.job_id::text),
  jsonb_build_object(
    'invoice_number', s.invoice_number,
    'deposit_at', s.deposit_at,
    'timestamp_source',
      CASE WHEN s.fully_paid_on IS NOT NULL THEN 'fully_paid_on' ELSE 'invoice_updated_at' END,
    'backfill', true
  )
FROM stamped s;
