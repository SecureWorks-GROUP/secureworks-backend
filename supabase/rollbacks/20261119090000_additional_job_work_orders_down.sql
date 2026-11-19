-- Rollback of 20261119090000_additional_job_work_orders.sql.
-- Refuses while any additional work order exists: an approved one has already
-- added its amount to the main work order (an append-only amount change), and
-- removing the kind would strand it. Retire them by hand first.

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.work_orders WHERE kind = 'additional') THEN
    RAISE EXCEPTION 'additional_job_work_orders rollback refused: additional work orders exist';
  END IF;
END $$;

DO $patch$
DECLARE
  v_def text;
  v_new1 text := 'FILTER (WHERE w.kind IN (''job'', ''additional'')), 0),';
  v_old1 text := 'FILTER (WHERE w.kind = ''job''), 0),';
  v_new2 text := 'FILTER (WHERE w.kind = ''crew''), 0)) AS agreed_labour_ex';
  v_old2 text := 'FILTER (WHERE w.kind IS DISTINCT FROM ''job''), 0)) AS agreed_labour_ex';
BEGIN
  IF to_regprocedure('public.job_cost_close(uuid[], date)') IS NULL THEN RETURN; END IF;
  v_def := pg_get_functiondef('public.job_cost_close(uuid[], date)'::regprocedure);
  IF position(v_new1 IN v_def) = 0 AND position(v_new2 IN v_def) = 0 THEN RETURN; END IF;
  EXECUTE replace(replace(v_def, v_new1, v_old1), v_new2, v_old2);
END $patch$;

DROP FUNCTION IF EXISTS public.approve_additional_work_order(uuid, uuid, text, timestamptz, uuid);
DROP TRIGGER IF EXISTS trg_work_orders_additional_guard ON public.work_orders;
DROP FUNCTION IF EXISTS public.work_orders_additional_guard();

DROP POLICY IF EXISTS work_orders_job_kind_hidden_from_clients ON public.work_orders;
CREATE POLICY work_orders_job_kind_hidden_from_clients ON public.work_orders
  AS RESTRICTIVE FOR SELECT TO anon, authenticated
  USING (kind <> 'job');

DROP INDEX IF EXISTS public.uq_work_orders_additional_number;
DROP INDEX IF EXISTS public.idx_work_orders_additional_job;
ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_additional_shape_check;
ALTER TABLE public.work_orders DROP COLUMN IF EXISTS amount_change_id;
ALTER TABLE public.work_orders DROP COLUMN IF EXISTS main_work_order_id;
ALTER TABLE public.work_orders DROP COLUMN IF EXISTS title;

ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_kind_status_check;
ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_kind_status_check CHECK (
  ((kind = 'crew'::text) AND (status <> 'approved'::text))
  OR ((kind = 'job'::text) AND (status = ANY (ARRAY['draft'::text, 'approved'::text])))
);
ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_kind_check;
ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_kind_check
  CHECK (kind = ANY (ARRAY['crew'::text, 'job'::text]));

COMMENT ON COLUMN public.work_orders.kind IS
  'crew = a trade''s crew-pay work order (existing behaviour). job = the job''s one work order: draft, then approved (sealed) by an approver in work_order_settings.';
