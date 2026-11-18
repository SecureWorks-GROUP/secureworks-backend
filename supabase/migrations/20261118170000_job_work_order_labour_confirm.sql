-- FU49 item 9(a), option A (firstmate 18 Nov, director ruling pending): the
-- office confirms a draft job work order's agreed labour from the job's
-- SEALED budget in one press. Never a quote estimate, never a typed figure.
--
-- What this adds, and nothing else:
--   feature_flags row job_work_order_labour_confirm_v1 (off)
--   job_work_order_labour_confirmations: one append-only row per work order,
--     who confirmed which sealed amount and when
--   confirm_job_work_order_labour(...): the one write. It re-reads the
--     sealed budget under the work order's row lock, writes agreed_labour_ex
--     on the DRAFT (the seal trigger stamps hand_edited_at, so the draft is
--     never issued automatically) and records the confirmation in the same
--     transaction. Approving stays the named approver's separate press.
--
-- No existing table is altered, no index is added to one, no foreign key
-- points at one (so applying this takes no lock on work_orders, jobs,
-- job_budgets or users), and no existing function is replaced.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES (
  'job_work_order_labour_confirm_v1',
  false,
  'Office list of open jobs whose draft job work order has no agreed labour, and the one-press confirm of the sealed budget amount (FU49 9a).'
)
ON CONFLICT (flag_name) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.job_work_order_labour_confirmations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  job_id            uuid NOT NULL,
  work_order_id     uuid NOT NULL,
  job_budget_id     uuid NOT NULL,
  scope_revision_id uuid NOT NULL,
  agreed_labour_ex  numeric(12,2) NOT NULL CHECK (agreed_labour_ex >= 0),
  confirmed_by      uuid NOT NULL,
  confirmed_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT job_work_order_labour_confirmations_one_per_work_order UNIQUE (work_order_id)
);

COMMENT ON TABLE public.job_work_order_labour_confirmations IS
  'Who confirmed a draft job work order''s agreed labour from the job''s sealed budget, and when (FU49 9a). Append-only; written only by confirm_job_work_order_labour.';

ALTER TABLE public.job_work_order_labour_confirmations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_work_order_labour_confirmations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.job_work_order_labour_confirmations TO service_role;
DROP POLICY IF EXISTS job_work_order_labour_confirmations_service ON public.job_work_order_labour_confirmations;
CREATE POLICY job_work_order_labour_confirmations_service ON public.job_work_order_labour_confirmations
  FOR SELECT TO service_role USING (true);

CREATE OR REPLACE FUNCTION public.job_work_order_labour_confirmations_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$ BEGIN
  RAISE EXCEPTION 'job_work_order_labour_confirmations_append_only' USING ERRCODE = '23514';
END $$;

DROP TRIGGER IF EXISTS job_work_order_labour_confirmations_immutable
  ON public.job_work_order_labour_confirmations;
CREATE TRIGGER job_work_order_labour_confirmations_immutable
  BEFORE UPDATE OR DELETE ON public.job_work_order_labour_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.job_work_order_labour_confirmations_immutable();
DROP TRIGGER IF EXISTS job_work_order_labour_confirmations_immutable_truncate
  ON public.job_work_order_labour_confirmations;
CREATE TRIGGER job_work_order_labour_confirmations_immutable_truncate
  BEFORE TRUNCATE ON public.job_work_order_labour_confirmations
  FOR EACH STATEMENT EXECUTE FUNCTION public.job_work_order_labour_confirmations_immutable();

-- Refusals are returned, never raised, so a refused press writes nothing and
-- the caller reads one code. Codes only, never an amount in an error.
CREATE OR REPLACE FUNCTION public.confirm_job_work_order_labour(
  p_work_order_id uuid,
  p_job_budget_id uuid,
  p_expected_ex numeric,
  p_actor uuid,
  p_org_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  wo public.work_orders%ROWTYPE;
  v_done public.job_work_order_labour_confirmations%ROWTYPE;
  v_job_status text;
  v_budget_id uuid;
  v_revision uuid;
  v_raw jsonb;
  v_amount numeric; BEGIN
  IF NOT COALESCE((SELECT f.enabled FROM public.feature_flags f
                   WHERE f.flag_name = 'job_work_order_labour_confirm_v1' LIMIT 1), false) THEN
    RETURN jsonb_build_object('state', 'refused', 'code', 'labour_confirm_off');
  END IF;
  IF p_work_order_id IS NULL OR p_job_budget_id IS NULL OR p_actor IS NULL OR p_org_id IS NULL
     OR p_expected_ex IS NULL THEN
    RETURN jsonb_build_object('state', 'refused', 'code', 'confirm_input_required');
  END IF;
  -- The person pressing: an office role in this company.
  IF NOT EXISTS (SELECT 1 FROM public.users u
                 WHERE u.id = p_actor AND u.org_id = p_org_id
                   AND u.role IN ('admin', 'owner', 'ops_manager')) THEN
    RETURN jsonb_build_object('state', 'refused', 'code', 'operator_access_required');
  END IF;

  SELECT * INTO wo FROM public.work_orders WHERE id = p_work_order_id FOR UPDATE;
  IF NOT FOUND OR wo.kind IS DISTINCT FROM 'job' OR wo.org_id IS DISTINCT FROM p_org_id THEN
    RETURN jsonb_build_object('state', 'refused', 'code', 'work_order_not_found');
  END IF;

  -- A second press, or a retry after a lost reply, answers the first one.
  SELECT * INTO v_done FROM public.job_work_order_labour_confirmations
    WHERE work_order_id = wo.id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'state', 'already_confirmed',
      'work_order_id', v_done.work_order_id,
      'job_id', v_done.job_id,
      'job_budget_id', v_done.job_budget_id,
      'scope_revision_id', v_done.scope_revision_id,
      'agreed_labour_ex', v_done.agreed_labour_ex,
      'confirmed_by', v_done.confirmed_by,
      'confirmed_at', v_done.confirmed_at);
  END IF;

  IF wo.status IS DISTINCT FROM 'draft' THEN
    RETURN jsonb_build_object('state', 'refused', 'code', 'work_order_not_draft');
  END IF;
  IF wo.agreed_labour_ex IS NOT NULL THEN
    RETURN jsonb_build_object('state', 'refused', 'code', 'work_order_has_amount');
  END IF;
  SELECT j.status INTO v_job_status FROM public.jobs j
    WHERE j.id = wo.job_id AND j.org_id = p_org_id;
  IF NOT FOUND OR NOT (v_job_status = ANY (public.job_work_order_open_statuses())) THEN
    RETURN jsonb_build_object('state', 'refused', 'code', 'job_not_open');
  END IF;

  -- The job's newest sealed budget (job_budgets_version_unique (job_id, version)).
  SELECT b.id, b.scope_revision_id, b.budget->'labour'->'work_order_amount_ex_gst'
    INTO v_budget_id, v_revision, v_raw
    FROM public.job_budgets b
   WHERE b.job_id = wo.job_id
   ORDER BY b.version DESC
   LIMIT 1;
  IF v_budget_id IS NULL THEN
    RETURN jsonb_build_object('state', 'refused', 'code', 'no_sealed_budget');
  END IF;
  IF v_budget_id IS DISTINCT FROM p_job_budget_id THEN
    RETURN jsonb_build_object('state', 'refused', 'code', 'proposal_changed');
  END IF;
  IF v_raw IS NULL OR jsonb_typeof(v_raw) IS DISTINCT FROM 'number' OR (v_raw #>> '{}')::numeric < 0 THEN
    RETURN jsonb_build_object('state', 'refused', 'code', 'no_amount_in_sealed_quote');
  END IF;
  IF wo.quote_filled_scope_revision_id IS NOT NULL
     AND wo.quote_filled_scope_revision_id IS DISTINCT FROM v_revision THEN
    RETURN jsonb_build_object('state', 'refused', 'code', 'revision_differs');
  END IF;
  v_amount := round((v_raw #>> '{}')::numeric, 2);
  IF v_amount IS DISTINCT FROM round(p_expected_ex, 2) THEN
    RETURN jsonb_build_object('state', 'refused', 'code', 'proposal_changed');
  END IF;

  UPDATE public.work_orders SET agreed_labour_ex = v_amount
   WHERE id = wo.id AND kind = 'job' AND status = 'draft' AND agreed_labour_ex IS NULL;
  INSERT INTO public.job_work_order_labour_confirmations
    (org_id, job_id, work_order_id, job_budget_id, scope_revision_id, agreed_labour_ex, confirmed_by)
  VALUES (p_org_id, wo.job_id, wo.id, v_budget_id, v_revision, v_amount, p_actor)
  RETURNING * INTO v_done;

  RETURN jsonb_build_object(
    'state', 'confirmed',
    'work_order_id', v_done.work_order_id,
    'job_id', v_done.job_id,
    'job_budget_id', v_done.job_budget_id,
    'scope_revision_id', v_done.scope_revision_id,
    'agreed_labour_ex', v_done.agreed_labour_ex,
    'confirmed_by', v_done.confirmed_by,
    'confirmed_at', v_done.confirmed_at);
END $$;

REVOKE ALL ON FUNCTION public.confirm_job_work_order_labour(uuid, uuid, numeric, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_job_work_order_labour(uuid, uuid, numeric, uuid, uuid)
  TO service_role;
