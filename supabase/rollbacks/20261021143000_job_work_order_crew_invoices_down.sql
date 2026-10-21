-- Rolls 20261021143000 back to the seal of 20261016120000 and the
-- open/link functions of 20261012130000. Functions are restored before the
-- new columns are dropped. Does not drop auto_issue_job_work_order,
-- quote_filled_at or hand_edited_at, and deletes no work order or invoice.

-- 1. invoice link functions, as they were before a draft could stamp
CREATE OR REPLACE FUNCTION public.trade_invoice_lines_link_job_work_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
BEGIN
  IF NEW.job_work_order_id IS NOT NULL OR NEW.job_id IS NULL THEN
    RETURN NEW;
  END IF;
  BEGIN
    SELECT ti.status INTO v_status FROM public.trade_invoices ti WHERE ti.id = NEW.trade_invoice_id;
    IF v_status = ANY (public.job_work_order_billed_invoice_statuses()) THEN
      NEW.job_work_order_id := public.job_live_work_order_id(NEW.job_id);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'job work order link skipped for trade invoice line on job %: SQLSTATE %', NEW.job_id, SQLSTATE;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trade_invoice_lines_link_job_work_order ON public.trade_invoice_lines;
CREATE TRIGGER trg_trade_invoice_lines_link_job_work_order
  BEFORE INSERT ON public.trade_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION public.trade_invoice_lines_link_job_work_order();

-- A draft invoice that is submitted later links on that status change.
CREATE OR REPLACE FUNCTION public.trade_invoices_link_job_work_orders()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = ANY (public.job_work_order_billed_invoice_statuses())
     AND NOT (COALESCE(OLD.status, '') = ANY (public.job_work_order_billed_invoice_statuses())) THEN
    BEGIN
      UPDATE public.trade_invoice_lines til
        SET job_work_order_id = public.job_live_work_order_id(til.job_id)
        WHERE til.trade_invoice_id = NEW.id
          AND til.job_work_order_id IS NULL
          AND til.job_id IS NOT NULL;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'job work order links skipped for trade invoice %: SQLSTATE %', NEW.id, SQLSTATE;
    END;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_trade_invoices_link_job_work_orders ON public.trade_invoices;
CREATE TRIGGER trg_trade_invoices_link_job_work_orders
  AFTER UPDATE OF status ON public.trade_invoices
  FOR EACH ROW EXECUTE FUNCTION public.trade_invoices_link_job_work_orders();

-- 2. open-a-draft, fencing and patio only
CREATE OR REPLACE FUNCTION public.ensure_job_work_order_draft(p_job_id uuid, p_origin text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job record;
  v_id uuid;
BEGIN
  SELECT j.id, j.org_id, j.type, j.job_number, j.site_address, j.site_suburb, j.work_order_id
    INTO v_job FROM public.jobs j WHERE j.id = p_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job % not found', p_job_id USING ERRCODE = 'P0002';
  END IF;
  IF COALESCE(v_job.type, '') NOT IN ('fencing', 'patio') THEN
    RAISE EXCEPTION 'job work orders are for fencing and patio jobs' USING ERRCODE = '23514';
  END IF;

  SELECT wo.id INTO v_id FROM public.work_orders wo
  WHERE wo.job_id = p_job_id AND wo.kind = 'job' AND wo.status IN ('draft', 'approved') LIMIT 1;

  IF v_id IS NULL THEN
    BEGIN
      INSERT INTO public.work_orders (
        org_id, job_id, wo_number, kind, status, scope_items, site_address, origin
      ) VALUES (
        v_job.org_id, p_job_id,
        'WO-' || COALESCE(NULLIF(v_job.job_number, ''), left(p_job_id::text, 8)),
        'job', 'draft', '[]'::jsonb,
        NULLIF(concat_ws(', ', NULLIF(v_job.site_address, ''), NULLIF(v_job.site_suburb, '')), ''),
        p_origin
      ) RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
      SELECT wo.id INTO v_id FROM public.work_orders wo
      WHERE wo.job_id = p_job_id AND wo.kind = 'job' AND wo.status IN ('draft', 'approved') LIMIT 1;
    END;
  END IF;

  IF v_id IS NOT NULL AND v_job.work_order_id IS DISTINCT FROM v_id THEN
    UPDATE public.jobs SET work_order_id = v_id WHERE id = p_job_id;
  END IF;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.ensure_job_work_order_draft(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_job_work_order_draft(uuid, text) TO service_role;

-- Future approved jobs: open a draft when a fencing or patio job enters an
-- open approved status. Never blocks the job write.
CREATE OR REPLACE FUNCTION public.jobs_open_job_work_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.type IN ('fencing', 'patio')
     AND NEW.status = ANY (public.job_work_order_open_statuses())
     AND (TG_OP = 'INSERT'
          OR OLD.status IS DISTINCT FROM NEW.status
          OR OLD.type IS DISTINCT FROM NEW.type)
     AND NOT EXISTS (
       SELECT 1 FROM public.work_orders wo
       WHERE wo.job_id = NEW.id AND wo.kind = 'job' AND wo.status IN ('draft', 'approved')
     ) THEN
    BEGIN
      PERFORM public.ensure_job_work_order_draft(NEW.id, 'job_approved');
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'job work order draft not opened for job %: SQLSTATE %', NEW.id, SQLSTATE;
    END;
  END IF;
  RETURN NULL;
END;
$$;

-- 3. the seal, including automatic issue, without the backup approver
-- The body of 20261012130000 with three additions, marked below: the two
-- stamps are the database's, and the approval transition accepts an automatic
-- issue made by auto_issue_job_work_order.
CREATE OR REPLACE FUNCTION public.work_orders_job_kind_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_mutable text[] := ARRAY['viewed_at', 'updated_at'];
  v_approvers uuid[];
  v_content_changed boolean;
  v_old_untouched boolean;
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
    -- (added) A new draft is not the quote fill's; content written with the
    -- insert itself is a hand edit.
    IF NEW.kind = 'job' THEN
      NEW.quote_filled_at := NULL;
      NEW.hand_edited_at := CASE
        WHEN COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(NEW.scope_items) = 'array' THEN NEW.scope_items END), 0) > 0
          OR NEW.agreed_labour_ex IS NOT NULL
          OR COALESCE(btrim(NEW.special_instructions), '') <> ''
        THEN clock_timestamp()
      END;
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

    -- (added) The stamps. hand_edited_at is never taken from the caller.
    -- quote_filled_at moves only once, from NULL, on the quote fill of an
    -- untouched draft (no scope, no agreed labour, never edited), or on this
    -- migration's own stamp of a draft filled before it (content unchanged).
    -- Any other content change is a hand edit.
    NEW.hand_edited_at := OLD.hand_edited_at;
    v_content_changed :=
      NEW.scope_items IS DISTINCT FROM OLD.scope_items
      OR NEW.agreed_labour_ex IS DISTINCT FROM OLD.agreed_labour_ex
      OR NEW.special_instructions IS DISTINCT FROM OLD.special_instructions
      OR NEW.scheduled_date IS DISTINCT FROM OLD.scheduled_date
      OR NEW.site_address IS DISTINCT FROM OLD.site_address;
    v_old_untouched :=
      COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(OLD.scope_items) = 'array' THEN OLD.scope_items END), 0) = 0
      AND OLD.agreed_labour_ex IS NULL;
    IF NEW.quote_filled_at IS DISTINCT FROM OLD.quote_filled_at THEN
      IF OLD.quote_filled_at IS NOT NULL OR NEW.quote_filled_at IS NULL
         OR OLD.status IS DISTINCT FROM 'draft' OR OLD.hand_edited_at IS NOT NULL
         OR NOT (
           v_old_untouched
           OR (NOT v_content_changed
               AND current_setting('secureworks.job_work_order_fill_stamp', true) = 'prior_fill')
         ) THEN
        RAISE EXCEPTION 'quote_filled_at is stamped only by the quote fill of an untouched draft'
          USING ERRCODE = '23514';
      END IF;
    ELSIF v_content_changed THEN
      NEW.hand_edited_at := clock_timestamp();
    END IF;
  END IF;

  IF NEW.kind = 'job' AND NEW.status = 'approved' THEN
    -- draft -> approved: the one approval transition.
    IF OLD.status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'only a draft job work order can be approved' USING ERRCODE = '23514';
    END IF;
    IF NEW.approved_via = 'auto' THEN
      -- (added) An automatic issue: made only inside auto_issue_job_work_order,
      -- only while its flag is on, only for a draft the quote fill wrote that
      -- nobody has edited since, and naming no approver.
      IF current_setting('secureworks.job_work_order_auto_issue', true) IS DISTINCT FROM 'on'
         OR NOT COALESCE((SELECT f.enabled FROM public.feature_flags f
                          WHERE f.flag_name = 'job_work_order_auto_issue_v1' LIMIT 1), false) THEN
        RAISE EXCEPTION 'a job work order is issued automatically only by auto_issue_job_work_order while job_work_order_auto_issue_v1 is on'
          USING ERRCODE = '42501';
      END IF;
      IF NEW.approved_by IS NOT NULL THEN
        RAISE EXCEPTION 'an automatic issue names no approver' USING ERRCODE = '23514';
      END IF;
      IF OLD.quote_filled_at IS NULL OR OLD.hand_edited_at IS NOT NULL THEN
        RAISE EXCEPTION 'only a draft filled from the quote and not edited by hand is issued automatically'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      SELECT s.approver_user_ids INTO v_approvers FROM public.work_order_settings s WHERE s.id = 1;
      IF NEW.approved_by IS NULL OR v_approvers IS NULL OR NOT (NEW.approved_by = ANY (v_approvers)) THEN
        RAISE EXCEPTION 'only an approver named in work_order_settings can approve a job work order'
          USING ERRCODE = '42501';
      END IF;
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

-- 4. helpers this migration added
DROP FUNCTION IF EXISTS public.preview_active_job_work_orders();
DROP FUNCTION IF EXISTS public.apply_active_job_work_orders();
DROP FUNCTION IF EXISTS public.apply_active_job_work_orders(uuid[]);
DROP FUNCTION IF EXISTS public.job_invoice_work_order_id(uuid);

-- 5. columns
ALTER TABLE public.trade_invoice_lines
  DROP CONSTRAINT IF EXISTS trade_invoice_lines_office_review_status_check;
ALTER TABLE public.trade_invoice_lines
  DROP COLUMN IF EXISTS office_review_status,
  DROP COLUMN IF EXISTS office_reviewed_by,
  DROP COLUMN IF EXISTS office_reviewed_at,
  DROP COLUMN IF EXISTS office_review_note;

ALTER TABLE public.work_order_settings
  DROP COLUMN IF EXISTS backup_approver_user_ids;

COMMENT ON COLUMN public.trade_invoice_lines.job_work_order_id IS
  'The job''s APPROVED job work order. Stamped by trigger at invoice submit, or by approve_job_work_order for labour invoiced before the approval. Never by a caller.';

-- 6. switches this migration added. Flags turned on by hand are removed too;
-- re-applying the forward migration seeds them off again.
DELETE FROM public.feature_flags
WHERE flag_name IN (
  'job_work_order_all_types_v1',
  'job_work_order_active_backfill_v1',
  'job_work_order_office_fill_v1',
  'crew_invoice_on_job_work_order_v1',
  'crew_invoice_line_office_review_v1',
  'crew_invoice_requires_job_work_order_v1',
  'retire_crew_work_orders_v1'
);
