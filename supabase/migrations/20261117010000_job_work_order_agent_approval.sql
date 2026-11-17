-- A server-secret agent (SecureSuite / a Grok bot) may approve a job work
-- order as itself. The terminal path stays as it is: x-sw-actor user:<id>
-- still needs work_order_terminal_approval_v1 and a named approver. An
-- agent:<account> actor is a different caller. It is not on
-- work_order_settings, and it must not be written down as that person.
--
-- The seal records three facts on the work order:
--   approved_by_actor  the caller (agent:<account>)
--   approved_by_name   any name the caller passed, or null
--   approved_at        when the database sealed it
-- approved_by stays null and approved_via is 'agent'.
--
-- This does not record an owner decision. While
-- owner_approval_saved_revision_required_v1 is on, the call is refused
-- WO428, the same hold a person who is not deciding under that switch meets
-- when the decision is missing. Invoice approval, customer variations and
-- the owner price decision are untouched.
--
-- Additive: two columns, a wider approved_via check, and one RPC. The seal
-- trigger is the same body as 20261109040000 plus the agent branch.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS approved_by_actor text,
  ADD COLUMN IF NOT EXISTS approved_by_name text;

COMMENT ON COLUMN public.work_orders.approved_by_actor IS
  'The agent caller that sealed this job work order (agent:<account>), 20261117010000. Null on a person or automatic issue.';
COMMENT ON COLUMN public.work_orders.approved_by_name IS
  'The name that caller passed (approved_by_name, or approved_by when that was text). Null when none was passed.';

ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_approved_via_check;
ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_approved_via_check
  CHECK (approved_via IS NULL OR approved_via IN ('session', 'terminal', 'auto', 'agent'));

ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_approved_sealed_check;
ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_approved_sealed_check
  CHECK (
    status <> 'approved'
    OR (
      approved_at IS NOT NULL
      AND agreed_labour_ex IS NOT NULL
      AND sealed_content_hash IS NOT NULL
      AND (
        (approved_via = 'auto' AND approved_by IS NULL)
        OR (
          approved_via = 'agent'
          AND approved_by IS NULL
          AND approved_by_actor IS NOT NULL
        )
        OR (
          approved_via IS DISTINCT FROM 'auto'
          AND approved_via IS DISTINCT FROM 'agent'
          AND approved_by IS NOT NULL
        )
      )
    )
  );

ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_agent_approval_check;
ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_agent_approval_check
  CHECK (
    approved_via IS DISTINCT FROM 'agent'
    OR (
      approved_by IS NULL
      AND approved_by_actor ~ '^agent:[A-Za-z0-9_.:@-]{1,120}$'
      AND (
        approved_by_name IS NULL
        OR char_length(btrim(approved_by_name)) BETWEEN 1 AND 200
      )
    )
  );

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
    ELSIF NEW.approved_via = 'agent' THEN
      -- Agent approval (20261117010000). The GUC is set only inside
      -- approve_job_work_order_by_agent, so a direct update cannot use this
      -- via. The caller is approved_by_actor, never a users.id, so this is
      -- not an owner decision and does not stand in for one.
      IF current_setting('secureworks.job_work_order_agent_approve', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'an agent approves a job work order only through approve_job_work_order_by_agent'
          USING ERRCODE = '42501';
      END IF;
      IF NEW.approved_by IS NOT NULL THEN
        RAISE EXCEPTION 'an agent approval records the caller on approved_by_actor, not a user id'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.approved_by_actor IS NULL
         OR NEW.approved_by_actor !~ '^agent:[A-Za-z0-9_.:@-]{1,120}$' THEN
        RAISE EXCEPTION 'an agent approval records which caller approved it'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.approved_by_name IS NOT NULL
         AND (char_length(btrim(NEW.approved_by_name)) < 1
              OR char_length(NEW.approved_by_name) > 200) THEN
        RAISE EXCEPTION 'approved_by_name must be 1 to 200 characters'
          USING ERRCODE = '23514';
      END IF;
      IF v_required THEN
        RAISE EXCEPTION 'owner_approval_required: an agent approval does not record an owner decision while owner_approval_saved_revision_required_v1 is on'
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


CREATE OR REPLACE FUNCTION public.approve_job_work_order_by_agent(
  p_work_order_id uuid,
  p_actor text,
  p_approved_by_name text,
  p_expected_updated_at timestamptz,
  p_org_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_wo public.work_orders%ROWTYPE;
  v_out public.work_orders%ROWTYPE;
  v_name text;
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^agent:[A-Za-z0-9_.:@-]{1,120}$' THEN
    RAISE EXCEPTION 'agent_actor_required' USING ERRCODE = '42501';
  END IF;
  v_name := NULLIF(btrim(p_approved_by_name), '');
  IF v_name IS NOT NULL AND char_length(v_name) > 200 THEN
    RAISE EXCEPTION 'approved_by_name must be at most 200 characters' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_wo FROM public.work_orders WHERE id = p_work_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work order not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_wo.kind <> 'job' THEN
    RAISE EXCEPTION 'only a job work order is approved' USING ERRCODE = '23514';
  END IF;
  IF p_org_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.jobs j
    WHERE j.id = v_wo.job_id AND j.org_id = p_org_id
  ) THEN
    RAISE EXCEPTION 'scope_owner_approval_job_forbidden' USING ERRCODE = '42501';
  END IF;
  IF v_wo.status <> 'draft' THEN
    RAISE EXCEPTION 'work order is %, not draft', v_wo.status USING ERRCODE = '23514';
  END IF;
  IF p_expected_updated_at IS NULL OR v_wo.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'The draft changed after it was read. Read it again before approving.'
      USING ERRCODE = 'WO409';
  END IF;
  -- The saved-revision owner switch is a separate hold. An agent is not an
  -- owner decision, so it does not satisfy that switch and does not skip it.
  IF public.owner_approval_required() THEN
    RAISE EXCEPTION 'owner_approval_required: an agent approval does not record an owner decision while owner_approval_saved_revision_required_v1 is on'
      USING ERRCODE = 'WO428';
  END IF;

  PERFORM set_config('secureworks.owner_unapproved_hold', 'on', true);
  PERFORM set_config('secureworks.job_work_order_agent_approve', 'on', true);
  UPDATE public.work_orders
    SET status = 'approved',
        approved_by = NULL,
        approved_at = now(),
        approved_via = 'agent',
        approved_by_actor = p_actor,
        approved_by_name = v_name
    WHERE id = v_wo.id
    RETURNING * INTO v_out;
  PERFORM set_config('secureworks.job_work_order_agent_approve', 'off', true);
  PERFORM public.link_issued_job_work_order(v_out.id);
  PERFORM set_config('secureworks.owner_unapproved_hold', 'off', true);
  PERFORM public.flush_owner_unapproved();
  RETURN to_jsonb(v_out);
END $$;

COMMENT ON FUNCTION public.approve_job_work_order_by_agent(uuid, text, text, timestamptz, uuid) IS
  'Job work order agent approval (20261117010000): a server-secret agent caller seals a draft and records its actor, any approved_by name, and approved_at. Not an owner decision.';

REVOKE ALL ON FUNCTION public.approve_job_work_order_by_agent(uuid, text, text, timestamptz, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_job_work_order_by_agent(uuid, text, text, timestamptz, uuid)
  TO service_role;
