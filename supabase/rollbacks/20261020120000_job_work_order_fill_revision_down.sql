-- Rollback for 20261020120000_job_work_order_fill_revision.sql.
--
-- Drops the column, its guard, check and index. Nothing unique is lost: every
-- fill that set the column also named the same revision in its
-- job_work_order_draft_filled_from_quote event, which stays.

BEGIN;
DROP TRIGGER IF EXISTS trg_work_orders_fill_revision_guard ON public.work_orders;
DROP FUNCTION IF EXISTS public.work_orders_fill_revision_guard();
DROP INDEX IF EXISTS public.work_orders_quote_filled_scope_revision_idx;
ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_fill_revision_job_kind;
ALTER TABLE public.work_orders DROP COLUMN IF EXISTS quote_filled_scope_revision_id;
COMMIT;
