-- Roll back 20261117010000_job_work_order_agent_approval.
-- Restores the 20261109040000 seal and the approved_via / sealed checks from
-- 20261016120000. Drops the agent columns. Refuses if an agent-sealed row
-- exists, because that row would no longer satisfy the restored check.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.work_orders WHERE approved_via = 'agent'
  ) THEN
    RAISE EXCEPTION 'cannot roll back agent work-order approval while an agent-sealed work order exists';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.approve_job_work_order_by_agent(uuid, text, text, timestamptz, uuid);

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
  v_hash text;
  v_gate jsonb;
  v_required boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.kind = 'job' AND OLD.status = 'approved' THEN
      RAISE EXCEPTION 'an approved job work order is sealed and cannot be deleted'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.price_approval_id := NULL;
    NEW.work_order_approval_id := NULL;
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

  -- (added) Only the seal below stamps the decision ids.
  NEW.price_approval_id := OLD.price_approval_id;
  NEW.work_order_approval_id := OLD.work_order_approval_id;

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
    v_hash := public.job_work_order_content_hash(NEW);
    v_required := public.owner_approval_required();
    -- (added) Switch on: the gate decides here. Switch off: the gate is not
    -- read here at all; the issue goes as before and what the switch would
    -- have wanted is worked out and recorded last, after the staff action
    -- (owner_unapproved_queue / flush_owner_unapproved).
    IF v_required THEN
      v_gate := public.job_work_order_owner_gate(NEW, v_hash);
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
      -- (added) With the switch on, the automatic issue carries out both owner
      -- decisions and never stands in for them.
      IF v_required AND (NOT (v_gate->>'bound')::boolean OR jsonb_array_length(v_gate->'missing') > 0) THEN
        RAISE EXCEPTION 'owner_approval_required: % (an automatic issue needs both owner approvals for the work order''s saved revision)',
          (SELECT string_agg(m, ', ') FROM jsonb_array_elements_text(v_gate->'missing') m)
          USING ERRCODE = 'WO428';
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
      v_approvers := COALESCE(v_approvers, '{}'::uuid[])
        || COALESCE((SELECT s.owner_user_ids FROM public.work_order_settings s WHERE s.id = 1), '{}'::uuid[]);
      IF NEW.approved_by IS NULL OR NOT (NEW.approved_by = ANY (v_approvers)) THEN
        RAISE EXCEPTION 'only an approver named in work_order_settings can approve a job work order'
          USING ERRCODE = '42501';
      END IF;
      IF v_required THEN
        IF NOT (v_gate->>'bound')::boolean THEN
          RAISE EXCEPTION 'owner_approval_required: saved_revision (a work order with no saved revision cannot be approved while owner_approval_saved_revision_required_v1 is on)'
            USING ERRCODE = 'WO428';
        ELSIF jsonb_array_length(v_gate->'missing') > 0 THEN
          RAISE EXCEPTION 'owner_approval_required: % (a work order on a saved revision is approved only with both owner approvals for that revision)',
            (SELECT string_agg(m, ', ') FROM jsonb_array_elements_text(v_gate->'missing') m)
            USING ERRCODE = 'WO428';
        ELSIF NEW.approved_by IS DISTINCT FROM (v_gate->>'work_order_approver')::uuid THEN
          RAISE EXCEPTION 'the seal names the person who approved the work order'
            USING ERRCODE = '42501';
        END IF;
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
    NEW.sealed_content_hash := v_hash;
    IF v_required THEN
      NEW.price_approval_id := (v_gate->>'price_approval_id')::uuid;
      NEW.work_order_approval_id := (v_gate->>'work_order_approval_id')::uuid;
    ELSE
      -- (added) Switch off: sealed as before, with no decision ids. Whether
      -- the switch would have refused it is worked out after the action.
      PERFORM public.owner_unapproved_queue(jsonb_build_object('kind', 'issued', 'id', NEW.id));
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_agent_approval_check;

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

ALTER TABLE public.work_orders DROP COLUMN IF EXISTS approved_by_name;
ALTER TABLE public.work_orders DROP COLUMN IF EXISTS approved_by_actor;
