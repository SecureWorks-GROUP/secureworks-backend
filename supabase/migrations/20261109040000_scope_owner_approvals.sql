-- Owner approval of the price and of the work order (TK-S28).
--
-- Two explicit decisions, each a row in scope_owner_approvals:
--   price       the job's frozen scope and pricing revision, as frozen.
--   work_order  one job work order's exact content, on the same revision.
-- Each names the signed-in approver, the time, and the authority it was
-- given: owner (work_order_settings.owner_user_ids), approver_list or
-- backup_approver_list (the existing named lists). A seal, a complete price,
-- a customer acceptance or an office role is never one of these decisions.
--
-- One policy, enforced by the seal trigger (work_orders_job_kind_guard): a
-- job work order bound to a saved revision is approved only when both
-- decisions exist for that revision and its current content, whichever path
-- seals it (release on acceptance, the manual approval RPCs, the automatic
-- issue, a backfill, a direct write). The automatic issue may carry out an
-- issue both decisions already allow; it never creates a decision.
--
-- A customer acceptance with an approval missing is retained on the draft set
-- and the issue waits. The decision that completes the pair issues it in the
-- same transaction (release then seal, so the existing release guard holds).
--
-- An order with no saved revision keeps the existing named-approver rule until
-- the owner turns on owner_approval_saved_revision_required_v1 (seeded off),
-- which then refuses it, and refuses a quote send that names no revision.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ── 1. settings and switch ───────────────────────────────────────────────────

ALTER TABLE public.work_order_settings
  ADD COLUMN IF NOT EXISTS owner_user_ids uuid[] NOT NULL DEFAULT '{}';
COMMENT ON COLUMN public.work_order_settings.owner_user_ids IS
  'Users whose price and work order approvals are recorded with authority owner. Written by the owner''s go-live settings step, never by a migration. Empty means no approval is labelled owner; the named lists still approve.';

INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES
  ('owner_approval_saved_revision_required_v1', false,
   'When on, a quote send that names no saved scope revision is refused, and a job work order with no saved revision cannot be approved. Off until the fence tool sends a saved revision and the owner says so. While off, each such send is logged as unapproved.')
ON CONFLICT (flag_name) DO NOTHING;

-- ── 2. the decisions ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.scope_owner_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('price', 'work_order')),
  -- No foreign key on the job or the work order: a decision outlives the
  -- draft it was made on and never blocks removing one.
  job_id uuid NOT NULL,
  org_id uuid,
  scope_revision_id uuid REFERENCES public.scope_revisions(id),
  scope_hash text,
  pricing_hash text,
  work_order_id uuid,
  work_order_content_hash text,
  work_order_updated_at timestamptz,
  approver_user_id uuid NOT NULL,
  authority text NOT NULL
    CHECK (authority IN ('owner', 'approver_list', 'backup_approver_list')),
  via text NOT NULL CHECK (via IN ('session', 'terminal')),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT scope_owner_approvals_shape_check CHECK (
    (kind = 'price' AND scope_revision_id IS NOT NULL AND scope_hash IS NOT NULL
      AND pricing_hash IS NOT NULL AND work_order_id IS NULL
      AND work_order_content_hash IS NULL)
    OR (kind = 'work_order' AND work_order_id IS NOT NULL
      AND work_order_content_hash ~ '^[0-9a-f]{64}$')
  )
);
COMMENT ON TABLE public.scope_owner_approvals IS
  'Owner approval decisions (20261109040000): price on a frozen scope revision, work order on its exact content and revision. Append only; written only by record_scope_price_approval and record_job_work_order_approval.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_scope_owner_approvals_price
  ON public.scope_owner_approvals (job_id, scope_revision_id)
  WHERE kind = 'price';
CREATE UNIQUE INDEX IF NOT EXISTS uq_scope_owner_approvals_work_order
  ON public.scope_owner_approvals (
    work_order_id, work_order_content_hash,
    COALESCE(scope_revision_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE kind = 'work_order';
CREATE INDEX IF NOT EXISTS idx_scope_owner_approvals_job
  ON public.scope_owner_approvals (job_id, decided_at DESC);

ALTER TABLE public.scope_owner_approvals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scope_owner_approvals FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.scope_owner_approvals TO service_role;
DROP POLICY IF EXISTS scope_owner_approvals_service_role_read ON public.scope_owner_approvals;
CREATE POLICY scope_owner_approvals_service_role_read ON public.scope_owner_approvals
  FOR SELECT TO service_role USING (true);

CREATE OR REPLACE FUNCTION public.scope_owner_approvals_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'owner approval decisions are append only' USING ERRCODE = '23514';
END $$;
DROP TRIGGER IF EXISTS trg_scope_owner_approvals_append_only ON public.scope_owner_approvals;
CREATE TRIGGER trg_scope_owner_approvals_append_only
  BEFORE UPDATE OR DELETE ON public.scope_owner_approvals
  FOR EACH ROW EXECUTE FUNCTION public.scope_owner_approvals_append_only();
DROP TRIGGER IF EXISTS trg_scope_owner_approvals_no_truncate ON public.scope_owner_approvals;
CREATE TRIGGER trg_scope_owner_approvals_no_truncate
  BEFORE TRUNCATE ON public.scope_owner_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION public.scope_owner_approvals_append_only();

ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS price_approval_id uuid REFERENCES public.scope_owner_approvals(id),
  ADD COLUMN IF NOT EXISTS work_order_approval_id uuid REFERENCES public.scope_owner_approvals(id);
COMMENT ON COLUMN public.work_orders.price_approval_id IS
  'The price decision the seal checked (20261109040000). Stamped only by the seal trigger.';
COMMENT ON COLUMN public.work_orders.work_order_approval_id IS
  'The work order decision the seal checked (20261109040000). Stamped only by the seal trigger.';

ALTER TABLE public.scope_job_draft_sets
  ADD COLUMN IF NOT EXISTS acceptance_recorded_at timestamptz,
  ADD COLUMN IF NOT EXISTS acceptance_scope_revision_id uuid REFERENCES public.scope_revisions(id),
  ADD COLUMN IF NOT EXISTS acceptance_legacy boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.scope_job_draft_sets.acceptance_recorded_at IS
  'When release_scope_job_drafts retained the customer''s acceptance. The issue then waits for both owner approvals; released_at is set only when the work order is sealed.';

-- ── 3. shared rules ──────────────────────────────────────────────────────────

-- Who may decide. Owner first, then the named lists. Backup approvers count
-- only while job_work_order_office_fill_v1 is on, as in the seal.
CREATE OR REPLACE FUNCTION public.owner_approval_authority(p_user uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.work_order_settings%ROWTYPE;
BEGIN
  IF p_user IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO s FROM public.work_order_settings WHERE id = 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_user = ANY (COALESCE(s.owner_user_ids, '{}'::uuid[])) THEN RETURN 'owner'; END IF;
  IF p_user = ANY (COALESCE(s.approver_user_ids, '{}'::uuid[])) THEN RETURN 'approver_list'; END IF;
  IF p_user = ANY (COALESCE(s.backup_approver_user_ids, '{}'::uuid[]))
     AND COALESCE((SELECT f.enabled FROM public.feature_flags f
                   WHERE f.flag_name = 'job_work_order_office_fill_v1' LIMIT 1), false) THEN
    RETURN 'backup_approver_list';
  END IF;
  RETURN NULL;
END $$;

-- The same digest the seal stores in sealed_content_hash.
CREATE OR REPLACE FUNCTION public.job_work_order_content_hash(w public.work_orders)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object(
    'work_order_id', w.id,
    'job_id', w.job_id,
    'wo_number', w.wo_number,
    'scope_items', COALESCE(w.scope_items, '[]'::jsonb),
    'special_instructions', w.special_instructions,
    'site_address', w.site_address,
    'scheduled_date', w.scheduled_date,
    'agreed_labour_ex', w.agreed_labour_ex
  )::text, 'UTF8')), 'hex');
$$;

-- What the seal would refuse for content, or NULL when it is ready.
CREATE OR REPLACE FUNCTION public.job_work_order_not_ready(w public.work_orders)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_type text;
BEGIN
  IF w.job_id IS NULL THEN RETURN 'a job work order needs its job'; END IF;
  IF w.agreed_labour_ex IS NULL THEN RETURN 'set the agreed labour amount before approving'; END IF;
  IF COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(w.scope_items) = 'array' THEN w.scope_items END), 0) = 0
     AND COALESCE(btrim(w.special_instructions), '') = '' THEN
    SELECT j.type INTO v_type FROM public.jobs j WHERE j.id = w.job_id;
    IF COALESCE(btrim(v_type), '') IN ('fencing', 'patio', '') THEN
      RETURN 'add the scope before approving';
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.scope_owner_approval_json(a public.scope_owner_approvals)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object(
    'id', a.id, 'kind', a.kind, 'job_id', a.job_id,
    'scope_revision_id', a.scope_revision_id,
    'work_order_id', a.work_order_id,
    'work_order_content_hash', a.work_order_content_hash,
    'approver_user_id', a.approver_user_id,
    'authority', a.authority, 'via', a.via, 'decided_at', a.decided_at)) END;
$$;

-- The policy, read without locks. bound: the order names a saved revision
-- (its prepared revision or its quote fill revision; two different ones are a
-- conflict and never issue). For a bound order, missing names each absent
-- decision for that revision and the order's current content.
CREATE OR REPLACE FUNCTION public.job_work_order_owner_gate(w public.work_orders, p_hash text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_rev uuid := COALESCE(w.scope_revision_id, w.quote_filled_scope_revision_id);
  v_hash text := COALESCE(p_hash, public.job_work_order_content_hash(w));
  v_price public.scope_owner_approvals%ROWTYPE;
  v_order public.scope_owner_approvals%ROWTYPE;
  v_missing text[] := '{}';
BEGIN
  IF w.scope_revision_id IS NOT NULL AND w.quote_filled_scope_revision_id IS NOT NULL
     AND w.scope_revision_id <> w.quote_filled_scope_revision_id THEN
    RETURN jsonb_build_object('bound', true, 'revision_id', NULL, 'content_hash', v_hash,
      'missing', jsonb_build_array('work_order_revision_conflict'));
  END IF;
  IF v_rev IS NULL THEN
    RETURN jsonb_build_object('bound', false, 'revision_id', NULL, 'content_hash', v_hash,
      'missing', jsonb_build_array('saved_revision'));
  END IF;
  SELECT * INTO v_price FROM public.scope_owner_approvals a
    WHERE a.kind = 'price' AND a.job_id = w.job_id AND a.scope_revision_id = v_rev;
  IF NOT FOUND THEN v_missing := v_missing || 'price_approval'::text; END IF;
  SELECT * INTO v_order FROM public.scope_owner_approvals a
    WHERE a.kind = 'work_order' AND a.work_order_id = w.id
      AND a.scope_revision_id = v_rev AND a.work_order_content_hash = v_hash;
  IF NOT FOUND THEN v_missing := v_missing || 'work_order_approval'::text; END IF;
  RETURN jsonb_build_object('bound', true, 'revision_id', v_rev, 'content_hash', v_hash,
    'price_approval_id', v_price.id, 'work_order_approval_id', v_order.id,
    'work_order_approver', v_order.approver_user_id, 'work_order_via', v_order.via,
    'price_approval', public.scope_owner_approval_json(v_price),
    'work_order_approval', public.scope_owner_approval_json(v_order),
    'missing', to_jsonb(v_missing));
END $$;

-- Everything an issue still waits for, for a bound order. A shared-lane order
-- not yet released also needs the retained customer acceptance of the same
-- revision, an open job and its prepared source unchanged.
CREATE OR REPLACE FUNCTION public.job_work_order_issue_check(w public.work_orders)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  g jsonb := public.job_work_order_owner_gate(w);
  v_missing jsonb := g->'missing';
  s public.scope_job_draft_sets%ROWTYPE;
  v_status text;
  v_not_ready text := public.job_work_order_not_ready(w);
BEGIN
  SELECT * INTO s FROM public.scope_job_draft_sets d WHERE d.work_order_id = w.id;
  IF FOUND AND s.released_at IS NULL THEN
    SELECT j.status INTO v_status FROM public.jobs j WHERE j.id = w.job_id;
    IF s.acceptance_recorded_at IS NULL OR s.acceptance_scope_revision_id IS DISTINCT FROM s.scope_revision_id THEN
      v_missing := v_missing || '"customer_acceptance"'::jsonb;
    ELSIF NOT (v_status = ANY (public.job_work_order_open_statuses())) THEN
      v_missing := v_missing || '"job_not_open"'::jsonb;
    ELSIF NOT EXISTS (SELECT 1 FROM public.scope_revisions r
      WHERE r.id = s.scope_revision_id AND r.job_id = w.job_id AND r.status IN ('frozen', 'superseded')
        AND w.scope_revision_id = r.id AND w.scope_items = s.labour_lines
        AND w.agreed_labour_ex IS NOT DISTINCT FROM s.labour_total_cents / 100.0
        AND (NOT s.acceptance_legacy OR r.status = 'frozen' AND NOT EXISTS (
          SELECT 1 FROM public.scope_revisions n WHERE n.job_id = w.job_id AND n.revision_number > r.revision_number))) THEN
      v_missing := v_missing || '"source_changed"'::jsonb;
    END IF;
  END IF;
  IF v_not_ready IS NOT NULL THEN v_missing := v_missing || '"work_order_incomplete"'::jsonb; END IF;
  RETURN g || jsonb_build_object('missing', v_missing, 'shared_lane', s.job_id IS NOT NULL);
END $$;

-- Links that follow every issue: the job's live work order, labour invoiced
-- before it, and variations raised before it.
CREATE OR REPLACE FUNCTION public.link_issued_job_work_order(p_work_order_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE w public.work_orders%ROWTYPE;
BEGIN
  SELECT * INTO w FROM public.work_orders WHERE id = p_work_order_id;
  IF NOT FOUND OR w.kind <> 'job' OR w.status <> 'approved' THEN RETURN; END IF;
  UPDATE public.jobs SET work_order_id = w.id WHERE id = w.job_id;
  UPDATE public.trade_invoice_lines til
    SET job_work_order_id = w.id
    FROM public.trade_invoices ti
    WHERE ti.id = til.trade_invoice_id
      AND til.job_id = w.job_id
      AND til.job_work_order_id IS NULL
      AND ti.status = ANY (public.job_work_order_billed_invoice_statuses());
  UPDATE public.work_order_variations
    SET work_order_id = w.id
    WHERE job_id = w.job_id AND work_order_id IS NULL;
END $$;

-- ── 4. the seal: one policy for every path ───────────────────────────────────

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
  v_unbound_decision uuid;
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
    v_gate := public.job_work_order_owner_gate(NEW, v_hash);
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
      -- (added) The automatic issue carries out both owner decisions; it never
      -- stands in for them.
      IF NOT (v_gate->>'bound')::boolean OR jsonb_array_length(v_gate->'missing') > 0 THEN
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
      IF (v_gate->>'bound')::boolean THEN
        IF jsonb_array_length(v_gate->'missing') > 0 THEN
          RAISE EXCEPTION 'owner_approval_required: % (a work order on a saved revision is approved only with both owner approvals for that revision)',
            (SELECT string_agg(m, ', ') FROM jsonb_array_elements_text(v_gate->'missing') m)
            USING ERRCODE = 'WO428';
        END IF;
        IF NEW.approved_by IS DISTINCT FROM (v_gate->>'work_order_approver')::uuid THEN
          RAISE EXCEPTION 'the seal names the person who approved the work order'
            USING ERRCODE = '42501';
        END IF;
      ELSIF COALESCE((SELECT f.enabled FROM public.feature_flags f
                      WHERE f.flag_name = 'owner_approval_saved_revision_required_v1' LIMIT 1), false) THEN
        RAISE EXCEPTION 'owner_approval_required: saved_revision (a work order with no saved revision cannot be approved while owner_approval_saved_revision_required_v1 is on)'
          USING ERRCODE = 'WO428';
      ELSE
        SELECT a.id INTO v_unbound_decision FROM public.scope_owner_approvals a
          WHERE a.kind = 'work_order' AND a.work_order_id = NEW.id
            AND a.scope_revision_id IS NULL AND a.work_order_content_hash = v_hash
            AND a.approver_user_id = NEW.approved_by;
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
    IF (v_gate->>'bound')::boolean THEN
      NEW.price_approval_id := (v_gate->>'price_approval_id')::uuid;
      NEW.work_order_approval_id := (v_gate->>'work_order_approval_id')::uuid;
    ELSE
      NEW.work_order_approval_id := v_unbound_decision;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- A crew work order on a job whose work comes from a saved revision leaves
-- draft only once that job's work order is issued on both owner decisions.
CREATE OR REPLACE FUNCTION public.work_orders_crew_owner_gate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM 'crew' OR NEW.job_id IS NULL
     OR NEW.status IN ('draft', 'cancelled') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM 'draft' THEN
    RETURN NEW;
  END IF;
  IF NOT (
    NEW.scope_revision_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM public.scope_job_draft_sets d WHERE d.job_id = NEW.job_id)
    OR EXISTS (SELECT 1 FROM public.work_orders j
               WHERE j.job_id = NEW.job_id AND j.kind = 'job'
                 AND COALESCE(j.scope_revision_id, j.quote_filled_scope_revision_id) IS NOT NULL)
  ) THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.work_orders j
    WHERE j.job_id = NEW.job_id AND j.kind = 'job' AND j.status = 'approved'
      AND j.price_approval_id IS NOT NULL AND j.work_order_approval_id IS NOT NULL
      AND (NEW.scope_revision_id IS NULL
        OR COALESCE(j.scope_revision_id, j.quote_filled_scope_revision_id) = NEW.scope_revision_id)
  ) THEN
    RAISE EXCEPTION 'owner_approval_required: a crew work order on a job built from a saved revision leaves draft only after the job work order is issued on both owner approvals'
      USING ERRCODE = 'WO428';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_work_orders_crew_owner_gate ON public.work_orders;
CREATE TRIGGER trg_work_orders_crew_owner_gate
  BEFORE INSERT OR UPDATE ON public.work_orders
  FOR EACH ROW EXECUTE FUNCTION public.work_orders_crew_owner_gate();

-- ── 5. carrying out an issue both decisions allow ────────────────────────────

-- Issues one bound job work order when nothing is missing: for a shared-lane
-- order, release first and then seal, in this transaction. Never raises for a
-- missing decision; it reports what the issue waits for. An unbound order is
-- never issued here.
CREATE OR REPLACE FUNCTION public.issue_owner_approved_job_work_order(p_work_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  w public.work_orders%ROWTYPE;
  v_out public.work_orders%ROWTYPE;
  s public.scope_job_draft_sets%ROWTYPE;
  v_check jsonb;
  v_state text;
  v_error text;
BEGIN
  SELECT * INTO w FROM public.work_orders WHERE id = p_work_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'work order not found' USING ERRCODE = 'P0002'; END IF;
  IF w.kind <> 'job' THEN RAISE EXCEPTION 'only a job work order is issued' USING ERRCODE = '23514'; END IF;
  IF w.status = 'approved' THEN
    RETURN jsonb_build_object('issued', true, 'replayed', true, 'work_order_id', w.id,
      'price_approval_id', w.price_approval_id, 'work_order_approval_id', w.work_order_approval_id,
      'missing', '[]'::jsonb);
  END IF;
  v_check := public.job_work_order_issue_check(w);
  IF NOT (v_check->>'bound')::boolean OR jsonb_array_length(v_check->'missing') > 0 THEN
    RETURN jsonb_build_object('issued', false, 'held', true, 'work_order_id', w.id,
      'scope_revision_id', v_check->'revision_id', 'missing', v_check->'missing');
  END IF;
  SELECT * INTO s FROM public.scope_job_draft_sets d WHERE d.work_order_id = w.id FOR UPDATE;
  BEGIN
    IF FOUND AND s.released_at IS NULL THEN
      UPDATE public.scope_job_draft_sets SET released_at = now() WHERE job_id = s.job_id;
      INSERT INTO public.job_events(job_id, event_type, detail_json) VALUES
        (s.job_id, 'scope_job_draft_work_order_released', jsonb_build_object(
          'work_order_id', w.id, 'scope_revision_id', s.scope_revision_id,
          'price_approval_id', v_check->'price_approval_id',
          'work_order_approval_id', v_check->'work_order_approval_id'));
    END IF;
    UPDATE public.work_orders
      SET status = 'approved',
          approved_by = (v_check->>'work_order_approver')::uuid,
          approved_at = now(),
          approved_via = v_check->>'work_order_via'
      WHERE id = w.id
      RETURNING * INTO v_out;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_error = MESSAGE_TEXT;
    RETURN jsonb_build_object('issued', false, 'held', true, 'work_order_id', w.id,
      'scope_revision_id', v_check->'revision_id', 'missing', jsonb_build_array('issue_refused'),
      'sqlstate', v_state, 'error', v_error);
  END;
  PERFORM public.link_issued_job_work_order(v_out.id);
  INSERT INTO public.job_events(job_id, event_type, detail_json) VALUES
    (v_out.job_id, 'job_work_order_issued_on_owner_approval', jsonb_build_object(
      'work_order_id', v_out.id, 'scope_revision_id', v_check->'revision_id',
      'price_approval_id', v_out.price_approval_id,
      'work_order_approval_id', v_out.work_order_approval_id));
  RETURN jsonb_build_object('issued', true, 'replayed', false, 'work_order_id', v_out.id,
    'scope_revision_id', v_check->'revision_id',
    'price_approval_id', v_out.price_approval_id,
    'work_order_approval_id', v_out.work_order_approval_id, 'missing', '[]'::jsonb);
END $$;

-- ── 6. recording the decisions ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.record_scope_price_approval(
  p_job_id uuid, p_scope_revision_id uuid, p_approver uuid, p_via text, p_org_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  j public.jobs%ROWTYPE;
  r public.scope_revisions%ROWTYPE;
  a public.scope_owner_approvals%ROWTYPE;
  v_authority text;
  v_replayed boolean := false;
  v_issues jsonb := '[]'::jsonb;
  v_wo uuid;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR p_org_id IS NULL OR j.org_id IS DISTINCT FROM p_org_id THEN
    RAISE EXCEPTION 'scope_owner_approval_job_forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_via IS NULL OR p_via NOT IN ('session', 'terminal') THEN
    RAISE EXCEPTION 'scope_owner_approval_via_invalid' USING ERRCODE = '22023';
  END IF;
  v_authority := public.owner_approval_authority(p_approver);
  IF v_authority IS NULL THEN
    RAISE EXCEPTION 'scope_owner_approval_approver_required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO r FROM public.scope_revisions WHERE id = p_scope_revision_id AND job_id = j.id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'scope_owner_approval_revision_not_found' USING ERRCODE = 'P0002'; END IF;
  IF r.status NOT IN ('frozen', 'superseded') THEN
    RAISE EXCEPTION 'scope_owner_approval_revision_not_frozen' USING ERRCODE = '23514';
  END IF;
  IF encode(sha256(convert_to(r.scope_canonical_text, 'UTF8')), 'hex') IS DISTINCT FROM r.scope_hash
     OR encode(sha256(convert_to(r.pricing_canonical_text, 'UTF8')), 'hex') IS DISTINCT FROM r.pricing_hash THEN
    RAISE EXCEPTION 'scope_owner_approval_source_corrupt' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO a FROM public.scope_owner_approvals x
    WHERE x.kind = 'price' AND x.job_id = j.id AND x.scope_revision_id = r.id;
  IF FOUND THEN
    v_replayed := true;
  ELSE
    INSERT INTO public.scope_owner_approvals(kind, job_id, org_id, scope_revision_id, scope_hash,
        pricing_hash, approver_user_id, authority, via)
      VALUES ('price', j.id, j.org_id, r.id, r.scope_hash, r.pricing_hash, p_approver, v_authority, p_via)
      RETURNING * INTO a;
    INSERT INTO public.job_events(job_id, event_type, detail_json) VALUES
      (j.id, 'scope_price_owner_approved', jsonb_build_object('approval_id', a.id,
        'scope_revision_id', r.id, 'authority', a.authority, 'via', a.via));
  END IF;
  FOR v_wo IN SELECT w.id FROM public.work_orders w
      WHERE w.job_id = j.id AND w.kind = 'job' AND w.status = 'draft'
        AND COALESCE(w.scope_revision_id, w.quote_filled_scope_revision_id) = r.id
      ORDER BY w.created_at LOOP
    v_issues := v_issues || public.issue_owner_approved_job_work_order(v_wo);
  END LOOP;
  RETURN jsonb_build_object('approval', public.scope_owner_approval_json(a), 'replayed', v_replayed,
    'revision_is_current', NOT EXISTS (SELECT 1 FROM public.scope_revisions n
      WHERE n.job_id = j.id AND n.revision_number > r.revision_number),
    'issues', v_issues);
END $$;

-- p_scope_revision_id, when given, must be the order's own saved revision;
-- p_org_id, when given, must be the job's organisation.
CREATE OR REPLACE FUNCTION public.record_job_work_order_approval(
  p_work_order_id uuid, p_approver uuid, p_via text, p_expected_updated_at timestamptz,
  p_scope_revision_id uuid DEFAULT NULL, p_org_id uuid DEFAULT NULL, p_require_revision boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_job uuid;
  j public.jobs%ROWTYPE;
  w public.work_orders%ROWTYPE;
  a public.scope_owner_approvals%ROWTYPE;
  v_authority text;
  v_gate jsonb;
  v_rev uuid;
  v_hash text;
  v_not_ready text;
  v_replayed boolean := false;
  v_issue jsonb;
BEGIN
  SELECT x.job_id INTO v_job FROM public.work_orders x WHERE x.id = p_work_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'work order not found' USING ERRCODE = 'P0002'; END IF;
  -- The job first, as release and preparation lock it.
  SELECT * INTO j FROM public.jobs WHERE id = v_job FOR UPDATE;
  SELECT * INTO w FROM public.work_orders WHERE id = p_work_order_id FOR UPDATE;
  IF w.kind <> 'job' THEN
    RAISE EXCEPTION 'only a job work order is approved' USING ERRCODE = '23514';
  END IF;
  IF p_org_id IS NOT NULL AND j.org_id IS DISTINCT FROM p_org_id THEN
    RAISE EXCEPTION 'scope_owner_approval_job_forbidden' USING ERRCODE = '42501';
  END IF;
  IF w.status <> 'draft' THEN
    RAISE EXCEPTION 'work order is %, not draft', w.status USING ERRCODE = '23514';
  END IF;
  IF p_expected_updated_at IS NULL OR w.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'The draft changed after it was read. Read it again before approving.'
      USING ERRCODE = 'WO409';
  END IF;
  IF p_via IS NULL OR p_via NOT IN ('session', 'terminal') THEN
    RAISE EXCEPTION 'scope_owner_approval_via_invalid' USING ERRCODE = '22023';
  END IF;
  v_authority := public.owner_approval_authority(p_approver);
  IF v_authority IS NULL THEN
    RAISE EXCEPTION 'only an approver named in work_order_settings can approve a job work order'
      USING ERRCODE = '42501';
  END IF;
  v_hash := public.job_work_order_content_hash(w);
  v_gate := public.job_work_order_owner_gate(w, v_hash);
  IF (v_gate->>'bound')::boolean AND v_gate->>'revision_id' IS NULL THEN
    RAISE EXCEPTION 'scope_owner_approval_revision_conflict' USING ERRCODE = '23514';
  END IF;
  v_rev := (v_gate->>'revision_id')::uuid;
  IF (p_require_revision OR p_scope_revision_id IS NOT NULL)
     AND v_rev IS DISTINCT FROM p_scope_revision_id THEN
    RAISE EXCEPTION 'scope_owner_approval_revision_mismatch' USING ERRCODE = '23514';
  END IF;
  v_not_ready := public.job_work_order_not_ready(w);
  IF v_not_ready IS NOT NULL THEN
    RAISE EXCEPTION '%', v_not_ready USING ERRCODE = '23514';
  END IF;
  SELECT * INTO a FROM public.scope_owner_approvals x
    WHERE x.kind = 'work_order' AND x.work_order_id = w.id AND x.work_order_content_hash = v_hash
      AND x.scope_revision_id IS NOT DISTINCT FROM v_rev;
  IF FOUND THEN
    v_replayed := true;
  ELSE
    INSERT INTO public.scope_owner_approvals(kind, job_id, org_id, scope_revision_id, work_order_id,
        work_order_content_hash, work_order_updated_at, approver_user_id, authority, via)
      VALUES ('work_order', w.job_id, j.org_id, v_rev, w.id, v_hash, w.updated_at,
        p_approver, v_authority, p_via)
      RETURNING * INTO a;
    INSERT INTO public.job_events(job_id, event_type, detail_json) VALUES
      (w.job_id, 'job_work_order_owner_approved', jsonb_build_object('approval_id', a.id,
        'work_order_id', w.id, 'scope_revision_id', v_rev, 'authority', a.authority, 'via', a.via));
  END IF;
  IF v_rev IS NOT NULL THEN
    v_issue := public.issue_owner_approved_job_work_order(w.id);
  ELSE
    -- No saved revision: the existing approval, by this approver, while the
    -- owner's switch allows it. The seal refuses it otherwise.
    UPDATE public.work_orders
      SET status = 'approved', approved_by = a.approver_user_id, approved_at = now(), approved_via = a.via
      WHERE id = w.id;
    PERFORM public.link_issued_job_work_order(w.id);
    v_issue := jsonb_build_object('issued', true, 'replayed', false, 'work_order_id', w.id,
      'missing', '[]'::jsonb, 'unbound', true);
  END IF;
  RETURN jsonb_build_object('approval', public.scope_owner_approval_json(a), 'replayed', v_replayed,
    'issue', v_issue);
END $$;

-- The existing manual RPC (approve_work_order, approve_office_job_work_order):
-- records the work order decision and issues only when the policy allows. It
-- returns the work order as it now stands plus owner_approval.
CREATE OR REPLACE FUNCTION public.approve_job_work_order(
  p_work_order_id uuid,
  p_approver uuid,
  p_via text,
  p_expected_updated_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
  v_out public.work_orders%ROWTYPE;
BEGIN
  v_result := public.record_job_work_order_approval(p_work_order_id, p_approver, p_via,
    p_expected_updated_at, NULL, NULL, false);
  SELECT * INTO v_out FROM public.work_orders WHERE id = p_work_order_id;
  RETURN to_jsonb(v_out) || jsonb_build_object('owner_approval', v_result);
END;
$$;

-- ── 7. release on acceptance ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.scope_job_draft_issue_state(p_job_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s public.scope_job_draft_sets%ROWTYPE;
  w public.work_orders%ROWTYPE;
  v_check jsonb;
  v_price public.scope_owner_approvals%ROWTYPE;
  v_order public.scope_owner_approvals%ROWTYPE;
  v_state text;
BEGIN
  SELECT * INTO s FROM public.scope_job_draft_sets WHERE job_id = p_job_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO w FROM public.work_orders WHERE id = s.work_order_id;
  IF w.status = 'approved' THEN
    SELECT * INTO v_price FROM public.scope_owner_approvals WHERE id = w.price_approval_id;
    SELECT * INTO v_order FROM public.scope_owner_approvals WHERE id = w.work_order_approval_id;
    v_check := jsonb_build_object('missing', '[]'::jsonb);
  ELSE
    v_check := public.job_work_order_issue_check(w);
    SELECT * INTO v_price FROM public.scope_owner_approvals WHERE id = (v_check->>'price_approval_id')::uuid;
    SELECT * INTO v_order FROM public.scope_owner_approvals WHERE id = (v_check->>'work_order_approval_id')::uuid;
  END IF;
  v_state := CASE
    WHEN w.status = 'approved' AND s.released_at IS NOT NULL THEN 'released'
    WHEN w.status = 'approved' THEN 'issued'
    WHEN s.released_at IS NOT NULL THEN 'released_not_issued'
    WHEN v_check->'missing' ?| ARRAY['price_approval', 'work_order_approval', 'work_order_revision_conflict', 'saved_revision']
      THEN 'awaiting_owner_approval'
    WHEN v_check->'missing' ? 'customer_acceptance' THEN 'awaiting_customer_acceptance'
    WHEN jsonb_array_length(v_check->'missing') > 0 THEN 'held'
    ELSE 'ready_to_issue' END;
  RETURN jsonb_build_object(
    'state', v_state,
    'missing', v_check->'missing',
    'released_at', s.released_at,
    'acceptance', jsonb_build_object('recorded_at', s.acceptance_recorded_at,
      'scope_revision_id', s.acceptance_scope_revision_id, 'legacy', s.acceptance_legacy),
    'approvals', jsonb_build_object(
      'price', public.scope_owner_approval_json(v_price),
      'work_order', public.scope_owner_approval_json(v_order)),
    'work_order_actual', jsonb_build_object('id', w.id, 'status', w.status,
      'approved_at', w.approved_at, 'approved_by', w.approved_by, 'approved_via', w.approved_via,
      'sealed_content_hash', w.sealed_content_hash,
      'content_hash', public.job_work_order_content_hash(w),
      'price_approval_id', w.price_approval_id, 'work_order_approval_id', w.work_order_approval_id),
    'revision_is_current', NOT EXISTS (SELECT 1 FROM public.scope_revisions r
      JOIN public.scope_revisions n ON n.job_id = r.job_id AND n.revision_number > r.revision_number
      WHERE r.id = s.scope_revision_id));
END $$;

-- Called only by the existing server acceptance paths after their full-job
-- decision. They resolve the accepted quote through acceptedRevisionForOrders;
-- a bound release may never substitute a newer frozen quote. The acceptance
-- is retained whatever the owner approvals say; the issue waits for them.
CREATE OR REPLACE FUNCTION public.release_scope_job_drafts(p_job_id uuid, p_scope_revision_id uuid, p_legacy boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.scope_job_draft_sets%ROWTYPE; j public.jobs%ROWTYPE; v_first boolean; v_issue jsonb;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR j.status IS DISTINCT FROM 'accepted' THEN
    RAISE EXCEPTION 'scope_drafts_acceptance_required' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO s FROM public.scope_job_draft_sets WHERE job_id = j.id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('released', false, 'reason', 'no_drafts'); END IF;
  IF s.scope_revision_id IS DISTINCT FROM p_scope_revision_id THEN
    RAISE EXCEPTION 'scope_drafts_accepted_revision_mismatch' USING ERRCODE = '23514';
  END IF;
  IF s.released_at IS NOT NULL THEN
    RETURN jsonb_build_object('released', true, 'replayed', true,
      'issue', public.scope_job_draft_issue_state(j.id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.scope_revisions r JOIN public.work_orders w ON w.id = s.work_order_id
    WHERE r.id = s.scope_revision_id AND r.job_id = j.id AND r.status IN ('frozen', 'superseded')
      AND w.scope_revision_id = r.id AND w.scope_items = s.labour_lines
      AND w.agreed_labour_ex IS NOT DISTINCT FROM s.labour_total_cents / 100.0
      AND (NOT p_legacy OR r.status = 'frozen' AND NOT EXISTS (
        SELECT 1 FROM public.scope_revisions n WHERE n.job_id = j.id AND n.revision_number > r.revision_number))) THEN
    RAISE EXCEPTION 'scope_drafts_source_changed' USING ERRCODE = '23514';
  END IF;
  v_first := s.acceptance_recorded_at IS NULL OR s.acceptance_scope_revision_id IS DISTINCT FROM s.scope_revision_id;
  IF v_first THEN
    UPDATE public.scope_job_draft_sets
      SET acceptance_recorded_at = now(), acceptance_scope_revision_id = s.scope_revision_id,
          acceptance_legacy = COALESCE(p_legacy, false)
      WHERE job_id = j.id;
  END IF;
  v_issue := public.issue_owner_approved_job_work_order(s.work_order_id);
  IF (v_issue->>'issued')::boolean THEN
    RETURN jsonb_build_object('released', true, 'replayed', false,
      'issue', public.scope_job_draft_issue_state(j.id));
  END IF;
  IF v_first THEN
    INSERT INTO public.job_events(job_id, event_type, detail_json) VALUES
      (j.id, 'scope_job_draft_issue_held', jsonb_build_object('work_order_id', s.work_order_id,
        'scope_revision_id', s.scope_revision_id, 'missing', v_issue->'missing'));
  END IF;
  RETURN jsonb_build_object('released', false, 'held', true, 'reason', 'owner_approval_required',
    'acceptance_recorded', true, 'missing', v_issue->'missing',
    'issue', public.scope_job_draft_issue_state(j.id));
END $$;

-- This reader returns persisted ids/amounts. It never recalculates a quote.
-- Approvals are read for this revision and the order's current content only.
CREATE OR REPLACE FUNCTION public.read_scope_job_drafts(
  p_job_id uuid, p_scope_revision_id uuid, p_org_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.scope_job_draft_sets%ROWTYPE; v_invoices jsonb; v_issue jsonb;
BEGIN
  PERFORM 1 FROM public.jobs j WHERE j.id = p_job_id AND j.org_id = p_org_id FOR SHARE;
  IF NOT FOUND OR p_org_id IS NULL THEN
    RAISE EXCEPTION 'scope_drafts_job_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO s FROM public.scope_job_draft_sets d WHERE d.job_id = p_job_id AND d.org_id = p_org_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'scope_drafts_not_found' USING ERRCODE = 'P0002'; END IF;
  IF s.scope_revision_id IS DISTINCT FROM p_scope_revision_id OR NOT EXISTS (
    SELECT 1 FROM public.scope_revisions r WHERE r.id = p_scope_revision_id AND r.job_id = p_job_id
      AND (s.released_at IS NOT NULL AND r.status IN ('frozen', 'superseded') OR r.status = 'frozen' AND NOT EXISTS (
        SELECT 1 FROM public.scope_revisions n WHERE n.job_id = p_job_id AND n.revision_number > r.revision_number
      ))
  ) THEN RAISE EXCEPTION 'scope_drafts_revision_stale' USING ERRCODE = '23514'; END IF;
  SELECT jsonb_agg(jsonb_build_object('id', i.id, 'payer_id', i.payer_id, 'status', 'draft',
      'ex_gst', i.ex_cents / 100.0, 'gst', i.gst_cents / 100.0, 'inc_gst', i.inc_cents / 100.0)
      ORDER BY i.payer_id COLLATE "C") INTO v_invoices
    FROM public.scope_job_draft_invoices i WHERE i.job_id = p_job_id AND i.scope_revision_id = s.scope_revision_id;
  v_issue := public.scope_job_draft_issue_state(p_job_id);
  RETURN jsonb_build_object('job_id', s.job_id, 'scope_revision_id', s.scope_revision_id,
    'work_order', jsonb_build_object('id', s.work_order_id,
      'status', CASE WHEN s.released_at IS NULL THEN 'draft' ELSE 'released' END,
      'labour_total_ex_gst', s.labour_total_cents / 100.0,
      'actual', v_issue->'work_order_actual'),
    'invoices', coalesce(v_invoices, '[]'::jsonb), 'amounts_confirmed', s.amounts_confirmed,
    'released_at', s.released_at,
    'acceptance', v_issue->'acceptance',
    'approvals', v_issue->'approvals',
    'issue', jsonb_build_object('state', v_issue->'state', 'missing', v_issue->'missing'),
    'revision_is_current', v_issue->'revision_is_current',
    'xero_writes', false, 'sent', false, 'payment_links', false);
END $$;

-- The owner approval state of any job's work order (shared lane or not).
CREATE OR REPLACE FUNCTION public.read_job_owner_approval_state(p_job_id uuid, p_org_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  j public.jobs%ROWTYPE;
  w public.work_orders%ROWTYPE;
  cur public.scope_revisions%ROWTYPE;
  v_check jsonb;
  v_price public.scope_owner_approvals%ROWTYPE;
  v_order public.scope_owner_approvals%ROWTYPE;
  v_prices jsonb;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job_id;
  IF NOT FOUND OR p_org_id IS NULL OR j.org_id IS DISTINCT FROM p_org_id THEN
    RAISE EXCEPTION 'scope_owner_approval_job_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO cur FROM public.scope_revisions r WHERE r.job_id = j.id
    ORDER BY r.revision_number DESC LIMIT 1;
  SELECT * INTO w FROM public.work_orders x WHERE x.job_id = j.id AND x.kind = 'job'
    ORDER BY (x.status = 'approved') DESC, x.created_at DESC LIMIT 1;
  IF w.id IS NOT NULL THEN
    IF w.status = 'approved' THEN
      SELECT * INTO v_price FROM public.scope_owner_approvals WHERE id = w.price_approval_id;
      SELECT * INTO v_order FROM public.scope_owner_approvals WHERE id = w.work_order_approval_id;
      v_check := jsonb_build_object('missing', '[]'::jsonb,
        'revision_id', COALESCE(w.scope_revision_id, w.quote_filled_scope_revision_id),
        'bound', COALESCE(w.scope_revision_id, w.quote_filled_scope_revision_id) IS NOT NULL);
    ELSE
      v_check := public.job_work_order_issue_check(w);
      SELECT * INTO v_price FROM public.scope_owner_approvals WHERE id = (v_check->>'price_approval_id')::uuid;
      SELECT * INTO v_order FROM public.scope_owner_approvals WHERE id = (v_check->>'work_order_approval_id')::uuid;
    END IF;
  END IF;
  SELECT jsonb_agg(public.scope_owner_approval_json(a) ORDER BY a.decided_at DESC) INTO v_prices
    FROM (SELECT * FROM public.scope_owner_approvals x WHERE x.job_id = j.id AND x.kind = 'price'
          ORDER BY x.decided_at DESC LIMIT 20) a;
  RETURN jsonb_build_object(
    'job_id', j.id,
    'current_scope_revision', CASE WHEN cur.id IS NULL THEN NULL ELSE
      jsonb_build_object('id', cur.id, 'status', cur.status, 'revision_number', cur.revision_number) END,
    'work_order', CASE WHEN w.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', w.id, 'status', w.status, 'approved_at', w.approved_at, 'approved_by', w.approved_by,
      'approved_via', w.approved_via, 'sealed_content_hash', w.sealed_content_hash,
      'updated_at', w.updated_at, 'content_hash', public.job_work_order_content_hash(w),
      'source_scope_revision_id', v_check->'revision_id', 'bound', v_check->'bound',
      'source_is_current', (v_check->>'revision_id') IS NOT NULL AND (v_check->>'revision_id')::uuid = cur.id,
      'price_approval_id', w.price_approval_id, 'work_order_approval_id', w.work_order_approval_id,
      'approvals', jsonb_build_object('price', public.scope_owner_approval_json(v_price),
        'work_order', public.scope_owner_approval_json(v_order)),
      'missing', v_check->'missing') END,
    'price_approvals', COALESCE(v_prices, '[]'::jsonb));
END $$;

-- The price decision a quote send for this revision needs, or NULL.
CREATE OR REPLACE FUNCTION public.scope_price_owner_approval(p_job_id uuid, p_scope_revision_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.scope_owner_approval_json(a) FROM public.scope_owner_approvals a
  WHERE a.kind = 'price' AND a.job_id = p_job_id AND a.scope_revision_id = p_scope_revision_id;
$$;

-- ── 8. the automatic issue carries out, never decides ────────────────────────

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
  v_gate jsonb;
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
  -- (added) Refused before any write when either owner decision is missing.
  v_gate := public.job_work_order_owner_gate(v_wo);
  IF NOT (v_gate->>'bound')::boolean OR jsonb_array_length(v_gate->'missing') > 0 THEN
    RAISE EXCEPTION 'owner_approval_required: %',
      (SELECT string_agg(m, ', ') FROM jsonb_array_elements_text(v_gate->'missing') m)
      USING ERRCODE = 'WO428';
  END IF;

  PERFORM set_config('secureworks.job_work_order_auto_issue', 'on', true);
  UPDATE public.work_orders
    SET status = 'approved', approved_by = NULL, approved_at = now(), approved_via = 'auto'
    WHERE id = v_wo.id
    RETURNING * INTO v_out;
  PERFORM set_config('secureworks.job_work_order_auto_issue', 'off', true);

  PERFORM public.link_issued_job_work_order(v_out.id);

  RETURN to_jsonb(v_out);
END;
$$;

-- Drafts the automatic issue may carry out: filled from the quote, untouched,
-- on an open fencing or patio job, with both owner decisions for their saved
-- revision and current content. The sweep reads only these, so drafts still
-- waiting for the owner never crowd out ones that are ready.
CREATE OR REPLACE FUNCTION public.owner_approved_job_work_order_drafts(p_limit integer DEFAULT 25)
RETURNS TABLE (job_id uuid, work_order_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT w.job_id, w.id
  FROM public.work_orders w
  JOIN public.jobs j ON j.id = w.job_id
  WHERE w.kind = 'job' AND w.status = 'draft'
    AND w.hand_edited_at IS NULL AND w.quote_filled_at IS NOT NULL
    AND w.agreed_labour_ex IS NOT NULL
    AND j.type IN ('fencing', 'patio')
    AND j.status = ANY (public.job_work_order_open_statuses())
    AND (public.job_work_order_owner_gate(w)->>'bound')::boolean
    AND jsonb_array_length(public.job_work_order_owner_gate(w)->'missing') = 0
  ORDER BY w.created_at
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 25), 100));
$$;

-- ── 9. access ────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION
  public.owner_approval_authority(uuid),
  public.job_work_order_content_hash(public.work_orders),
  public.job_work_order_not_ready(public.work_orders),
  public.scope_owner_approval_json(public.scope_owner_approvals),
  public.job_work_order_owner_gate(public.work_orders, text),
  public.job_work_order_issue_check(public.work_orders),
  public.link_issued_job_work_order(uuid),
  public.issue_owner_approved_job_work_order(uuid),
  public.record_scope_price_approval(uuid, uuid, uuid, text, uuid),
  public.record_job_work_order_approval(uuid, uuid, text, timestamptz, uuid, uuid, boolean),
  public.approve_job_work_order(uuid, uuid, text, timestamptz),
  public.scope_job_draft_issue_state(uuid),
  public.release_scope_job_drafts(uuid, uuid, boolean),
  public.read_scope_job_drafts(uuid, uuid, uuid),
  public.read_job_owner_approval_state(uuid, uuid),
  public.scope_price_owner_approval(uuid, uuid),
  public.auto_issue_job_work_order(uuid, timestamptz),
  public.owner_approved_job_work_order_drafts(integer),
  public.work_orders_crew_owner_gate(),
  public.scope_owner_approvals_append_only()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.owner_approval_authority(uuid),
  public.record_scope_price_approval(uuid, uuid, uuid, text, uuid),
  public.record_job_work_order_approval(uuid, uuid, text, timestamptz, uuid, uuid, boolean),
  public.approve_job_work_order(uuid, uuid, text, timestamptz),
  public.release_scope_job_drafts(uuid, uuid, boolean),
  public.read_scope_job_drafts(uuid, uuid, uuid),
  public.read_job_owner_approval_state(uuid, uuid),
  public.scope_price_owner_approval(uuid, uuid),
  public.auto_issue_job_work_order(uuid, timestamptz),
  public.owner_approved_job_work_order_drafts(integer),
  public.issue_owner_approved_job_work_order(uuid)
  TO service_role;
