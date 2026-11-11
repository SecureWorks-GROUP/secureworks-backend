-- A make-safe job never gets a job work order.
--
-- Owner decision, 11 Nov 2026 (Marnin): "we don't need any work orders for
-- make safes."
--
-- 20261021143000 opens a blank job work order for every job type while
-- job_work_order_all_types_v1 is on, and that flag is on in production. So
-- every make-safe that entered an open status, and every make-safe the
-- 30-day backfill reviewed, got a blank draft nobody fills: a make-safe is
-- invoiced on its hours, not on an agreed labour figure.
--
-- One rule now covers every door (job_type_never_gets_job_work_order), and
-- it does not read the flag:
--   * ensure_job_work_order_draft refuses a make-safe (23514). Every writer
--     of a job work order goes through it: the job trigger, the office
--     create_work_order with kind 'job', the 30-day backfill, the scope
--     drafts.
--   * jobs_open_job_work_order skips a make-safe without calling it, so the
--     job write raises no warning.
--   * preview_active_job_work_orders leaves make-safes out, and
--     apply_active_job_work_orders skips one by name (job_type_not_eligible)
--     and never counts it as opened.
-- Fencing and patio are unchanged. Repair, miscellaneous and every other
-- type are unchanged: they still follow the flag.
--
-- Existing rows. A job work order has two states, draft and approved
-- (work_orders_kind_status_check); there is no cancelled or void state, and
-- uq_work_orders_job_current keeps one row per job whatever its status. The
-- only retirement the schema supports for a draft is removing it:
-- trg_work_orders_job_kind_guard seals an approved row and lets a draft go.
-- No earlier migration retires a draft, so this one keeps the whole row
-- first. retire_blank_makesafe_job_work_orders copies each row it removes
-- into job_work_order_retired_drafts, clears jobs.work_order_id where it
-- pointed at that row, then deletes the draft. It takes only a make-safe's
-- draft that nobody has touched and nothing refers to:
--   * no agreed labour, no scope items, no instructions, no date, no trade;
--   * never hand edited, quote filled, sent, viewed, accepted, completed or
--     approved, and carrying no scope revision or owner approval;
--   * no crew invoice line (job_work_order_id or source_work_order_id), no
--     trade invoice, no crew group, no variation, no customer variation, no
--     scope draft set, no owner approval and no unapproved-issue record.
-- Anything else on a make-safe is left exactly as it is, as is every repair
-- and miscellaneous draft. Running it again finds nothing and changes
-- nothing.
--
-- Live on 11 Nov 2026, read only: 34 make-safe job work orders, all draft,
-- all 34 meet every condition above (origins backfill and job_approved,
-- opened 3 to 6 Nov 2026), and jobs.work_order_id points at each. No
-- make-safe job work order is approved. The 10 crew work orders
-- (kind 'crew') on make-safe jobs are not job work orders and are not
-- touched. Clearing jobs.work_order_id moves jobs.updated_at on those 34
-- jobs, as writing it did.
--
-- No flag changes state. job_work_order_all_types_v1 keeps its value; only
-- its description is corrected.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- ── 1. the rule ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.job_type_never_gets_job_work_order(p_type text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT lower(btrim(coalesce(p_type, ''))) = 'makesafe'
$$;
REVOKE ALL ON FUNCTION public.job_type_never_gets_job_work_order(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_type_never_gets_job_work_order(text) TO service_role;

-- ── 2. the one writer refuses a make-safe ───────────────────────────────────

-- The body of 20261021143000 with the make-safe refusal ahead of the flag.
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
  IF public.job_type_never_gets_job_work_order(v_job.type) THEN
    RAISE EXCEPTION 'a make-safe job does not get a job work order' USING ERRCODE = '23514';
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

-- ── 3. the job trigger skips a make-safe ────────────────────────────────────

-- A make-safe is skipped before the writer is called, so its job write
-- raises no warning. The flag read stays inside the existing exception.
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
     AND NOT public.job_type_never_gets_job_work_order(NEW.type)
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

-- ── 4. the 30-day backfill leaves make-safes out ────────────────────────────

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
    AND NOT public.job_type_never_gets_job_work_order(j.type)
    AND NOT EXISTS (
      SELECT 1 FROM public.work_orders wo
      WHERE wo.job_id = j.id AND wo.kind = 'job' AND wo.status IN ('draft', 'approved')
    )
    AND public.job_work_order_recent_activity(j.id)
  ORDER BY j.type, j.job_number;
$$;
REVOKE ALL ON FUNCTION public.preview_active_job_work_orders() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.preview_active_job_work_orders() TO service_role;

-- A reviewed id that is a make-safe is skipped and named. It is checked
-- before the writer is called, so one make-safe in the file never stops the
-- other ids.
CREATE OR REPLACE FUNCTION public.apply_active_job_work_orders(p_job_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_job record;
  v_reason text;
  v_opened int := 0;
  v_skipped int := 0;
  v_opened_ids uuid[] := ARRAY[]::uuid[];
  v_skipped_jobs jsonb := '[]'::jsonb;
BEGIN
  IF NOT COALESCE((SELECT f.enabled FROM public.feature_flags f
                   WHERE f.flag_name = 'job_work_order_all_types_v1' LIMIT 1), false)
     OR NOT COALESCE((SELECT f.enabled FROM public.feature_flags f
                      WHERE f.flag_name = 'job_work_order_active_backfill_v1' LIMIT 1), false) THEN
    RAISE EXCEPTION 'active job work order backfill needs job_work_order_all_types_v1 and job_work_order_active_backfill_v1 on'
      USING ERRCODE = '42501';
  END IF;
  IF p_job_ids IS NULL THEN
    RETURN jsonb_build_object(
      'opened', 0, 'opened_ids', '[]'::jsonb, 'skipped', 0,
      'skipped_jobs', '[]'::jsonb, 'as_of', now()
    );
  END IF;
  -- Re-check every reviewed id. A job that lost its 30-day activity, closed,
  -- has a blank type or is a make-safe is skipped and named. It does not
  -- open a blank draft.
  FOREACH v_id IN ARRAY p_job_ids LOOP
    SELECT j.id, j.status, j.type INTO v_job FROM public.jobs j WHERE j.id = v_id;
    IF NOT FOUND THEN
      v_reason := 'not_found';
    ELSIF COALESCE(btrim(v_job.type), '') = '' THEN
      v_reason := 'blank_type';
    ELSIF public.job_type_never_gets_job_work_order(v_job.type) THEN
      v_reason := 'job_type_not_eligible';
    ELSIF NOT (v_job.status = ANY (public.job_work_order_open_statuses())) THEN
      v_reason := 'not_open';
    ELSIF EXISTS (
      SELECT 1 FROM public.work_orders wo
      WHERE wo.job_id = v_id AND wo.kind = 'job' AND wo.status IN ('draft', 'approved')
    ) THEN
      v_reason := 'already_has_work_order';
    ELSIF NOT public.job_work_order_recent_activity(v_id) THEN
      v_reason := 'no_recent_activity';
    ELSE
      v_reason := NULL;
    END IF;
    IF v_reason IS NULL THEN
      PERFORM public.ensure_job_work_order_draft(v_id, 'backfill');
      v_opened := v_opened + 1;
      v_opened_ids := v_opened_ids || v_id;
    ELSE
      v_skipped := v_skipped + 1;
      v_skipped_jobs := v_skipped_jobs || jsonb_build_array(
        jsonb_build_object('job_id', v_id, 'reason', v_reason)
      );
    END IF;
  END LOOP;
  RETURN jsonb_build_object(
    'opened', v_opened,
    'opened_ids', to_jsonb(v_opened_ids),
    'skipped', v_skipped,
    'skipped_jobs', v_skipped_jobs,
    'as_of', now()
  );
END;
$$;
REVOKE ALL ON FUNCTION public.apply_active_job_work_orders(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_active_job_work_orders(uuid[]) TO service_role;

-- ── 5. the record of every draft this rule removes ──────────────────────────

-- work_order is the whole work_orders row as it stood. Nothing but
-- retire_blank_makesafe_job_work_orders writes here.
CREATE TABLE IF NOT EXISTS public.job_work_order_retired_drafts (
  work_order_id uuid PRIMARY KEY,
  job_id uuid NOT NULL,
  org_id uuid,
  job_type text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('makesafe_no_job_work_order')),
  job_pointer_cleared boolean NOT NULL DEFAULT false,
  work_order jsonb NOT NULL,
  retired_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_work_order_retired_drafts_job_idx
  ON public.job_work_order_retired_drafts (job_id);
COMMENT ON TABLE public.job_work_order_retired_drafts IS
  'Every blank draft job work order removed because its job type never gets one (make-safe, owner decision 11 Nov 2026). work_order is the whole work_orders row as it stood.';
ALTER TABLE public.job_work_order_retired_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.job_work_order_retired_drafts FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.job_work_order_retired_drafts FROM service_role;
GRANT SELECT ON TABLE public.job_work_order_retired_drafts TO service_role;
DROP POLICY IF EXISTS job_work_order_retired_drafts_service_role_read ON public.job_work_order_retired_drafts;
CREATE POLICY job_work_order_retired_drafts_service_role_read ON public.job_work_order_retired_drafts
  FOR SELECT TO service_role USING (true);

-- ── 6. retire the blank make-safe drafts ────────────────────────────────────

-- Returns how many drafts it removed. A second call returns 0. Not callable
-- by any API role.
CREATE OR REPLACE FUNCTION public.retire_blank_makesafe_job_work_orders()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row record;
  v_cleared integer;
  v_count integer := 0;
BEGIN
  FOR v_row IN
    SELECT wo.id, wo.job_id, wo.org_id, j.type AS job_type, to_jsonb(wo) AS work_order
    FROM public.work_orders wo
    JOIN public.jobs j ON j.id = wo.job_id
    WHERE wo.kind = 'job'
      AND wo.status = 'draft'
      AND public.job_type_never_gets_job_work_order(j.type)
      -- blank: nothing was ever put on it
      AND wo.agreed_labour_ex IS NULL
      AND (wo.scope_items IS NULL OR wo.scope_items IN ('[]'::jsonb, 'null'::jsonb))
      AND COALESCE(btrim(wo.special_instructions), '') = ''
      AND wo.scheduled_date IS NULL
      AND wo.assigned_user_id IS NULL
      AND COALESCE(btrim(wo.trade_name), '') = ''
      -- untouched: nobody edited, filled, sent, read or approved it
      AND wo.hand_edited_at IS NULL
      AND wo.quote_filled_at IS NULL
      AND wo.sent_at IS NULL
      AND wo.viewed_at IS NULL
      AND wo.accepted_at IS NULL
      AND wo.completed_at IS NULL
      AND wo.approved_at IS NULL
      AND wo.approved_by IS NULL
      AND wo.scope_revision_id IS NULL
      AND wo.quote_filled_scope_revision_id IS NULL
      AND wo.price_approval_id IS NULL
      AND wo.work_order_approval_id IS NULL
      -- unreferenced: nothing points at it
      AND NOT EXISTS (SELECT 1 FROM public.trade_invoice_lines l
                      WHERE l.job_work_order_id = wo.id OR l.source_work_order_id = wo.id)
      AND NOT EXISTS (SELECT 1 FROM public.trade_invoices ti WHERE ti.work_order_id = wo.id)
      AND NOT EXISTS (SELECT 1 FROM public.group_work_orders g WHERE g.work_order_id = wo.id)
      AND NOT EXISTS (SELECT 1 FROM public.work_order_variations v WHERE v.work_order_id = wo.id)
      AND NOT EXISTS (SELECT 1 FROM public.work_order_customer_variations cv WHERE cv.work_order_id = wo.id)
      AND NOT EXISTS (SELECT 1 FROM public.scope_job_draft_sets s WHERE s.work_order_id = wo.id)
      AND NOT EXISTS (SELECT 1 FROM public.scope_owner_approvals a WHERE a.work_order_id = wo.id)
      AND NOT EXISTS (SELECT 1 FROM public.job_work_order_owner_unapproved u WHERE u.work_order_id = wo.id)
    ORDER BY wo.id
    FOR UPDATE OF wo
  LOOP
    UPDATE public.jobs SET work_order_id = NULL
      WHERE id = v_row.job_id AND work_order_id = v_row.id;
    GET DIAGNOSTICS v_cleared = ROW_COUNT;
    INSERT INTO public.job_work_order_retired_drafts
      (work_order_id, job_id, org_id, job_type, reason, job_pointer_cleared, work_order)
    VALUES
      (v_row.id, v_row.job_id, v_row.org_id, v_row.job_type, 'makesafe_no_job_work_order',
       v_cleared > 0, v_row.work_order)
    ON CONFLICT (work_order_id) DO NOTHING;
    DELETE FROM public.work_orders
      WHERE id = v_row.id AND kind = 'job' AND status = 'draft';
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.retire_blank_makesafe_job_work_orders()
  FROM PUBLIC, anon, authenticated, service_role;

SELECT public.retire_blank_makesafe_job_work_orders();

-- ── 7. the flag says what it does now ───────────────────────────────────────

-- enabled is not written.
UPDATE public.feature_flags
SET description = 'Open a blank job work order for every job type except make-safe when the job enters an open status. A make-safe job never gets a job work order (owner decision 11 Nov 2026). Fencing and patio are unchanged either way. Off: other types still raise.'
WHERE flag_name = 'job_work_order_all_types_v1';
