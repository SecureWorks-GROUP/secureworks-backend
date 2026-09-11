-- The deposit backfill is a one-off DML pass, so the fixtures it acts on live
-- in setup.sql and this file only observes the result. Fixture writes below are
-- wrapped so nothing leaks into the next contract.
BEGIN;

DO $$
DECLARE
  stamped_with_date timestamptz;
  stamped_fallback timestamptz;
  unpaid timestamptz;
  already timestamptz;
  no_invoice timestamptz;
  other_org timestamptz;
  statuses text;
  events integer;
  source_label text;
  index_definition text;
BEGIN
  SELECT deposit_at INTO stamped_with_date FROM public.jobs WHERE job_number = 'SWF-CONTRACT-PAID';
  SELECT deposit_at INTO stamped_fallback FROM public.jobs WHERE job_number = 'SWP-CONTRACT-NODATE';
  SELECT deposit_at INTO unpaid FROM public.jobs WHERE job_number = 'SWF-CONTRACT-UNPAID';
  SELECT deposit_at INTO already FROM public.jobs WHERE job_number = 'SWP-CONTRACT-STAMPED';
  SELECT deposit_at INTO no_invoice FROM public.jobs WHERE job_number = 'SWF-CONTRACT-NOINVOICE';
  SELECT deposit_at INTO other_org FROM public.jobs WHERE job_number = 'SWF-CONTRACT-OTHERORG';

  -- A paid deposit invoice stamps the day Xero settled it.
  IF stamped_with_date IS DISTINCT FROM '2026-09-01'::date::timestamptz THEN
    RAISE EXCEPTION 'paid deposit invoice did not stamp deposit_at (got %)', stamped_with_date;
  END IF;

  -- No FullyPaidOnDate falls back to when the cached invoice last changed.
  IF stamped_fallback IS DISTINCT FROM '2026-09-03T09:10:11Z'::timestamptz THEN
    RAISE EXCEPTION 'paid deposit invoice without a paid date did not fall back to updated_at (got %)', stamped_fallback;
  END IF;

  -- An unpaid deposit invoice is not a deposit.
  IF unpaid IS NOT NULL THEN
    RAISE EXCEPTION 'unpaid deposit invoice stamped deposit_at (got %)', unpaid;
  END IF;

  -- An existing stamp is never overwritten.
  IF already IS DISTINCT FROM '2026-08-01T03:04:05Z'::timestamptz THEN
    RAISE EXCEPTION 'an already stamped job was overwritten (got %)', already;
  END IF;

  -- A job with no deposit invoice is never touched.
  IF no_invoice IS NOT NULL THEN
    RAISE EXCEPTION 'a job with no deposit invoice was stamped (got %)', no_invoice;
  END IF;

  -- Another org's invoice cannot stamp this org's job.
  IF other_org IS NOT NULL THEN
    RAISE EXCEPTION 'a cross-org invoice stamped deposit_at (got %)', other_org;
  END IF;

  -- The backfill moves money facts, never the pipeline. Statuses are exactly
  -- what setup.sql wrote.
  SELECT string_agg(job_number || '=' || status, ',' ORDER BY job_number) INTO statuses
  FROM public.jobs WHERE job_number LIKE 'SW%-CONTRACT-%';
  IF statuses IS DISTINCT FROM
    'SWF-CONTRACT-NOINVOICE=quoted,SWF-CONTRACT-OTHERORG=processing,'
    'SWF-CONTRACT-PAID=order_materials,SWF-CONTRACT-UNPAID=deposit,'
    'SWP-CONTRACT-NODATE=processing,SWP-CONTRACT-STAMPED=scheduled' THEN
    RAISE EXCEPTION 'the deposit backfill changed a job status: %', statuses;
  END IF;

  -- One business event per stamped job, and only for the stamped jobs.
  SELECT count(*) INTO events
  FROM public.business_events
  WHERE source = 'cio_deposit_backfill' AND event_type = 'job.deposit_stamped';
  IF events <> 2 THEN
    RAISE EXCEPTION 'expected 2 backfill events, found %', events;
  END IF;

  SELECT payload->>'timestamp_source' INTO source_label
  FROM public.business_events
  WHERE source = 'cio_deposit_backfill' AND job_id = 'SWF-CONTRACT-PAID';
  IF source_label IS DISTINCT FROM 'fully_paid_on' THEN
    RAISE EXCEPTION 'backfill event did not record the provider timestamp source (got %)', source_label;
  END IF;

  SELECT payload->>'timestamp_source' INTO source_label
  FROM public.business_events
  WHERE source = 'cio_deposit_backfill' AND job_id = 'SWP-CONTRACT-NODATE';
  IF source_label IS DISTINCT FROM 'invoice_updated_at' THEN
    RAISE EXCEPTION 'fallback stamp was not recorded as a fallback (got %)', source_label;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.business_events
    WHERE source = 'cio_deposit_backfill'
      AND job_id = 'SWF-CONTRACT-PAID'
      AND entity_id = 'xinv-paid-with-date'
      AND entity_type = 'invoice'
      AND payload->>'invoice_number' = 'INV-9001'
  ) THEN
    RAISE EXCEPTION 'backfill event does not identify the invoice it stamped from';
  END IF;

  -- The runtime stamp looks jobs up by deposit_invoice_id on every paid ACCREC
  -- invoice, so the partial index has to exist.
  SELECT indexdef INTO index_definition
  FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'jobs_deposit_invoice_id_idx';
  IF index_definition IS NULL THEN
    RAISE EXCEPTION 'jobs_deposit_invoice_id_idx is missing';
  END IF;
  IF index_definition NOT LIKE '%deposit_invoice_id IS NOT NULL%' THEN
    RAISE EXCEPTION 'jobs_deposit_invoice_id_idx is not partial: %', index_definition;
  END IF;
END;
$$;

-- Re-running the backfill is a no-op: the deposit_at IS NULL guard matches
-- nothing the second time, so no job moves and no second event is written.
DO $$
DECLARE
  restamped integer;
BEGIN
  WITH second_pass AS (
    UPDATE public.jobs j
    SET deposit_at = COALESCE(x.fully_paid_on::timestamptz, x.updated_at)
    FROM public.xero_invoices x
    WHERE x.xero_invoice_id = j.deposit_invoice_id
      AND x.org_id = j.org_id
      AND x.invoice_type = 'ACCREC'
      AND x.status = 'PAID'
      AND j.deposit_invoice_id IS NOT NULL
      AND j.deposit_at IS NULL
    RETURNING j.id
  )
  SELECT count(*) INTO restamped FROM second_pass;
  IF restamped <> 0 THEN
    RAISE EXCEPTION 'the backfill is not idempotent: a second pass stamped % job(s)', restamped;
  END IF;
END;
$$;

ROLLBACK;
