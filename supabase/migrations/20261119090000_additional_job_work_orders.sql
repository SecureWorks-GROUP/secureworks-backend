-- 20261119090000_additional_job_work_orders.sql
--
-- More than one work order on a job (owner, 19 Nov 2026). A job can need
-- several pieces of work, each with its own scope and its own agreed amount:
-- a make-safe, a roof report, a restoration, a repair. "Trades invoice the
-- work order, not the job."
--
-- The job keeps its ONE main work order (work_orders.kind = 'job', unique per
-- job, everything 20261012130000 and later built on it is unchanged). Every
-- other work order on the job is a row of the new kind 'additional':
--
--   * its own number (WO-<job number>-<n>), title, scope, agreed amount and
--     trade, drafted then approved and sealed exactly like the main one;
--   * approving it records the amount as a work order amount change on the
--     job's main work order (P1-14, work_order_amount_changes), reason
--     "Additional work order <number>: <title>". So every job-level rule that
--     already reads the main work order plus its changes (the invoice cap,
--     job_backed_room, the trade line hold, the pay run checks, the group pot,
--     the overbilled list) allows the job's whole agreed labour with no change
--     to any of them, and nothing is counted twice;
--   * nothing that reads kind = 'job' sees it, and every crew reader reads
--     kind = 'crew' (ops-api moved off kind <> 'job' in the same change), so
--     it is never mistaken for either.
--
-- Super is not touched here: every work order amount includes super under the
-- one super rule (20261117020000, inclusive_12_112_v1, live from the pay week
-- of 23 Nov 2026), and that rule prices the trade's invoice, not the order.
--
-- 1. work_orders admits kind 'additional' (draft or approved), with title,
--    main_work_order_id and amount_change_id.
-- 2. The client read policy hides every kind but crew (it hid only 'job').
-- 3. work_orders_additional_guard: created as a draft, approved only through
--    approve_additional_work_order, sealed once approved, never deleted.
-- 4. approve_additional_work_order: the one approval door.
-- 5. job_cost_close counts additional work orders with the job's own.
--
-- Writes no work order. Apply before the matching ops-api.

SET LOCAL lock_timeout = '5s';

-- ── 1. the kind and its columns ─────────────────────────────────────────────

ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_kind_check;
ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_kind_check
  CHECK (kind = ANY (ARRAY['crew'::text, 'job'::text, 'additional'::text]));

ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_kind_status_check;
ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_kind_status_check CHECK (
  (kind = 'crew' AND status <> 'approved')
  OR (kind IN ('job', 'additional') AND status IN ('draft', 'approved'))
);

ALTER TABLE public.work_orders ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE public.work_orders ADD COLUMN IF NOT EXISTS main_work_order_id uuid
  REFERENCES public.work_orders(id) ON DELETE RESTRICT;
ALTER TABLE public.work_orders ADD COLUMN IF NOT EXISTS amount_change_id uuid
  REFERENCES public.work_order_amount_changes(id) ON DELETE RESTRICT;

ALTER TABLE public.work_orders DROP CONSTRAINT IF EXISTS work_orders_additional_shape_check;
ALTER TABLE public.work_orders ADD CONSTRAINT work_orders_additional_shape_check CHECK (
  (kind = 'additional'
     AND job_id IS NOT NULL
     AND title IS NOT NULL AND char_length(btrim(title)) BETWEEN 1 AND 120
     AND (status <> 'approved' OR (main_work_order_id IS NOT NULL AND amount_change_id IS NOT NULL)))
  OR (kind <> 'additional' AND main_work_order_id IS NULL AND amount_change_id IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_work_orders_additional_job
  ON public.work_orders (job_id) WHERE kind = 'additional';
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_orders_additional_number
  ON public.work_orders (job_id, wo_number) WHERE kind = 'additional';

COMMENT ON COLUMN public.work_orders.kind IS
  'crew = a trade''s crew-pay work order (existing behaviour). job = the job''s one main work order: draft, then approved (sealed). additional = any further work order on the same job (20261119090000): its own scope and agreed amount, approved through approve_additional_work_order, which adds its amount to the main work order as a work order amount change.';
COMMENT ON COLUMN public.work_orders.title IS
  'Additional work orders: what the work is, as the trade sees it ("Restoration works"). No money.';
COMMENT ON COLUMN public.work_orders.main_work_order_id IS
  'Additional work orders, once approved: the job''s main work order the amount was added to.';
COMMENT ON COLUMN public.work_orders.amount_change_id IS
  'Additional work orders, once approved: the work_order_amount_changes row that added this order''s amount to the main work order.';

-- ── 2. trades never read a job or additional work order directly ───────────

DROP POLICY IF EXISTS work_orders_job_kind_hidden_from_clients ON public.work_orders;
CREATE POLICY work_orders_job_kind_hidden_from_clients ON public.work_orders
  AS RESTRICTIVE FOR SELECT TO anon, authenticated
  USING (kind = 'crew');

-- ── 3. the seal ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.work_orders_additional_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_mutable text[] := ARRAY['viewed_at', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.kind = 'additional' AND OLD.status = 'approved' THEN
      RAISE EXCEPTION 'an approved additional work order is sealed and cannot be deleted'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.kind <> 'additional' THEN RETURN NEW; END IF;
    IF NEW.status <> 'draft' OR NEW.approved_at IS NOT NULL OR NEW.approved_by IS NOT NULL
       OR NEW.sealed_content_hash IS NOT NULL OR NEW.main_work_order_id IS NOT NULL
       OR NEW.amount_change_id IS NOT NULL THEN
      RAISE EXCEPTION 'an additional work order is created as a draft and approved afterwards'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.kind <> 'additional' THEN RETURN NEW; END IF;

  IF OLD.status = 'approved' THEN
    IF (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
      RAISE EXCEPTION 'an approved additional work order is sealed: a change is a variation or a new work order'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  NEW.updated_at := clock_timestamp();
  IF NEW.status = 'approved' THEN
    IF current_setting('secureworks.additional_work_order_approve', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'an additional work order is approved only through approve_additional_work_order'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.main_work_order_id IS DISTINCT FROM OLD.main_work_order_id
     OR NEW.amount_change_id IS DISTINCT FROM OLD.amount_change_id THEN
    RAISE EXCEPTION 'main_work_order_id and amount_change_id are set only by the approval'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_work_orders_additional_guard ON public.work_orders;
CREATE TRIGGER trg_work_orders_additional_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.work_orders
  FOR EACH ROW EXECUTE FUNCTION public.work_orders_additional_guard();

-- ── 4. the approval ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.approve_additional_work_order(
  p_work_order_id uuid,
  p_approver uuid,
  p_via text,
  p_expected_updated_at timestamptz,
  p_org_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  w public.work_orders%ROWTYPE;
  m public.work_orders%ROWTYPE;
  v_job_org uuid;
  v_change jsonb;
  v_current numeric;
  v_out public.work_orders%ROWTYPE;
BEGIN
  IF p_via IS NULL OR p_via NOT IN ('session', 'terminal') THEN
    RAISE EXCEPTION 'additional_work_order_via_invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO w FROM public.work_orders WHERE id = p_work_order_id FOR UPDATE;
  IF NOT FOUND OR w.kind <> 'additional' THEN
    RAISE EXCEPTION 'additional_work_order_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT j.org_id INTO v_job_org FROM public.jobs j WHERE j.id = w.job_id;
  IF p_org_id IS NULL OR NOT public.owner_approval_company_ok(p_approver, p_org_id, v_job_org)
     OR w.org_id IS DISTINCT FROM v_job_org THEN
    RAISE EXCEPTION 'scope_owner_approval_job_forbidden' USING ERRCODE = '42501';
  END IF;
  IF public.owner_approval_authority(p_approver) IS NULL THEN
    RAISE EXCEPTION 'only an approver named in work_order_settings can approve a work order'
      USING ERRCODE = '42501';
  END IF;
  IF w.status <> 'draft' THEN
    RAISE EXCEPTION 'additional_work_order_not_draft' USING ERRCODE = '23514';
  END IF;
  IF p_expected_updated_at IS NULL OR w.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'The draft changed after it was read. Read it again before approving.'
      USING ERRCODE = 'WO409';
  END IF;
  IF w.agreed_labour_ex IS NULL OR w.agreed_labour_ex <= 0 THEN
    RAISE EXCEPTION 'set the agreed labour amount before approving' USING ERRCODE = '23514';
  END IF;

  -- The job's main work order, approved with its agreed labour: the amount is
  -- added to it, so every job-level rule allows the whole job.
  SELECT * INTO m FROM public.work_orders
   WHERE job_id = w.job_id AND kind = 'job' AND status = 'approved'
   ORDER BY approved_at LIMIT 1
   FOR UPDATE;
  IF NOT FOUND OR m.agreed_labour_ex IS NULL THEN
    RAISE EXCEPTION 'main_work_order_not_approved: approve the job''s main work order first'
      USING ERRCODE = 'WO412';
  END IF;

  v_current := m.agreed_labour_ex + public.work_order_amount_change_total(m.id);
  v_change := public.change_work_order_amount(
    m.id,
    v_current + w.agreed_labour_ex,
    left('Additional work order ' || COALESCE(w.wo_number, w.id::text) || ': ' || btrim(w.title), 500),
    p_approver,
    p_org_id
  );

  -- The sealed content (number, job, scope, instructions, address, date,
  -- amount) does not change on approval, so it is hashed from the draft read
  -- under the lock and the seal is one write.
  PERFORM set_config('secureworks.additional_work_order_approve', 'on', true);
  UPDATE public.work_orders
     SET status = 'approved',
         approved_by = p_approver,
         approved_at = now(),
         approved_via = p_via,
         main_work_order_id = m.id,
         amount_change_id = (v_change->>'id')::uuid,
         sealed_content_hash = public.job_work_order_content_hash(w)
   WHERE id = w.id
   RETURNING * INTO v_out;
  PERFORM set_config('secureworks.additional_work_order_approve', 'off', true);

  RETURN to_jsonb(v_out) || jsonb_build_object('amount_change', v_change);
END $fn$;

REVOKE ALL ON FUNCTION public.approve_additional_work_order(uuid, uuid, text, timestamptz, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_additional_work_order(uuid, uuid, text, timestamptz, uuid)
  TO service_role;

COMMENT ON FUNCTION public.approve_additional_work_order(uuid, uuid, text, timestamptz, uuid) IS
  'Approves and seals one additional work order (20261119090000) and, in the same transaction, adds its agreed amount to the job''s main work order through change_work_order_amount. Refuses unless the approver is named in work_order_settings, the draft is unchanged since it was read, and the main work order is approved.';

-- ── 5. job cost close counts them with the job's own work order ─────────────

DO $patch$
DECLARE
  v_def text;
  v_old1 text := 'FILTER (WHERE w.kind = ''job''), 0),';
  v_new1 text := 'FILTER (WHERE w.kind IN (''job'', ''additional'')), 0),';
  v_old2 text := 'FILTER (WHERE w.kind IS DISTINCT FROM ''job''), 0)) AS agreed_labour_ex';
  v_new2 text := 'FILTER (WHERE w.kind = ''crew''), 0)) AS agreed_labour_ex';
BEGIN
  IF to_regprocedure('public.job_cost_close(uuid[], date)') IS NULL THEN
    RAISE EXCEPTION 'additional_job_work_orders: job_cost_close(uuid[], date) is not deployed';
  END IF;
  v_def := pg_get_functiondef('public.job_cost_close(uuid[], date)'::regprocedure);
  IF position(v_new1 IN v_def) > 0 AND position(v_new2 IN v_def) > 0 THEN
    RETURN; -- already patched
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1) <> 1
     OR (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2) <> 1 THEN
    RAISE EXCEPTION 'additional_job_work_orders: job_cost_close work_ordered changed; patch it by hand';
  END IF;
  EXECUTE replace(replace(v_def, v_old1, v_new1), v_old2, v_new2);
END $patch$;
