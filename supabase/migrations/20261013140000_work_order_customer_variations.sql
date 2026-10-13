-- 20261013140000_work_order_customer_variations.sql
--
-- Customer variations on a job work order (captain, 12 and 13 Oct 2026: a
-- variation joins the existing work order as a marked addendum; no trade sees
-- a dollar amount; the customer's invoice line comes from the same record
-- instead of being typed into Xero by hand).
--
-- The office records a variation the customer agreed to: a description, the
-- tasks with the hours each takes, the labour allowed to the trades for it
-- (trade_allocation_ex) and the price charged to the customer
-- (customer_price_ex), both ex GST. It is a draft (editable, counts for
-- nothing) until the work order approver approves it. Approving joins it to
-- the job's APPROVED work order as the next numbered addendum ("Variation 1"),
-- and seals it: the database refuses any later edit, like the work order. The
-- work order's own sealed lines are never touched. A draft can be cancelled;
-- an approved variation cannot.
--
-- Why a new table, and not one of the two that already say "variation":
--   * work_order_variations (20261012130000) is a TRADE's overrun flag on one
--     of their own invoices: one row per trade invoice per job, the amount is
--     the part of that invoice the trade says is extra. It stays exactly as it
--     is.
--   * job_variations (20260322000010) gives every row a share_token at insert,
--     and send-quote's public page accepts or declines ANY row by that token,
--     whatever its status, so an office draft would be acceptable by the
--     customer before anyone approved it. Its approve door (ops-api
--     approve_variation) has no stale-read guard, it has no draft or cancelled
--     state, and the job story lists every row as an open matter. A sealed
--     addendum cannot live under those writers.
--
-- What it adds:
--   1. work_order_customer_variations, sealed by trigger once approved.
--   2. approve_work_order_customer_variation(): approver-only, seals only the
--      draft as it was read (p_expected_updated_at, SQLSTATE WO409 when it
--      moved), needs the job's approved work order (SQLSTATE WO422), and
--      numbers the addendum on that work order under its row lock.
--   3. work_order_customer_variation_invoices: the customer invoice line
--      prepared from an approved variation, one per variation, and the Xero
--      DRAFT created from it when that is switched on.
--   4. Feature flag customer_variation_xero_draft_v1, seeded OFF: nothing in
--      this change writes to Xero while it is off.
--
-- Nothing here sends, writes Xero, or changes an existing row.

-- ── 1. the variation ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.work_order_customer_variations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  -- Set by the approval: the job's approved work order this addendum joins.
  work_order_id uuid REFERENCES public.work_orders(id),
  -- Set by the approval: 1, 2, 3 ... on that work order, never reused.
  variation_number int CHECK (variation_number IS NULL OR variation_number >= 1),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'cancelled')),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 2000),
  -- [{description, hours, qty?, unit?}]; every task carries its hours.
  tasks jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tasks) = 'array'),
  trade_allocation_ex numeric(12,2) CHECK (trade_allocation_ex IS NULL OR trade_allocation_ex >= 0),
  customer_price_ex numeric(12,2) CHECK (customer_price_ex IS NULL OR customer_price_ex >= 0),
  created_by text NOT NULL,
  approved_at timestamptz,
  approved_by uuid REFERENCES public.users(id),
  approved_via text CHECK (approved_via IS NULL OR approved_via IN ('session', 'terminal')),
  sealed_content_hash text,
  cancelled_at timestamptz,
  cancelled_by text,
  cancel_reason text CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_order_customer_variations_approved_check CHECK (
    status <> 'approved'
    OR (work_order_id IS NOT NULL AND variation_number IS NOT NULL
        AND approved_at IS NOT NULL AND approved_by IS NOT NULL
        AND trade_allocation_ex IS NOT NULL AND customer_price_ex IS NOT NULL
        AND sealed_content_hash IS NOT NULL)
  ),
  CONSTRAINT work_order_customer_variations_cancelled_check CHECK (
    status <> 'cancelled' OR (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)
  ),
  CONSTRAINT work_order_customer_variations_number_unique UNIQUE (work_order_id, variation_number)
);
CREATE INDEX IF NOT EXISTS idx_work_order_customer_variations_job
  ON public.work_order_customer_variations (job_id);
CREATE INDEX IF NOT EXISTS idx_work_order_customer_variations_wo
  ON public.work_order_customer_variations (work_order_id) WHERE work_order_id IS NOT NULL;
COMMENT ON TABLE public.work_order_customer_variations IS
  'A customer variation recorded by the office: tasks with hours, the trade allocation and the customer price (ex GST). Draft, then approved by a work_order_settings approver, which joins it to the job''s approved work order as numbered addendum and seals it. Not the trade''s overrun flag (work_order_variations) and not job_variations.';
COMMENT ON COLUMN public.work_order_customer_variations.trade_allocation_ex IS
  'The labour allowed to the trades for this variation, ex GST. Office only: no trade read ever selects it.';
COMMENT ON COLUMN public.work_order_customer_variations.customer_price_ex IS
  'What the customer is charged for this variation, ex GST. The customer invoice line is prepared from it. Office only.';

ALTER TABLE public.work_order_customer_variations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_order_customer_variations_service_role_all ON public.work_order_customer_variations;
CREATE POLICY work_order_customer_variations_service_role_all ON public.work_order_customer_variations
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.work_order_customer_variations FROM anon, authenticated;

-- The seal. A draft is editable and every write to it moves updated_at (the
-- stamp the approval and the office's edits compare with what was read).
-- Approved and cancelled rows never change; an approved one is never deleted.
CREATE OR REPLACE FUNCTION public.work_order_customer_variations_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_approvers uuid[];
  v_wo record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'approved' THEN
      RAISE EXCEPTION 'an approved customer variation is sealed and cannot be deleted'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.work_order_id IS NOT NULL OR NEW.variation_number IS NOT NULL
       OR NEW.approved_at IS NOT NULL OR NEW.approved_by IS NOT NULL OR NEW.sealed_content_hash IS NOT NULL
       OR NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'a customer variation is created as a draft and approved afterwards'
        USING ERRCODE = '23514';
    END IF;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;

  -- UPDATE
  IF OLD.status IN ('approved', 'cancelled') THEN
    IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
      RAISE EXCEPTION 'this customer variation is % and sealed: record a further variation instead', OLD.status
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a customer variation keeps its job and its author' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := clock_timestamp();

  IF NEW.status = 'draft' THEN
    IF NEW.work_order_id IS NOT NULL OR NEW.variation_number IS NOT NULL OR NEW.approved_at IS NOT NULL
       OR NEW.approved_by IS NOT NULL OR NEW.sealed_content_hash IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'a draft customer variation has no work order, number or approval yet'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'cancelled' THEN
    IF NEW.work_order_id IS NOT NULL OR NEW.variation_number IS NOT NULL OR NEW.approved_by IS NOT NULL THEN
      RAISE EXCEPTION 'a cancelled customer variation was never approved' USING ERRCODE = '23514';
    END IF;
    NEW.cancelled_at := COALESCE(NEW.cancelled_at, now());
    IF NEW.cancelled_by IS NULL OR btrim(NEW.cancelled_by) = '' THEN
      RAISE EXCEPTION 'a cancellation records who cancelled' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- draft -> approved: the one approval transition.
  SELECT s.approver_user_ids INTO v_approvers FROM public.work_order_settings s WHERE s.id = 1;
  IF NEW.approved_by IS NULL OR v_approvers IS NULL OR NOT (NEW.approved_by = ANY (v_approvers)) THEN
    RAISE EXCEPTION 'only an approver named in work_order_settings can approve a customer variation'
      USING ERRCODE = '42501';
  END IF;
  SELECT wo.id, wo.job_id, wo.kind, wo.status INTO v_wo
    FROM public.work_orders wo WHERE wo.id = NEW.work_order_id;
  IF NOT FOUND OR v_wo.kind <> 'job' OR v_wo.status <> 'approved' OR v_wo.job_id IS DISTINCT FROM NEW.job_id THEN
    RAISE EXCEPTION 'a customer variation joins its own job''s approved work order' USING ERRCODE = '23514';
  END IF;
  IF NEW.trade_allocation_ex IS NULL OR NEW.customer_price_ex IS NULL THEN
    RAISE EXCEPTION 'set the trade allocation and the customer price before approving' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(NEW.tasks) = 0 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.tasks) t
    WHERE jsonb_typeof(t) <> 'object'
       OR COALESCE(btrim(t->>'description'), '') = ''
       OR CASE WHEN jsonb_typeof(t->'hours') = 'number'
               THEN (t->>'hours')::numeric <= 0
               ELSE true END
  ) THEN
    RAISE EXCEPTION 'every task needs a description and its hours before approving' USING ERRCODE = '23514';
  END IF;
  NEW.approved_at := COALESCE(NEW.approved_at, now());
  NEW.sealed_content_hash := encode(sha256(convert_to(jsonb_build_object(
    'variation_id', NEW.id,
    'job_id', NEW.job_id,
    'work_order_id', NEW.work_order_id,
    'variation_number', NEW.variation_number,
    'description', NEW.description,
    'tasks', NEW.tasks,
    'trade_allocation_ex', NEW.trade_allocation_ex,
    'customer_price_ex', NEW.customer_price_ex
  )::text, 'UTF8')), 'hex');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_work_order_customer_variations_guard ON public.work_order_customer_variations;
CREATE TRIGGER trg_work_order_customer_variations_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.work_order_customer_variations
  FOR EACH ROW EXECUTE FUNCTION public.work_order_customer_variations_guard();

-- ── 2. approve (work order approvers only) ───────────────────────────────────

-- Seals the draft as the approver read it and joins it to the job's approved
-- work order as its next addendum. The work order row is locked so two
-- approvals on one job can never take the same number.
CREATE OR REPLACE FUNCTION public.approve_work_order_customer_variation(
  p_variation_id uuid,
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
  v_var public.work_order_customer_variations%ROWTYPE;
  v_out public.work_order_customer_variations%ROWTYPE;
  v_wo_id uuid;
  v_number int;
BEGIN
  SELECT * INTO v_var FROM public.work_order_customer_variations WHERE id = p_variation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer variation not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_var.status <> 'draft' THEN
    RAISE EXCEPTION 'customer variation is %, not draft', v_var.status USING ERRCODE = '23514';
  END IF;
  IF p_expected_updated_at IS NULL OR v_var.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'The variation changed after it was read. Read it again before approving.'
      USING ERRCODE = 'WO409';
  END IF;

  SELECT wo.id INTO v_wo_id FROM public.work_orders wo
    WHERE wo.job_id = v_var.job_id AND wo.kind = 'job' AND wo.status = 'approved'
    LIMIT 1
    FOR UPDATE;
  IF v_wo_id IS NULL THEN
    RAISE EXCEPTION 'Approve the job''s work order first: a variation is an addendum to the approved work order.'
      USING ERRCODE = 'WO422';
  END IF;

  SELECT COALESCE(max(v.variation_number), 0) + 1 INTO v_number
    FROM public.work_order_customer_variations v WHERE v.work_order_id = v_wo_id;

  UPDATE public.work_order_customer_variations
    SET status = 'approved', work_order_id = v_wo_id, variation_number = v_number,
        approved_by = p_approver, approved_at = now(), approved_via = p_via
    WHERE id = v_var.id
    RETURNING * INTO v_out;

  RETURN to_jsonb(v_out);
END;
$$;
REVOKE ALL ON FUNCTION public.approve_work_order_customer_variation(uuid, uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_work_order_customer_variation(uuid, uuid, text, timestamptz) TO service_role;

-- ── 3. the customer invoice line prepared from the variation ─────────────────

CREATE TABLE IF NOT EXISTS public.work_order_customer_variation_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variation_id uuid NOT NULL UNIQUE
    REFERENCES public.work_order_customer_variations(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  -- {description, quantity, unit_price, account_code}: the create_invoice_draft line shape.
  line jsonb NOT NULL CHECK (jsonb_typeof(line) = 'object'),
  -- prepared            the line is ready; nothing has gone to Xero
  -- creating            a Xero DRAFT is being created (the claim)
  -- xero_draft_created  Xero confirmed an ACCREC DRAFT holding the line
  -- unknown             the create was sent and its outcome is not known:
  --                     never retried automatically; check Xero first
  status text NOT NULL DEFAULT 'prepared'
    CHECK (status IN ('prepared', 'creating', 'xero_draft_created', 'unknown')),
  prepared_by text NOT NULL,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  xero_contact_id uuid,
  job_contact_id uuid,
  xero_requested_by text,
  xero_requested_at timestamptz,
  xero_invoice_id text,
  invoice_number text,
  xero_created_at timestamptz,
  failure text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_order_customer_variation_invoices_created_check CHECK (
    status <> 'xero_draft_created' OR (xero_invoice_id IS NOT NULL AND xero_created_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_work_order_customer_variation_invoices_job
  ON public.work_order_customer_variation_invoices (job_id);
COMMENT ON TABLE public.work_order_customer_variation_invoices IS
  'The customer invoice line prepared from an approved customer variation (one per variation), and the Xero DRAFT invoice created from it. Xero is written only while feature flag customer_variation_xero_draft_v1 is on.';
ALTER TABLE public.work_order_customer_variation_invoices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_order_customer_variation_invoices_service_role_all ON public.work_order_customer_variation_invoices;
CREATE POLICY work_order_customer_variation_invoices_service_role_all ON public.work_order_customer_variation_invoices
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.work_order_customer_variation_invoices FROM anon, authenticated;

-- A line can be prepared only from an approved variation of the same job.
CREATE OR REPLACE FUNCTION public.work_order_customer_variation_invoices_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_var record;
BEGIN
  SELECT v.status, v.job_id INTO v_var FROM public.work_order_customer_variations v WHERE v.id = NEW.variation_id;
  IF NOT FOUND OR v_var.status <> 'approved' OR v_var.job_id IS DISTINCT FROM NEW.job_id THEN
    RAISE EXCEPTION 'an invoice line is prepared only from an approved customer variation of its job'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'xero_draft_created'
     AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'the Xero draft for this variation exists: change it in Xero' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_work_order_customer_variation_invoices_guard ON public.work_order_customer_variation_invoices;
CREATE TRIGGER trg_work_order_customer_variation_invoices_guard
  BEFORE INSERT OR UPDATE ON public.work_order_customer_variation_invoices
  FOR EACH ROW EXECUTE FUNCTION public.work_order_customer_variation_invoices_guard();

-- ── 4. feature flag, seeded OFF ──────────────────────────────────────────────

INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES
  ('customer_variation_xero_draft_v1', false,
   'Allow create_customer_variation_xero_draft to create a Xero DRAFT customer invoice holding an approved customer variation''s line. Off until the captain says so.')
ON CONFLICT (flag_name) DO NOTHING;
