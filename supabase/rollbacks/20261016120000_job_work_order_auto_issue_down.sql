-- Rollback for 20261016120000_job_work_order_auto_issue.sql.
--
-- Refuses while any job work order was issued automatically: such a row names
-- no approver, which the restored seal check forbids, and it is sealed, so it
-- is decided by a human first, never silently rewritten.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.work_orders WHERE approved_via = 'auto') THEN
    RAISE EXCEPTION 'automatically issued job work orders exist: resolve them before rolling back 20261016120000_job_work_order_auto_issue';
  END IF;
END $$;

DO $cron$
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'job-work-order-auto-issue';
  END IF;
END $cron$;

DROP FUNCTION IF EXISTS public.trigger_job_work_order_auto_issue();
DROP FUNCTION IF EXISTS public.auto_issue_job_work_order(uuid, timestamptz);

-- The seal as 20261012130000 wrote it.
CREATE OR REPLACE FUNCTION public.work_orders_job_kind_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_mutable text[] := ARRAY['viewed_at', 'updated_at'];
  v_approvers uuid[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.kind = 'job' AND OLD.status = 'approved' THEN
      RAISE EXCEPTION 'an approved job work order is sealed and cannot be deleted'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.kind = 'job' AND NEW.status = 'approved' THEN
      RAISE EXCEPTION 'a job work order is created as a draft and approved afterwards'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'work_orders.kind cannot change' USING ERRCODE = '23514';
  END IF;

  IF OLD.kind = 'job' AND OLD.status = 'approved' THEN
    IF (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
      RAISE EXCEPTION 'an approved job work order is sealed: later change is recorded as a variation'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- Every write to a job work order that is not yet sealed moves updated_at:
  -- it is the stamp approve_job_work_order compares with what the approver read.
  IF NEW.kind = 'job' THEN
    NEW.updated_at := clock_timestamp();
  END IF;

  IF NEW.kind = 'job' AND NEW.status = 'approved' THEN
    -- draft -> approved: the one approval transition.
    IF OLD.status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'only a draft job work order can be approved' USING ERRCODE = '23514';
    END IF;
    SELECT s.approver_user_ids INTO v_approvers FROM public.work_order_settings s WHERE s.id = 1;
    IF NEW.approved_by IS NULL OR v_approvers IS NULL OR NOT (NEW.approved_by = ANY (v_approvers)) THEN
      RAISE EXCEPTION 'only an approver named in work_order_settings can approve a job work order'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.job_id IS NULL THEN
      RAISE EXCEPTION 'a job work order needs its job' USING ERRCODE = '23514';
    END IF;
    IF NEW.agreed_labour_ex IS NULL THEN
      RAISE EXCEPTION 'set the agreed labour amount before approving' USING ERRCODE = '23514';
    END IF;
    IF COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(NEW.scope_items) = 'array' THEN NEW.scope_items END), 0) = 0
       AND COALESCE(btrim(NEW.special_instructions), '') = '' THEN
      RAISE EXCEPTION 'add the scope before approving' USING ERRCODE = '23514';
    END IF;
    NEW.approved_at := COALESCE(NEW.approved_at, now());
    NEW.sealed_content_hash := encode(sha256(convert_to(jsonb_build_object(
      'work_order_id', NEW.id,
      'job_id', NEW.job_id,
      'wo_number', NEW.wo_number,
      'scope_items', COALESCE(NEW.scope_items, '[]'::jsonb),
      'special_instructions', NEW.special_instructions,
      'site_address', NEW.site_address,
      'scheduled_date', NEW.scheduled_date,
      'agreed_labour_ex', NEW.agreed_labour_ex
    )::text, 'UTF8')), 'hex');
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_auto_issue_check;

ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_approved_sealed_check;
ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_approved_sealed_check
  CHECK (
    status <> 'approved'
    OR (approved_at IS NOT NULL AND approved_by IS NOT NULL
        AND agreed_labour_ex IS NOT NULL AND sealed_content_hash IS NOT NULL)
  );

ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_approved_via_check;
ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_approved_via_check
  CHECK (approved_via IS NULL OR approved_via IN ('session', 'terminal'));

-- Neither stamp is in the sealed content hash, and dropping a column fires no
-- row trigger, so approved rows are untouched.
ALTER TABLE public.work_orders
  DROP COLUMN IF EXISTS quote_filled_at,
  DROP COLUMN IF EXISTS hand_edited_at;

DELETE FROM public.feature_flags WHERE flag_name = 'job_work_order_auto_issue_v1';
