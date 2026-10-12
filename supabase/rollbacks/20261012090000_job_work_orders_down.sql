-- Rollback for 20261012090000_job_work_orders.sql.
--
-- Removes the job work order layer. Refuses while any job work order exists,
-- so it can never silently delete an approved (sealed) work order or the
-- variations recorded against one: those rows are decided by a human first.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.work_orders WHERE kind = 'job') THEN
    RAISE EXCEPTION 'job work orders exist: resolve them before rolling back 20261012090000_job_work_orders';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.backfill_job_work_order_drafts(boolean);
DROP VIEW IF EXISTS public.job_work_order_labour_lines;

DROP TRIGGER IF EXISTS trg_trade_invoices_link_job_work_orders ON public.trade_invoices;
DROP FUNCTION IF EXISTS public.trade_invoices_link_job_work_orders();
DROP TRIGGER IF EXISTS trg_trade_invoice_lines_link_job_work_order ON public.trade_invoice_lines;
DROP FUNCTION IF EXISTS public.trade_invoice_lines_link_job_work_order();

DROP FUNCTION IF EXISTS public.approve_job_work_order(uuid, uuid, text);
DROP TRIGGER IF EXISTS trg_jobs_open_job_work_order ON public.jobs;
DROP FUNCTION IF EXISTS public.jobs_open_job_work_order();
DROP FUNCTION IF EXISTS public.ensure_job_work_order_draft(uuid, text);
DROP TRIGGER IF EXISTS trg_work_orders_job_kind_guard ON public.work_orders;
DROP FUNCTION IF EXISTS public.work_orders_job_kind_guard();

DROP FUNCTION IF EXISTS public.job_live_work_order_id(uuid);
DROP FUNCTION IF EXISTS public.job_work_order_excluded_line_types();
DROP FUNCTION IF EXISTS public.job_work_order_billed_invoice_statuses();
DROP FUNCTION IF EXISTS public.job_work_order_open_statuses();

DELETE FROM public.feature_flags
WHERE flag_name IN ('work_order_variation_emails_v1', 'job_work_order_backfill_v1');

DROP TABLE IF EXISTS public.work_order_variation_emails;
DROP TABLE IF EXISTS public.work_order_variations;
DROP TABLE IF EXISTS public.work_order_settings;

DROP INDEX IF EXISTS public.idx_trade_invoice_lines_job_work_order;
ALTER TABLE public.trade_invoice_lines DROP COLUMN IF EXISTS job_work_order_id;
ALTER TABLE public.jobs DROP COLUMN IF EXISTS work_order_id;

DROP POLICY IF EXISTS work_orders_job_kind_hidden_from_clients ON public.work_orders;
DROP INDEX IF EXISTS public.uq_work_orders_job_live_approved;
DROP INDEX IF EXISTS public.uq_work_orders_job_open_draft;
DROP INDEX IF EXISTS public.idx_work_orders_kind;

ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_origin_check;
ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_approved_via_check;
ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_agreed_labour_check;
ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_approved_sealed_check;
ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_kind_status_check;
ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_kind_check;
ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_status_check;
ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_status_check
  CHECK (status IN ('draft', 'sent', 'accepted', 'in_progress', 'complete', 'cancelled'));

ALTER TABLE public.work_orders
  DROP COLUMN IF EXISTS origin,
  DROP COLUMN IF EXISTS superseded_by_work_order_id,
  DROP COLUMN IF EXISTS superseded_at,
  DROP COLUMN IF EXISTS supersedes_work_order_id,
  DROP COLUMN IF EXISTS sealed_content_hash,
  DROP COLUMN IF EXISTS approved_via,
  DROP COLUMN IF EXISTS approved_by,
  DROP COLUMN IF EXISTS approved_at,
  DROP COLUMN IF EXISTS agreed_labour_ex,
  DROP COLUMN IF EXISTS kind;
