-- Job work order fill revision (Dispatch S6, cost identity R7).
--
-- A job work order names the frozen scope revision its lines were filled from,
-- on its own row, so cost and obligation readers (CFO's Job Profit, Context)
-- can tie the work order to job, scope revision and line without reading the
-- fill's job event. Until now the revision was named only in the event
-- job_work_order_draft_filled_from_quote.
--
-- work_orders.quote_filled_scope_revision_id:
--   - only on a job work order (kind 'job'); null on every other kind;
--   - null on insert: a new draft is not the fill's;
--   - set once, from null, while the work order is a draft, to a frozen (or
--     since superseded) revision of the same job, never a draft revision;
--   - never changed or cleared afterwards (a draft a person rewrites still
--     names the revision it was filled from);
--   - setting it is not a hand edit (hand_edited_at is unchanged), and it is
--     not part of the sealed content hash (approval is unchanged); once the
--     work order is approved the existing seal refuses any change to it.
--
-- No backfill: setting it on a draft would move that draft's updated_at,
-- which an approver's open screen compares, and an approved work order is
-- sealed. Readers take the revision from the fill event when this is null
-- (job_work_orders.ts, jobWorkOrderFilledFrom).
--
-- The guard is its own trigger, so the seal body of 20261016120000 is not
-- replaced. It sorts before trg_work_orders_job_kind_guard; either one alone
-- refuses a change on an approved work order.

ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS quote_filled_scope_revision_id uuid
    REFERENCES public.scope_revisions(id) ON DELETE RESTRICT;

COMMENT ON COLUMN public.work_orders.quote_filled_scope_revision_id IS
  'Job work orders only: the frozen scope revision the quote fill copied the lines from. Set once while a draft, never changed. Null when not filled from a quote, or filled before 20261020120000 (then the fill event names it).';

ALTER TABLE public.work_orders
  DROP CONSTRAINT IF EXISTS work_orders_fill_revision_job_kind;
ALTER TABLE public.work_orders
  ADD CONSTRAINT work_orders_fill_revision_job_kind
    CHECK (quote_filled_scope_revision_id IS NULL OR kind = 'job') NOT VALID;
ALTER TABLE public.work_orders
  VALIDATE CONSTRAINT work_orders_fill_revision_job_kind;

CREATE INDEX IF NOT EXISTS work_orders_quote_filled_scope_revision_idx
  ON public.work_orders (quote_filled_scope_revision_id)
  WHERE quote_filled_scope_revision_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.work_orders_fill_revision_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.kind = 'job' THEN
      NEW.quote_filled_scope_revision_id := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.quote_filled_scope_revision_id IS NOT DISTINCT FROM OLD.quote_filled_scope_revision_id THEN
    RETURN NEW;
  END IF;
  IF OLD.quote_filled_scope_revision_id IS NOT NULL THEN
    RAISE EXCEPTION 'a job work order''s fill revision is set once and never changed'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status IS DISTINCT FROM 'draft' OR NEW.status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'a job work order''s fill revision is set only while it is a draft'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.scope_revisions r
    WHERE r.id = NEW.quote_filled_scope_revision_id
      AND r.job_id = NEW.job_id
      AND r.status IN ('frozen', 'superseded')
  ) THEN
    RAISE EXCEPTION 'a job work order''s fill revision must be a frozen scope revision of its own job, not a draft'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.work_orders_fill_revision_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_work_orders_fill_revision_guard ON public.work_orders;
CREATE TRIGGER trg_work_orders_fill_revision_guard
  BEFORE INSERT OR UPDATE ON public.work_orders
  FOR EACH ROW EXECUTE FUNCTION public.work_orders_fill_revision_guard();
