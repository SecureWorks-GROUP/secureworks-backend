-- The staff release of a customer variation's Xero draft record
-- (reconcile_customer_variation_xero_draft, work_order_customer_variations.ts).
--
-- A customer variation's invoice record (work_order_customer_variation_invoices)
-- is claimed prepared -> creating before create_invoice_draft is called. When
-- Xero does not confirm the outcome the record is kept as `unknown`, and a
-- record whose confirmed outcome could not be saved stays `creating`. Neither
-- is ever retried automatically, because the draft may exist in Xero.
--
-- After a work order approver has checked Xero by hand, they answer for the
-- record: the draft exists (its Xero invoice id is recorded and the record
-- becomes `xero_draft_created`), or no draft was made (the record goes back to
-- `prepared` so the line can be sent again). These columns keep who answered,
-- how they were signed in, when, and what they said. They describe the last
-- answer given for the record; every answer is also a job_events row.
--
-- Additive only: no existing row changes, nothing writes to Xero.

ALTER TABLE public.work_order_customer_variation_invoices
  ADD COLUMN IF NOT EXISTS reconciled_outcome text,
  ADD COLUMN IF NOT EXISTS reconciled_by uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS reconciled_via text,
  ADD COLUMN IF NOT EXISTS reconciled_at timestamptz,
  ADD COLUMN IF NOT EXISTS reconcile_note text;

ALTER TABLE public.work_order_customer_variation_invoices
  DROP CONSTRAINT IF EXISTS work_order_customer_variation_invoices_reconcile_check;
ALTER TABLE public.work_order_customer_variation_invoices
  ADD CONSTRAINT work_order_customer_variation_invoices_reconcile_check CHECK (
    (reconciled_outcome IS NULL OR reconciled_outcome IN ('draft_exists', 'no_draft'))
    AND (reconciled_via IS NULL OR reconciled_via IN ('session', 'terminal'))
    AND (reconcile_note IS NULL OR length(reconcile_note) <= 2000)
    -- An answer always names who gave it, how and when; none of them alone.
    AND (
      (reconciled_outcome IS NULL AND reconciled_by IS NULL
        AND reconciled_via IS NULL AND reconciled_at IS NULL AND reconcile_note IS NULL)
      OR (reconciled_outcome IS NOT NULL AND reconciled_by IS NOT NULL
        AND reconciled_via IS NOT NULL AND reconciled_at IS NOT NULL)
    )
  );

COMMENT ON COLUMN public.work_order_customer_variation_invoices.reconciled_outcome IS
  'The last answer a work order approver gave for this record after checking Xero by hand: draft_exists (the Xero draft was recorded) or no_draft (the record went back to prepared). Null when nobody has answered.';
COMMENT ON COLUMN public.work_order_customer_variation_invoices.reconciled_by IS
  'The work order approver who gave reconciled_outcome.';
COMMENT ON COLUMN public.work_order_customer_variation_invoices.reconciled_at IS
  'When reconciled_outcome was given. For draft_exists, xero_created_at is this instant: the time the draft was recorded here, not when Xero made it.';
