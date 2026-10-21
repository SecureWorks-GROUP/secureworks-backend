-- 20261016120000_job_work_order_auto_issue.sql
--
-- A job work order goes to the trades without a human approval (captain,
-- 14 Oct 2026): the draft opened for an approved fencing or patio job
-- (20261012130000) is filled from the accepted quote and then issued by the
-- system, sealed exactly as an approval seals it. Only a customer variation
-- still waits for the work order approver (20261013140000, unchanged).
--
-- What it adds:
--   1. work_orders.quote_filled_at: stamped by the quote fill of an untouched
--      draft (ops-api job_work_order_quote_fill.ts), and only by it.
--      work_orders.hand_edited_at: stamped by the database whenever anything
--      else changes a job draft's content (scope, instructions, agreed labour,
--      date, address). A caller can never write either stamp directly.
--   2. approved_via 'auto': an issue by the system, with no approver
--      (approved_by NULL). Made only by auto_issue_job_work_order, only while
--      feature flag job_work_order_auto_issue_v1 is on (seeded OFF), and only
--      for a draft the quote fill wrote that nobody has edited since. A draft
--      someone edited by hand waits for the approver as before; an approved
--      work order is sealed and never touched.
--   3. auto_issue_job_work_order(work_order_id, expected_updated_at): the one
--      door. It seals only the draft as the system read it (the same stale
--      read guard as approve_job_work_order) and links labour and trade
--      variations already on the job, as an approval does.
--   4. pg_cron job-work-order-auto-issue (every 2 minutes): posts ops-api
--      auto_issue_job_work_orders while the flag is on, a no-op otherwise.
--      ops-api checks the flag again before writing anything.
--   5. Drafts the quote fill wrote before this migration (it shipped on
--      13 Oct 2026) get their quote_filled_at when no write landed after the
--      fill's own event; anything else is left for the approver. Drafts that
--      carry instructions, a date or an address the open path never wrote are
--      stamped hand_edited_at first (section 1).
--
-- Nothing here sends, writes Xero, or issues a work order: while the flag is
-- off every path stays exactly as it was.

-- ── 1. the stamps ────────────────────────────────────────────────────────────

ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS quote_filled_at timestamptz,
  ADD COLUMN IF NOT EXISTS hand_edited_at timestamptz;

COMMENT ON COLUMN public.work_orders.quote_filled_at IS
  'Job work orders: when the quote fill wrote this draft from the accepted quote. Stamped only by that fill of an untouched draft; the trigger refuses any other write.';
COMMENT ON COLUMN public.work_orders.hand_edited_at IS
  'Job work orders: the last time anything other than the quote fill changed this draft''s content. Set by the trigger only. A draft with a value here is never issued automatically.';

-- Drafts written into by hand before this migration: the open path
-- (ensure_job_work_order_draft) writes no special instructions, no date and
-- the job's address at the time, so a draft carrying any other of the three
-- was edited by hand. Stamped once, here, while the 20261012130000 trigger
-- (which does not touch the new columns) is still in place, so it is never
-- filled with the stamp or issued automatically; it waits for the approver.
UPDATE public.work_orders wo
  SET hand_edited_at = wo.updated_at
  FROM public.jobs j
  WHERE j.id = wo.job_id
    AND wo.kind = 'job' AND wo.status = 'draft'
    AND wo.quote_filled_at IS NULL AND wo.hand_edited_at IS NULL
    AND (COALESCE(btrim(wo.special_instructions), '') <> ''
         OR wo.scheduled_date IS NOT NULL
         OR wo.site_address IS DISTINCT FROM
              NULLIF(concat_ws(', ', NULLIF(j.site_address, ''), NULLIF(j.site_suburb, '')), ''));

-- ── 2. approved_via auto ─────────────────────────────────────────────────────

ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_approved_via_check;
ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_approved_via_check
  CHECK (approved_via IS NULL OR approved_via IN ('session', 'terminal', 'auto'));

ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_approved_sealed_check;
ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_approved_sealed_check
  CHECK (
    status <> 'approved'
    OR (approved_at IS NOT NULL
        AND (approved_by IS NOT NULL OR approved_via = 'auto')
        AND agreed_labour_ex IS NOT NULL AND sealed_content_hash IS NOT NULL)
  );

-- An automatic issue names no approver; a human approval always names one.
ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_auto_issue_check;
ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_auto_issue_check
  CHECK (approved_via IS DISTINCT FROM 'auto' OR approved_by IS NULL);

INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES
  ('job_work_order_auto_issue_v1', false,
   'Issue a job work order to the trades as soon as it is filled from the accepted quote, with no human approval (approved_via auto). Customer variations still need the approver. Off until the captain says make it live.')
ON CONFLICT (flag_name) DO NOTHING;

-- ── 3. the seal, with the stamps and the automatic issue ─────────────────────

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

-- ── 4. the automatic issue ───────────────────────────────────────────────────

-- Seals the draft as the system read it (p_expected_updated_at, compared under
-- the row lock: SQLSTATE WO409 when a write landed after the read) and, as
-- approve_job_work_order does, points the job at it and links labour and trade
-- variations already on the job. Refuses (42501) while the flag is off, and
-- (WO423) a draft the quote fill did not write or someone edited by hand.
CREATE OR REPLACE FUNCTION public.auto_issue_job_work_order(
  p_work_order_id uuid,
  p_expected_updated_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_wo public.work_orders%ROWTYPE;
  v_out public.work_orders%ROWTYPE;
BEGIN
  IF NOT COALESCE((SELECT f.enabled FROM public.feature_flags f
                   WHERE f.flag_name = 'job_work_order_auto_issue_v1' LIMIT 1), false) THEN
    RAISE EXCEPTION 'automatic issue of job work orders is switched off (feature flag job_work_order_auto_issue_v1)'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_wo FROM public.work_orders WHERE id = p_work_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work order not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_wo.kind <> 'job' THEN
    RAISE EXCEPTION 'only a job work order is issued' USING ERRCODE = '23514';
  END IF;
  IF v_wo.status <> 'draft' THEN
    RAISE EXCEPTION 'work order is %, not draft', v_wo.status USING ERRCODE = '23514';
  END IF;
  IF p_expected_updated_at IS NULL OR v_wo.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'The draft changed after it was read. Read it again.'
      USING ERRCODE = 'WO409';
  END IF;
  IF v_wo.quote_filled_at IS NULL OR v_wo.hand_edited_at IS NOT NULL THEN
    RAISE EXCEPTION 'only a draft filled from the quote and not edited by hand is issued automatically'
      USING ERRCODE = 'WO423';
  END IF;

  PERFORM set_config('secureworks.job_work_order_auto_issue', 'on', true);
  UPDATE public.work_orders
    SET status = 'approved', approved_by = NULL, approved_at = now(), approved_via = 'auto'
    WHERE id = v_wo.id
    RETURNING * INTO v_out;
  PERFORM set_config('secureworks.job_work_order_auto_issue', 'off', true);

  UPDATE public.jobs SET work_order_id = v_out.id WHERE id = v_out.job_id;

  UPDATE public.trade_invoice_lines til
    SET job_work_order_id = v_out.id
    FROM public.trade_invoices ti
    WHERE ti.id = til.trade_invoice_id
      AND til.job_id = v_out.job_id
      AND til.job_work_order_id IS NULL
      AND ti.status = ANY (public.job_work_order_billed_invoice_statuses());

  UPDATE public.work_order_variations
    SET work_order_id = v_out.id
    WHERE job_id = v_out.job_id AND work_order_id IS NULL;

  RETURN to_jsonb(v_out);
END;
$$;
REVOKE ALL ON FUNCTION public.auto_issue_job_work_order(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_issue_job_work_order(uuid, timestamptz) TO service_role;

-- ── 5. drafts the quote fill wrote before this migration ─────────────────────

-- The fill writes the draft and then its job_work_order_draft_filled_from_quote
-- event, so a draft last written no later than its newest fill event, holding
-- only quote lines, has not been edited since the fill. Anything else keeps
-- quote_filled_at NULL and waits for the approver.
DO $prior_fill$
BEGIN
  PERFORM set_config('secureworks.job_work_order_fill_stamp', 'prior_fill', true);
  UPDATE public.work_orders wo
    SET quote_filled_at = e.filled_at
    FROM (
      SELECT ev.job_id, max(ev.created_at) AS filled_at
      FROM public.job_events ev
      WHERE ev.event_type = 'job_work_order_draft_filled_from_quote'
      GROUP BY ev.job_id
    ) e
    WHERE wo.kind = 'job' AND wo.status = 'draft'
      AND wo.job_id = e.job_id
      AND wo.quote_filled_at IS NULL AND wo.hand_edited_at IS NULL
      AND wo.updated_at <= e.filled_at
      AND jsonb_typeof(wo.scope_items) = 'array'
      AND jsonb_array_length(wo.scope_items) > 0
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(wo.scope_items) item
        WHERE item->>'source' IS DISTINCT FROM 'quote'
      )
      AND COALESCE(btrim(wo.special_instructions), '') = '';
  PERFORM set_config('secureworks.job_work_order_fill_stamp', '', true);
END;
$prior_fill$;

-- ── 6. the sweep (a no-op while the flag is off) ─────────────────────────────

CREATE OR REPLACE FUNCTION public.trigger_job_work_order_auto_issue()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT COALESCE((SELECT f.enabled FROM public.feature_flags f
                   WHERE f.flag_name = 'job_work_order_auto_issue_v1' LIMIT 1), false) THEN
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=auto_issue_job_work_orders',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || public.sw_service_key(),
      'Content-Type', 'application/json',
      'x-sw-actor', 'job-work-order-auto-issue-cron'
    ),
    body := jsonb_build_object('actor', 'job-work-order-auto-issue-cron'),
    timeout_milliseconds := 30000
  );
END $$;
COMMENT ON FUNCTION public.trigger_job_work_order_auto_issue() IS
  'pg_cron job-work-order-auto-issue (every 2 minutes): posts ops-api auto_issue_job_work_orders with the service key while feature flag job_work_order_auto_issue_v1 is on. Otherwise a no-op.';
REVOKE ALL ON FUNCTION public.trigger_job_work_order_auto_issue() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_job_work_order_auto_issue() TO service_role, postgres;

DO $cron$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'job work order auto issue: pg_cron absent, sweep not scheduled';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'job-work-order-auto-issue') THEN
    PERFORM cron.schedule('job-work-order-auto-issue', '*/2 * * * *',
      $cmd$SELECT public.trigger_job_work_order_auto_issue()$cmd$);
  END IF;
END $cron$;
