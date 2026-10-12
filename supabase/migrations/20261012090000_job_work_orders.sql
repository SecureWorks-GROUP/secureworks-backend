-- 20261012090000_job_work_orders.sql
--
-- One live work order per fencing and patio job (captain, 6 Oct 2026).
--
-- The existing work_orders table holds crew-pay work orders (one per trade,
-- priced scope the trade invoices against). This migration adds a second KIND
-- of row to the same table rather than a parallel record:
--
--   kind = 'crew'  every existing row, behaviour unchanged.
--   kind = 'job'   the job's own work order: what we have allowed and agreed
--                  for the whole job. Draft, then approved by Shaun. Approving
--                  SEALS it like an invoice: the row can no longer be edited,
--                  and later change is recorded as a variation.
--
-- What it adds:
--   1. work_orders: kind, agreed_labour_ex, approval and seal columns, and
--      the 'approved' status (job kind only).
--   2. jobs.work_order_id: the job's current job work order.
--   3. trade_invoice_lines.job_work_order_id: stamped when the trade's invoice
--      is submitted, with the job's APPROVED work order (drafts count for
--      nothing). Stamped by trigger so every submit path is covered. Lines
--      invoiced before the approval are stamped by the approval itself. Every
--      line on the job is stamped; which of them is labour is decided at read
--      time by v_trade_charge_resolved.cost_lane, the one definition.
--   4. work_order_variations: a trade's "there is a variation" on an invoice,
--      recorded against the job's approved work order. A variation raised on a
--      draft invoice is carried to the invoice row that replaces the draft
--      (carry_work_order_variations, called by the three draft-replacing
--      functions of 20260827112928 and 20260831021701).
--   5. work_order_variation_emails: the finance and admin emails per
--      variation. Sending is off until feature flag
--      work_order_variation_emails_v1 is on (seeded off).
--   6. work_order_settings: the users who may approve (seeded with Shaun's
--      users.id). Never a role: six users hold ops_manager. Approval that
--      names the approver through the x-sw-actor header (the terminal) is
--      refused by ops-api until feature flag work_order_terminal_approval_v1
--      is on (seeded off).
--   7. A trigger that opens a draft job work order when a fencing or patio job
--      becomes approved, and backfill_job_work_order_drafts(), dry run unless
--      p_apply AND feature flag job_work_order_backfill_v1 is on (seeded off).
--
-- Nothing here sends, writes Xero, or changes any existing row's values beyond
-- the new nullable / defaulted columns. The job trigger and the line linkers
-- swallow their own errors (RAISE WARNING) so they can never block a job write
-- or an invoice submit.

-- ── 1. work_orders ───────────────────────────────────────────────────────────

ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'crew',
  ADD COLUMN IF NOT EXISTS agreed_labour_ex numeric(12,2),
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS approved_via text,
  ADD COLUMN IF NOT EXISTS sealed_content_hash text,
  ADD COLUMN IF NOT EXISTS origin text;

ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_kind_check;
ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_kind_check
  CHECK (kind IN ('crew', 'job'));

ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_status_check;
ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_status_check
  CHECK (status IN ('draft', 'sent', 'accepted', 'in_progress', 'complete', 'cancelled', 'approved'));

ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_kind_status_check;
ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_kind_status_check
  CHECK (
    (kind = 'crew' AND status <> 'approved')
    OR (kind = 'job' AND status IN ('draft', 'approved'))
  );

ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_approved_sealed_check;
ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_approved_sealed_check
  CHECK (
    status <> 'approved'
    OR (approved_at IS NOT NULL AND approved_by IS NOT NULL
        AND agreed_labour_ex IS NOT NULL AND sealed_content_hash IS NOT NULL)
  );

ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_agreed_labour_check;
ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_agreed_labour_check
  CHECK (agreed_labour_ex IS NULL OR agreed_labour_ex >= 0);

ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_approved_via_check;
ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_approved_via_check
  CHECK (approved_via IS NULL OR approved_via IN ('session', 'terminal'));

ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_origin_check;
ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_origin_check
  CHECK (origin IS NULL OR origin IN ('job_approved', 'backfill', 'manual'));

-- One job work order per job: a draft, then that same row approved.
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_orders_job_current
  ON public.work_orders (job_id)
  WHERE kind = 'job';
CREATE INDEX IF NOT EXISTS idx_work_orders_kind ON public.work_orders (kind);

-- The table's existing "Users view org WOs" policy lets any signed-in org user
-- read work_orders straight from PostgREST. A job work order carries the
-- agreed labour, which trades must never see, so it is hidden from direct
-- anon / authenticated reads; ops-api (service role) serves it, and the trade
-- read leaves every price and allowance out.
DROP POLICY IF EXISTS work_orders_job_kind_hidden_from_clients ON public.work_orders;
CREATE POLICY work_orders_job_kind_hidden_from_clients ON public.work_orders
  AS RESTRICTIVE FOR SELECT TO anon, authenticated
  USING (kind <> 'job');

COMMENT ON COLUMN public.work_orders.kind IS
  'crew = a trade''s crew-pay work order (existing behaviour). job = the job''s one work order: draft, then approved (sealed) by an approver in work_order_settings.';
COMMENT ON COLUMN public.work_orders.agreed_labour_ex IS
  'Job work orders only: the labour we have allowed and agreed for the job, ex GST. Editable on a draft, sealed on approval.';
COMMENT ON COLUMN public.work_orders.sealed_content_hash IS
  'sha256 of the sealed content (scope, instructions, agreed labour), computed by the approval trigger.';

-- ── 2. jobs.work_order_id ────────────────────────────────────────────────────

-- Deliberately NOT a foreign key: work_orders.job_id already references jobs,
-- and a second relationship between the two tables makes every unhinted
-- PostgREST embed (`work_orders?select=jobs!inner(...)`, used by the crew-pay
-- invoice paths and by clients) ambiguous, which PostgREST refuses outright.
-- Only ensure_job_work_order_draft, approve_job_work_order and ops-api write it.
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS work_order_id uuid;
COMMENT ON COLUMN public.jobs.work_order_id IS
  'The job''s job work order (work_orders.kind = job): the draft, then that same row once approved.';

-- ── 3. trade_invoice_lines.job_work_order_id ─────────────────────────────────

-- Not a foreign key, for the same embed reason (trade_invoice_lines already
-- references work_orders through source_work_order_id). The stamp only ever
-- names an approved job work order, which the seal makes undeletable.
ALTER TABLE public.trade_invoice_lines
  ADD COLUMN IF NOT EXISTS job_work_order_id uuid;
CREATE INDEX IF NOT EXISTS idx_trade_invoice_lines_job_work_order
  ON public.trade_invoice_lines (job_work_order_id) WHERE job_work_order_id IS NOT NULL;
COMMENT ON COLUMN public.trade_invoice_lines.job_work_order_id IS
  'The job''s APPROVED job work order. Stamped by trigger at invoice submit, or by approve_job_work_order for labour invoiced before the approval. Never by a caller.';

-- ── 4. settings: who may approve ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.work_order_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  approver_user_ids uuid[] NOT NULL DEFAULT '{}',
  note text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.work_order_settings (id, approver_user_ids, note)
VALUES (
  1,
  ARRAY['9913309f-35ae-4a71-8e1f-f704ecc526ea']::uuid[],
  'Shaun (shaun@secureworkswa.com.au): only Shaun approves job work orders (captain, 6 Oct 2026)'
)
ON CONFLICT (id) DO NOTHING;
COMMENT ON TABLE public.work_order_settings IS
  'One row: the users (users.id) who may approve a job work order. Empty means nobody. Changing it is a ruling, not a code edit.';
ALTER TABLE public.work_order_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_order_settings_service_role_all ON public.work_order_settings;
CREATE POLICY work_order_settings_service_role_all ON public.work_order_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.work_order_settings FROM anon, authenticated;

-- ── 5. variations ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.work_order_variations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  -- The job's approved work order. NULL while the job has none: the variation
  -- is kept, and approve_job_work_order links it when the work order is approved.
  work_order_id uuid REFERENCES public.work_orders(id),
  -- A variation goes with an invoice that is deleted outright. When a draft is
  -- replaced, carry_work_order_variations moves it to the replacing row first.
  trade_invoice_id uuid NOT NULL REFERENCES public.trade_invoices(id) ON DELETE CASCADE,
  reported_by uuid NOT NULL REFERENCES public.users(id),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 2000),
  amount_ex numeric(12,2) CHECK (amount_ex IS NULL OR amount_ex >= 0),
  status text NOT NULL DEFAULT 'reported' CHECK (status IN ('reported', 'withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trade_invoice_id, job_id)
);
CREATE INDEX IF NOT EXISTS idx_work_order_variations_wo ON public.work_order_variations (work_order_id);
CREATE INDEX IF NOT EXISTS idx_work_order_variations_job ON public.work_order_variations (job_id);
COMMENT ON TABLE public.work_order_variations IS
  'A trade''s variation to a job work order, reported on their invoice. One per invoice per job. amount_ex is the part of that invoice the trade says is the variation.';
ALTER TABLE public.work_order_variations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_order_variations_service_role_all ON public.work_order_variations;
CREATE POLICY work_order_variations_service_role_all ON public.work_order_variations
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.work_order_variations FROM anon, authenticated;

-- ── 6. variation emails (one row per recipient; sending is flag-gated) ──────

CREATE TABLE IF NOT EXISTS public.work_order_variation_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variation_id uuid NOT NULL REFERENCES public.work_order_variations(id) ON DELETE CASCADE,
  recipient_role text NOT NULL CHECK (recipient_role IN ('finance', 'admin')),
  recipient text NOT NULL,
  subject text NOT NULL,
  body_text text NOT NULL,
  body_html text NOT NULL,
  status text NOT NULL DEFAULT 'recorded'
    CHECK (status IN ('recorded', 'sending', 'sent', 'failed')),
  sending_started_at timestamptz,
  sent_at timestamptz,
  send_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (variation_id, recipient_role)
);
COMMENT ON TABLE public.work_order_variation_emails IS
  'The finance email and the separate admin email for each work order variation. recorded = written, not sent: sending happens only while feature flag work_order_variation_emails_v1 is on. sending_started_at is the claim a send holds; a failed row, or one left in sending past the staleness bound, is re-sent by ops-api resend_work_order_variation_emails.';
ALTER TABLE public.work_order_variation_emails ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_order_variation_emails_service_role_all ON public.work_order_variation_emails;
CREATE POLICY work_order_variation_emails_service_role_all ON public.work_order_variation_emails
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.work_order_variation_emails FROM anon, authenticated;

-- ── 7. feature flags, seeded OFF ─────────────────────────────────────────────

INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES
  ('work_order_variation_emails_v1', false,
   'Send the finance and admin emails when a trade reports a work order variation. Off until the captain says so.'),
  ('job_work_order_backfill_v1', false,
   'Allow backfill_job_work_order_drafts(true) to open draft job work orders for open approved fencing and patio jobs.'),
  ('work_order_terminal_approval_v1', false,
   'Allow approve_work_order to take the approver from the self-declared x-sw-actor header on a server-secret call (the terminal). Off until the owner rules on that identity proof; approval from a signed-in session does not need it.')
ON CONFLICT (flag_name) DO NOTHING;

-- ── 8. the shared lists ──────────────────────────────────────────────────────

-- Open, approved job statuses: the client has accepted and the job is not
-- closed. Closed (complete, invoiced, final_payment, get_review, archived) and
-- dead (cancelled, lost) jobs are left alone.
CREATE OR REPLACE FUNCTION public.job_work_order_open_statuses()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'accepted', 'partially_accepted', 'approvals', 'deposit', 'awaiting_deposit',
    'processing', 'order_materials', 'awaiting_supplier', 'order_confirmed',
    'schedule_install', 'scheduled', 'in_progress', 'rectification'
  ]::text[]
$$;

-- Trade invoice statuses that count as billed. Draft and ops-reject do not.
-- Mirrored in ops-api/job_work_orders.ts JOB_WORK_ORDER_BILLED_INVOICE_STATUSES.
CREATE OR REPLACE FUNCTION public.job_work_order_billed_invoice_statuses()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'pending_acknowledgment', 'queried', 'acknowledged', 'pending_ops_review',
    'approved', 'pushed_to_xero', 'paid'
  ]::text[]
$$;

-- The approved job work order of a job, or NULL.
CREATE OR REPLACE FUNCTION public.job_live_work_order_id(p_job_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT wo.id FROM public.work_orders wo
  WHERE wo.job_id = p_job_id AND wo.kind = 'job' AND wo.status = 'approved'
  LIMIT 1
$$;

-- ── 9. the seal ──────────────────────────────────────────────────────────────

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

DROP TRIGGER IF EXISTS trg_work_orders_job_kind_guard ON public.work_orders;
CREATE TRIGGER trg_work_orders_job_kind_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.work_orders
  FOR EACH ROW EXECUTE FUNCTION public.work_orders_job_kind_guard();

-- ── 10. open a draft for a job ───────────────────────────────────────────────

-- Returns the job's job work order (approved, else the open draft), opening a
-- draft when there is neither, and points jobs.work_order_id at it.
-- Fencing and patio only.
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

DROP TRIGGER IF EXISTS trg_jobs_open_job_work_order ON public.jobs;
CREATE TRIGGER trg_jobs_open_job_work_order
  AFTER INSERT OR UPDATE OF status, type ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_open_job_work_order();

-- ── 11. approve (Shaun only) ─────────────────────────────────────────────────

-- Seals the job's draft and points jobs.work_order_id at it. In the same
-- transaction, labour already invoiced on the job (and any variation already
-- reported on it) is linked to the approved work order, so a job that was
-- invoiced before its work order was approved counts all of its labour.
CREATE OR REPLACE FUNCTION public.approve_job_work_order(
  p_work_order_id uuid,
  p_approver uuid,
  p_via text
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
  SELECT * INTO v_wo FROM public.work_orders WHERE id = p_work_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work order not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_wo.kind <> 'job' THEN
    RAISE EXCEPTION 'only a job work order is approved' USING ERRCODE = '23514';
  END IF;
  IF v_wo.status <> 'draft' THEN
    RAISE EXCEPTION 'work order is %, not draft', v_wo.status USING ERRCODE = '23514';
  END IF;

  UPDATE public.work_orders
    SET status = 'approved', approved_by = p_approver, approved_at = now(), approved_via = p_via
    WHERE id = v_wo.id
    RETURNING * INTO v_out;

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
REVOKE ALL ON FUNCTION public.approve_job_work_order(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_job_work_order(uuid, uuid, text) TO service_role;

-- ── 12. link invoice lines to the approved work order at submit ──────────────

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

-- ── 13. a variation survives its draft invoice being replaced ────────────────

-- Saving or submitting an invoice deletes the prior draft row and inserts a
-- new one. A variation raised on the draft moves to the replacing row, keeping
-- its id, its work order and its email ledger (so nothing is emailed again).
-- It moves only when the replacement still bills that job. Never blocks the
-- invoice write.
CREATE OR REPLACE FUNCTION public.carry_work_order_variations(
  p_prior_invoice_id uuid,
  p_replacement_invoice_id uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.work_order_variations v
    SET trade_invoice_id = p_replacement_invoice_id
    WHERE v.trade_invoice_id = p_prior_invoice_id
      AND EXISTS (
        SELECT 1 FROM public.trade_invoice_lines til
        WHERE til.trade_invoice_id = p_replacement_invoice_id AND til.job_id = v.job_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.work_order_variations kept
        WHERE kept.trade_invoice_id = p_replacement_invoice_id AND kept.job_id = v.job_id
      );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'work order variations not carried from trade invoice % to %: SQLSTATE %',
    p_prior_invoice_id, p_replacement_invoice_id, SQLSTATE;
END;
$$;
REVOKE ALL ON FUNCTION public.carry_work_order_variations(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.carry_work_order_variations(uuid, uuid) TO service_role;

-- The three draft-replacing functions belong to 20260827112928 and
-- 20260831021701. Their deployed bodies are read from the catalog and one call
-- is inserted in front of the prior draft's DELETE; the rest is preserved byte
-- for byte (the 20260826000001 next_job_number convention). Fail closed: the
-- patch refuses unless that DELETE appears exactly once. The rollback removes
-- the same one line.
DO $carry_work_order_variations$
DECLARE
  v_target record;
  v_definition text;
  v_pattern text;
  v_hits int;
BEGIN
  FOR v_target IN
    SELECT * FROM (VALUES
      ('public.replace_trade_invoice_draft_v1(uuid, uuid, uuid, uuid[])', 'p_prior_draft_id', 'p_replacement_id'),
      ('public.persist_trade_work_order_invoice_v1(jsonb, jsonb, uuid)', 'v_prior_draft_id', 'v_invoice_id'),
      ('public.persist_weekly_trade_invoice_v1(jsonb, jsonb, uuid)', 'v_prior_draft_id', 'v_invoice_id')
    ) AS t(signature, prior_variable, replacement_variable)
  LOOP
    IF to_regprocedure(v_target.signature) IS NULL THEN
      RAISE EXCEPTION '% is not deployed; work order variations cannot be carried across a draft replacement',
        v_target.signature;
    END IF;
    v_definition := pg_get_functiondef(to_regprocedure(v_target.signature));

    IF position('public.carry_work_order_variations(' IN v_definition) > 0 THEN
      CONTINUE;
    END IF;

    v_pattern := '([ \t]*)(DELETE FROM public\.trade_invoices\s+WHERE id = '
      || v_target.prior_variable || ';)';
    SELECT count(*) INTO v_hits FROM regexp_matches(v_definition, v_pattern, 'g');
    IF v_hits <> 1 THEN
      RAISE EXCEPTION '% deletes its prior draft % times (expected exactly 1); refusing to patch blind',
        v_target.signature, v_hits;
    END IF;

    EXECUTE regexp_replace(
      v_definition,
      v_pattern,
      E'\\1PERFORM public.carry_work_order_variations(' || v_target.prior_variable || ', '
        || v_target.replacement_variable || E');\n\\1\\2'
    );
  END LOOP;
END;
$carry_work_order_variations$;

-- ── 14. backfill: drafts for open approved jobs (switched off) ───────────────

CREATE OR REPLACE FUNCTION public.backfill_job_work_order_drafts(p_apply boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ids uuid[];
  v_by jsonb;
  v_opened int := 0;
  v_id uuid;
BEGIN
  SELECT COALESCE(array_agg(j.id ORDER BY j.created_at), '{}')
    INTO v_ids
  FROM public.jobs j
  WHERE j.type IN ('fencing', 'patio')
    AND j.status = ANY (public.job_work_order_open_statuses())
    AND NOT EXISTS (
      SELECT 1 FROM public.work_orders wo
      WHERE wo.job_id = j.id AND wo.kind = 'job' AND wo.status IN ('draft', 'approved')
    );

  SELECT COALESCE(jsonb_object_agg(k, n), '{}'::jsonb) INTO v_by FROM (
    SELECT j.type || ':' || j.status AS k, count(*) AS n
    FROM public.jobs j WHERE j.id = ANY (v_ids) GROUP BY 1
  ) x;

  IF p_apply THEN
    IF NOT COALESCE((SELECT f.enabled FROM public.feature_flags f
                     WHERE f.flag_name = 'job_work_order_backfill_v1' LIMIT 1), false) THEN
      RAISE EXCEPTION 'job work order backfill is switched off (feature flag job_work_order_backfill_v1)'
        USING ERRCODE = '42501';
    END IF;
    FOREACH v_id IN ARRAY v_ids LOOP
      PERFORM public.ensure_job_work_order_draft(v_id, 'backfill');
      v_opened := v_opened + 1;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'dry_run', NOT p_apply,
    'candidates', COALESCE(array_length(v_ids, 1), 0),
    'by_type_status', v_by,
    'job_ids', to_jsonb(v_ids),
    'opened', v_opened
  );
END;
$$;
REVOKE ALL ON FUNCTION public.backfill_job_work_order_drafts(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_job_work_order_drafts(boolean) TO service_role;

