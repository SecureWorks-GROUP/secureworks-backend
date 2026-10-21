-- 20261021143000_job_work_order_crew_invoices.sql
--
-- Crew invoices move onto the job's work order. Every behaviour change is a
-- feature flag seeded OFF, so applying this migration changes no live job,
-- work order, or invoice. The 30-day backfill is preview_active_job_work_orders
-- / apply_active_job_work_orders, called by scripts/backfill-job-work-orders-active.ts.
-- This file does not call apply.
--
-- Contract: docs/job-work-order-crew-invoices-v1.md.

-- ── 1. switches, all off ─────────────────────────────────────────────────────

INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES
  ('job_work_order_all_types_v1', false,
   'Open a blank job work order for every job type when the job enters an open status. Fencing and patio are unchanged either way. Off: other types still raise.'),
  ('job_work_order_active_backfill_v1', false,
   'Allow apply_active_job_work_orders() to open blank work orders for jobs touched in the last 30 days. The dry-run preview does not need it. Also needs job_work_order_all_types_v1.'),
  ('job_work_order_office_fill_v1', false,
   'Office queue, fill and approve for blank job work orders, and the backup approver list on the seal. Off: Shaun alone, through the existing approve door.'),
  ('crew_invoice_on_job_work_order_v1', false,
   'Stamp trade_invoice_lines.job_work_order_id from a draft or approved job work order. Off: only an approved job work order is stamped, as before.'),
  ('crew_invoice_line_office_review_v1', false,
   'New crew invoice lines start awaiting office review and must not sync to Xero until approved. Off: lines are unchanged and still sync.'),
  ('crew_invoice_requires_job_work_order_v1', false,
   'Refuse a crew invoice line on a job that has no job work order. Off: a job with no work order can still be invoiced.'),
  ('retire_crew_work_orders_v1', false,
   'Stop creating per-trade crew work orders and hide existing kind=crew rows that are not quote-builder work orders. Off: those rows stay as they are. Nothing is deleted.')
ON CONFLICT (flag_name) DO NOTHING;

-- ── 2. backup approver (the seal ignores it until the office switch is on) ──

ALTER TABLE public.work_order_settings
  ADD COLUMN IF NOT EXISTS backup_approver_user_ids uuid[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.work_order_settings.backup_approver_user_ids IS
  'Users who may fill and approve a job work order only while job_work_order_office_fill_v1 is on. Empty until seeded. Does not widen approver_user_ids.';

-- Seed Marnin only while the list is still empty. More than one row with his
-- email leaves it empty. No email column: the known id, if that user exists.
DO $seed_backup_approver$
DECLARE
  v_known uuid := '706c5258-70dd-483a-b36c-af6864b24498';
  v_email_col boolean;
  v_count int;
  v_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.work_order_settings
    WHERE id = 1 AND backup_approver_user_ids = '{}'::uuid[]
  ) THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'email'
  ) INTO v_email_col;

  IF v_email_col THEN
    SELECT count(*) INTO v_count FROM public.users
    WHERE lower(btrim(email)) = 'marnin@secureworkswa.com.au';
    IF v_count = 1 THEN
      SELECT id INTO v_id FROM public.users
      WHERE lower(btrim(email)) = 'marnin@secureworkswa.com.au';
    ELSIF v_count = 0 AND EXISTS (SELECT 1 FROM public.users WHERE id = v_known) THEN
      v_id := v_known;
    END IF;
  ELSIF EXISTS (SELECT 1 FROM public.users WHERE id = v_known) THEN
    v_id := v_known;
  END IF;

  IF v_id IS NOT NULL THEN
    UPDATE public.work_order_settings
      SET backup_approver_user_ids = ARRAY[v_id]
      WHERE id = 1 AND backup_approver_user_ids = '{}'::uuid[];
  END IF;
END
$seed_backup_approver$;

-- ── 3. per-line office review ────────────────────────────────────────────────

ALTER TABLE public.trade_invoice_lines
  ADD COLUMN IF NOT EXISTS office_review_status text,
  ADD COLUMN IF NOT EXISTS office_reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS office_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS office_review_note text;

ALTER TABLE public.trade_invoice_lines
  DROP CONSTRAINT IF EXISTS trade_invoice_lines_office_review_status_check;
ALTER TABLE public.trade_invoice_lines
  ADD CONSTRAINT trade_invoice_lines_office_review_status_check
  CHECK (
    office_review_status IS NULL
    OR office_review_status IN ('awaiting', 'approved', 'queried', 'rejected')
  );

COMMENT ON COLUMN public.trade_invoice_lines.office_review_status IS
  'Office review of a crew invoice line before it can sync to Xero. NULL is a line from before the review switch and may sync. awaiting, queried and rejected hold the whole invoice. Stamped on insert only while crew_invoice_line_office_review_v1 is on.';

COMMENT ON COLUMN public.trade_invoice_lines.job_work_order_id IS
  'The job''s job work order. An approved one is stamped as before. A draft is stamped only while crew_invoice_on_job_work_order_v1 is on. Never source_work_order_id, and never set by a caller.';

-- ── 4. the seal: backup approver, and a labour allowance instead of scope ───

-- The body of 20261016120000, plus two changes marked below. Auto-issue is
-- unchanged: a blank draft has no quote_filled_at, and filling the allowance
-- stamps hand_edited_at, so it is never issued automatically.
CREATE OR REPLACE FUNCTION public.work_orders_job_kind_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_mutable text[] := ARRAY['viewed_at', 'updated_at'];
  v_approvers uuid[];
  v_backup uuid[];
  v_content_changed boolean;
  v_old_untouched boolean;
  v_job_type text;
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

  IF NEW.kind = 'job' THEN
    NEW.updated_at := clock_timestamp();

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
    IF OLD.status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'only a draft job work order can be approved' USING ERRCODE = '23514';
    END IF;
    IF NEW.approved_via = 'auto' THEN
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
      -- (added) Backup approvers join the list only while the office switch is on.
      SELECT s.approver_user_ids, s.backup_approver_user_ids
        INTO v_approvers, v_backup
        FROM public.work_order_settings s WHERE s.id = 1;
      IF COALESCE((SELECT f.enabled FROM public.feature_flags f
                   WHERE f.flag_name = 'job_work_order_office_fill_v1' LIMIT 1), false) THEN
        v_approvers := COALESCE(v_approvers, '{}'::uuid[]) || COALESCE(v_backup, '{}'::uuid[]);
      END IF;
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
      -- (added) Fencing, patio, and a job with no type still need a scope.
      -- Any other type may be approved on the labour allowance alone.
      SELECT j.type INTO v_job_type FROM public.jobs j WHERE j.id = NEW.job_id;
      IF COALESCE(btrim(v_job_type), '') IN ('fencing', 'patio', '') THEN
        RAISE EXCEPTION 'add the scope before approving' USING ERRCODE = '23514';
      END IF;
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

-- ── 5. open a blank draft for every job type, while the switch is on ────────

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
    IF NOT (
      COALESCE((SELECT enabled FROM public.feature_flags
                WHERE flag_name = 'job_work_order_all_types_v1'), false)
      AND COALESCE(btrim(v_job.type), '') <> ''
    ) THEN
      RAISE EXCEPTION 'job work orders are for fencing and patio jobs' USING ERRCODE = '23514';
    END IF;
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

-- The flag read sits inside the existing exception, so an unreadable flag
-- never blocks the job write. Fencing and patio are unchanged.
CREATE OR REPLACE FUNCTION public.jobs_open_job_work_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = ANY (public.job_work_order_open_statuses())
     AND (TG_OP = 'INSERT'
          OR OLD.status IS DISTINCT FROM NEW.status
          OR OLD.type IS DISTINCT FROM NEW.type)
     AND NOT EXISTS (
       SELECT 1 FROM public.work_orders wo
       WHERE wo.job_id = NEW.id AND wo.kind = 'job' AND wo.status IN ('draft', 'approved')
     ) THEN
    BEGIN
      IF NEW.type IN ('fencing', 'patio')
         OR (
           COALESCE((SELECT enabled FROM public.feature_flags
                     WHERE flag_name = 'job_work_order_all_types_v1'), false)
           AND COALESCE(btrim(NEW.type), '') <> ''
         ) THEN
        PERFORM public.ensure_job_work_order_draft(NEW.id, 'job_approved');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'job work order draft not opened for job %: SQLSTATE %', NEW.id, SQLSTATE;
    END;
  END IF;
  RETURN NULL;
END;
$$;

-- ── 6. which work order a crew invoice line may name ────────────────────────

-- Approved first, always. A draft only while the stamp switch is on.
-- Unreadable flag is off: the approved work order still stamps.
CREATE OR REPLACE FUNCTION public.job_invoice_work_order_id(p_job_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_job_id IS NULL THEN
    RETURN NULL;
  END IF;
  v_id := public.job_live_work_order_id(p_job_id);
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;
  IF NOT COALESCE((SELECT enabled FROM public.feature_flags
                   WHERE flag_name = 'crew_invoice_on_job_work_order_v1'), false) THEN
    RETURN NULL;
  END IF;
  SELECT wo.id INTO v_id FROM public.work_orders wo
  WHERE wo.job_id = p_job_id AND wo.kind = 'job' AND wo.status IN ('draft', 'approved')
  LIMIT 1;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.job_invoice_work_order_id(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_invoice_work_order_id(uuid) TO service_role;

-- Review is its own exception block, before the job-id return, so a travel
-- line or a deduction with no job still starts awaiting. A failure there
-- does not skip the work-order stamp.
CREATE OR REPLACE FUNCTION public.trade_invoice_lines_link_job_work_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
BEGIN
  IF NEW.office_review_status IS NULL THEN
    BEGIN
      IF COALESCE((SELECT enabled FROM public.feature_flags
                   WHERE flag_name = 'crew_invoice_line_office_review_v1'), false) THEN
        NEW.office_review_status := 'awaiting';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'office review stamp skipped for trade invoice line %: SQLSTATE %', NEW.id, SQLSTATE;
    END;
  END IF;

  IF NEW.job_work_order_id IS NOT NULL OR NEW.job_id IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT ti.status INTO v_status FROM public.trade_invoices ti WHERE ti.id = NEW.trade_invoice_id;
    IF v_status = ANY (public.job_work_order_billed_invoice_statuses()) THEN
      NEW.job_work_order_id := public.job_invoice_work_order_id(NEW.job_id);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'job work order link skipped for trade invoice line on job %: SQLSTATE %', NEW.job_id, SQLSTATE;
  END;
  RETURN NEW;
END;
$$;

-- Status change links the work order only. It does not start a review.
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
        SET job_work_order_id = public.job_invoice_work_order_id(til.job_id)
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

-- ── 7. 30-day backfill, not run from here ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.preview_active_job_work_orders()
RETURNS TABLE (
  job_id uuid,
  job_number text,
  job_type text,
  status text,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT j.id, j.job_number, j.type, j.status, j.updated_at
  FROM public.jobs j
  WHERE j.status = ANY (public.job_work_order_open_statuses())
    AND j.updated_at >= now() - interval '30 days'
    AND NOT EXISTS (
      SELECT 1 FROM public.work_orders wo
      WHERE wo.job_id = j.id AND wo.kind = 'job' AND wo.status IN ('draft', 'approved')
    )
  ORDER BY j.type, j.job_number;
$$;
REVOKE ALL ON FUNCTION public.preview_active_job_work_orders() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.preview_active_job_work_orders() TO service_role;

CREATE OR REPLACE FUNCTION public.apply_active_job_work_orders()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job record;
  v_opened int := 0;
BEGIN
  IF NOT COALESCE((SELECT f.enabled FROM public.feature_flags f
                   WHERE f.flag_name = 'job_work_order_all_types_v1' LIMIT 1), false)
     OR NOT COALESCE((SELECT f.enabled FROM public.feature_flags f
                      WHERE f.flag_name = 'job_work_order_active_backfill_v1' LIMIT 1), false) THEN
    RAISE EXCEPTION 'active job work order backfill needs job_work_order_all_types_v1 and job_work_order_active_backfill_v1 on'
      USING ERRCODE = '42501';
  END IF;
  FOR v_job IN SELECT * FROM public.preview_active_job_work_orders() LOOP
    PERFORM public.ensure_job_work_order_draft(v_job.job_id, 'backfill');
    v_opened := v_opened + 1;
  END LOOP;
  RETURN jsonb_build_object('opened', v_opened, 'as_of', now());
END;
$$;
REVOKE ALL ON FUNCTION public.apply_active_job_work_orders() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_active_job_work_orders() TO service_role;
