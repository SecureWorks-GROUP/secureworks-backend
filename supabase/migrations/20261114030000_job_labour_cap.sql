-- Ruling 17 step 4 (backend half): a job paid hourly up to a maximum holds
-- every trade to it. Trade invoice labour on such a job is refused past the
-- maximum unless the work order approver raises it, and every raise records
-- who, when, why and how much.
--
-- Contract: docs/job-budget-v1.md, section "Labour: pay mode and the hourly
-- cap (step 4)".
--
-- What this adds (additive only; writes no existing row):
--   1. job_labour_cap_raises: the approver's raises, append-only. Each names
--      the stored budget it raises (a new budget version starts again from its
--      own maximum).
--   2. job_labour_cap_state(job): the one read of a job's cap. The job's
--      newest stored budget (job_budgets) says how the crew is paid; on
--      'hourly_capped' the cap is labour.hourly.max_ex_gst plus the raises,
--      and what counts against it is every labour-lane charge resolved to the
--      job (v_trade_charge_resolved, the repo's one lane and job rule) on a
--      billed invoice (job_work_order_billed_invoice_statuses()).
--   3. The guard: deferred constraint triggers on trade_invoice_lines and
--      trade_invoices. At commit, an invoice carrying labour on a capped job
--      is refused (job_labour_cap_exceeded, 23514) when the job's billed
--      labour plus that invoice's own labour (its draft included) is over the
--      cap. A per-job transaction lock makes two invoices for one job take
--      turns, so two trades cannot both slip under it at once. A line edit
--      that only lowers a line is never refused.
--   4. raise_job_labour_cap(...): the only writer of a raise. Only an approver
--      the database already names (owner_approval_authority; the list is not
--      touched here) in the job's company, against the job's current budget,
--      when that budget pays hourly.
--   5. feature_flags.job_labour_budget_v1, seeded OFF. While it is off (or
--      missing or unreadable) the guard does nothing, and ops-api reads no
--      pay mode from the budget: invoicing and the work order fill run
--      exactly as before.
--
-- Rollback: supabase/rollbacks/20261114030000_job_labour_cap_down.sql.

-- ── 1. The raises ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.job_labour_cap_raises (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  job_id          uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  -- The stored budget whose maximum this raises.
  budget_id       uuid NOT NULL REFERENCES public.job_budgets(id) ON DELETE RESTRICT,
  amount_ex_gst   numeric(12,2) NOT NULL CHECK (amount_ex_gst > 0),
  reason          text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  -- A named approver (public.users.id) and the rule that let them.
  raised_by       uuid NOT NULL,
  raised_by_email text NULL,
  authority       text NOT NULL CHECK (authority IN ('owner', 'approver_list', 'backup_approver_list')),
  raised_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_labour_cap_raises_job_idx
  ON public.job_labour_cap_raises (job_id, budget_id);

COMMENT ON TABLE public.job_labour_cap_raises IS
  'Ruling 17 step 4: the work order approver''s raises of an hourly job''s labour maximum. Append-only; written only by raise_job_labour_cap. Staff and service only.';

ALTER TABLE public.job_labour_cap_raises ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.job_labour_cap_raises FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.job_labour_cap_raises TO service_role;

CREATE OR REPLACE FUNCTION public.job_labour_cap_raises_write_once()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'job_labour_cap_raises is append-only: a raise is never changed or deleted'
    USING ERRCODE = '42501';
END
$fn$;

DROP TRIGGER IF EXISTS job_labour_cap_raises_write_once ON public.job_labour_cap_raises;
CREATE TRIGGER job_labour_cap_raises_write_once
  BEFORE UPDATE OR DELETE ON public.job_labour_cap_raises
  FOR EACH ROW EXECUTE FUNCTION public.job_labour_cap_raises_write_once();

DROP TRIGGER IF EXISTS job_labour_cap_raises_no_truncate ON public.job_labour_cap_raises;
CREATE TRIGGER job_labour_cap_raises_no_truncate
  BEFORE TRUNCATE ON public.job_labour_cap_raises
  FOR EACH STATEMENT EXECUTE FUNCTION public.job_labour_cap_raises_write_once();

-- ── 2. The switch ───────────────────────────────────────────────────────────

INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES
  ('job_labour_budget_v1', false,
   'Ruling 17 step 4: the job budget says how the crew is paid. Hourly up to a maximum: trade invoice labour on the job is refused past the maximum unless the work order approver raises it; the job work order''s agreed labour comes from the budget. Off until the owner says.')
ON CONFLICT (flag_name) DO NOTHING;

CREATE OR REPLACE FUNCTION public.job_labour_budget_on()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT COALESCE((SELECT f.enabled FROM public.feature_flags f
                    WHERE f.flag_name = 'job_labour_budget_v1' LIMIT 1), false);
$fn$;

-- ── 3. The one read of a job's cap ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.job_labour_cap_state(p_job uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  b          record;
  v_pay      text;
  v_hourly   jsonb;
  v_rate     numeric;
  v_hours    numeric;
  v_max      numeric;
  v_labour   numeric;
  v_valid    boolean;
  v_raised   numeric;
  v_billed   numeric;
  v_cap      numeric;
BEGIN
  SELECT jb.id, jb.version, jb.scope_revision_id, jb.budget
    INTO b
    FROM public.job_budgets jb
   WHERE jb.job_id = p_job
   ORDER BY jb.version DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'no_budget', 'switch_on', public.job_labour_budget_on());
  END IF;
  v_pay := b.budget #>> '{labour,pay}';
  IF v_pay IS DISTINCT FROM 'hourly_capped' THEN
    RETURN jsonb_build_object('state', 'not_capped', 'switch_on', public.job_labour_budget_on(),
                              'pay', v_pay, 'budget_id', b.id, 'budget_version', b.version);
  END IF;
  v_hourly := b.budget #> '{labour,hourly}';
  -- A missing hourly object, {} or a missing property makes jsonb_typeof NULL,
  -- so every test is COALESCEd: unknown validity is invalid, never NULL.
  v_valid := COALESCE(jsonb_typeof(v_hourly) = 'object', false)
             AND COALESCE(jsonb_typeof(v_hourly->'rate_ex_gst') = 'number', false)
             AND COALESCE(jsonb_typeof(v_hourly->'max_hours') = 'number', false)
             AND COALESCE(jsonb_typeof(v_hourly->'max_ex_gst') = 'number', false)
             AND COALESCE(jsonb_typeof(b.budget #> '{labour,amount_ex_gst}') = 'number', false);
  IF v_valid THEN
    v_rate := (v_hourly->>'rate_ex_gst')::numeric;
    v_hours := (v_hourly->>'max_hours')::numeric;
    v_max := (v_hourly->>'max_ex_gst')::numeric;
    -- The labour the crew may bill: the hourly maximum plus every crew option
    -- the customer took (budget.v1 labour.amount_ex_gst, checked at storing).
    v_labour := (b.budget #>> '{labour,amount_ex_gst}')::numeric;
    v_valid := COALESCE(v_max >= 0 AND v_rate > 0 AND v_hours > 0 AND v_labour >= v_max, false);
  END IF;
  -- A stored maximum that cannot be read caps the job at nothing: no labour
  -- is let through on a guess (only an approver's raise lets labour in).
  IF v_valid IS NOT TRUE THEN
    v_valid := false;
    v_rate := NULL; v_hours := NULL; v_max := 0; v_labour := 0;
  END IF;
  SELECT COALESCE(sum(r.amount_ex_gst), 0) INTO v_raised
    FROM public.job_labour_cap_raises r
   WHERE r.job_id = p_job AND r.budget_id = b.id;
  SELECT COALESCE(sum(v.line_total_ex), 0) INTO v_billed
    FROM public.v_trade_charge_resolved v
   WHERE v.resolved_job_id = p_job
     AND v.cost_lane = 'labour'
     AND NOT v.is_probable_test_line
     AND v.invoice_status = ANY (public.job_work_order_billed_invoice_statuses());
  v_cap := round(v_labour + v_raised, 2);
  RETURN jsonb_build_object(
    'state', CASE WHEN v_valid THEN 'capped' ELSE 'capped_unreadable' END,
    'switch_on', public.job_labour_budget_on(),
    'pay', v_pay,
    'budget_id', b.id,
    'budget_version', b.version,
    'scope_revision_id', b.scope_revision_id,
    'rate_ex_gst', v_rate,
    'max_hours', v_hours,
    'max_ex_gst', round(v_max, 2),
    'crew_options_ex_gst', round(v_labour - v_max, 2),
    'raised_ex_gst', round(v_raised, 2),
    'cap_ex_gst', v_cap,
    'billed_ex_gst', round(v_billed, 2),
    'remaining_ex_gst', round(v_cap - v_billed, 2));
END
$fn$;

REVOKE ALL ON FUNCTION public.job_labour_cap_state(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_labour_cap_state(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.job_labour_budget_on() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_labour_budget_on() TO service_role;

-- ── 4. The guard ────────────────────────────────────────────────────────────

-- Checks one invoice: for each capped job it carries labour on, the job's
-- billed labour plus this invoice's own must stay within the cap.
CREATE OR REPLACE FUNCTION public.job_labour_cap_check_invoice(p_invoice uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_status text;
  v_job    uuid;
  v_state  jsonb;
  v_mine   numeric;
  v_total  numeric;
BEGIN
  IF NOT public.job_labour_budget_on() THEN
    RETURN;
  END IF;
  SELECT ti.status INTO v_status FROM public.trade_invoices ti WHERE ti.id = p_invoice;
  IF NOT FOUND OR v_status = 'ops-reject' THEN
    RETURN;
  END IF;
  FOR v_job IN
    SELECT DISTINCT v.resolved_job_id
      FROM public.v_trade_charge_resolved v
     WHERE v.trade_invoice_id = p_invoice
       AND v.cost_lane = 'labour'
       AND NOT v.is_probable_test_line
       AND v.resolved_job_id IS NOT NULL
     ORDER BY v.resolved_job_id
  LOOP
    IF (SELECT (jb.budget #>> '{labour,pay}') FROM public.job_budgets jb
         WHERE jb.job_id = v_job ORDER BY jb.version DESC LIMIT 1) IS DISTINCT FROM 'hourly_capped' THEN
      CONTINUE;
    END IF;
    -- One invoice per job at a time, so each sees the other's committed lines.
    PERFORM pg_advisory_xact_lock(hashtextextended('job_labour_cap:' || v_job::text, 0));
    SELECT COALESCE(sum(v.line_total_ex), 0) INTO v_mine
      FROM public.v_trade_charge_resolved v
     WHERE v.trade_invoice_id = p_invoice
       AND v.resolved_job_id = v_job
       AND v.cost_lane = 'labour'
       AND NOT v.is_probable_test_line;
    IF v_mine <= 0 THEN
      CONTINUE;
    END IF;
    v_state := public.job_labour_cap_state(v_job);
    -- Refuses on its own when the cap is missing or not a number: never a
    -- NULL comparison that lets the line through.
    IF jsonb_typeof(v_state->'cap_ex_gst') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'job_labour_cap_unreadable'
        USING ERRCODE = '23514', DETAIL = v_job::text;
    END IF;
    SELECT COALESCE(sum(v.line_total_ex), 0) INTO v_total
      FROM public.v_trade_charge_resolved v
     WHERE v.resolved_job_id = v_job
       AND v.cost_lane = 'labour'
       AND NOT v.is_probable_test_line
       AND (v.invoice_status = ANY (public.job_work_order_billed_invoice_statuses())
            OR v.trade_invoice_id = p_invoice);
    IF (v_total > (v_state->>'cap_ex_gst')::numeric + 0.004) IS NOT FALSE THEN
      RAISE EXCEPTION 'job_labour_cap_exceeded'
        USING ERRCODE = '23514', DETAIL = v_job::text;
    END IF;
  END LOOP;
END
$fn$;

REVOKE ALL ON FUNCTION public.job_labour_cap_check_invoice(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.job_labour_cap_guard_line()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NOT public.job_labour_budget_on() THEN
    RETURN NULL;
  END IF;
  -- Only lowering a line never needs the check.
  IF TG_OP = 'UPDATE'
     AND NEW.trade_invoice_id IS NOT DISTINCT FROM OLD.trade_invoice_id
     AND NEW.job_id IS NOT DISTINCT FROM OLD.job_id
     AND NEW.job_number IS NOT DISTINCT FROM OLD.job_number
     AND NEW.description IS NOT DISTINCT FROM OLD.description
     AND NEW.line_type IS NOT DISTINCT FROM OLD.line_type
     AND COALESCE(NEW.line_total_ex, 0) <= COALESCE(OLD.line_total_ex, 0) THEN
    RETURN NULL;
  END IF;
  -- The line may have gone again before commit (a replaced draft).
  IF NOT EXISTS (SELECT 1 FROM public.trade_invoice_lines l WHERE l.id = NEW.id) THEN
    RETURN NULL;
  END IF;
  PERFORM public.job_labour_cap_check_invoice(NEW.trade_invoice_id);
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.job_labour_cap_guard_invoice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  -- Only a move INTO billing is checked: a billed invoice moving on (approved
  -- to pushed or paid, the Xero mirror) is already counted and never refused,
  -- even when a newer budget lowered the cap since.
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status = ANY (public.job_work_order_billed_invoice_statuses())
     AND NOT (COALESCE(OLD.status, '') = ANY (public.job_work_order_billed_invoice_statuses())) THEN
    PERFORM public.job_labour_cap_check_invoice(NEW.id);
  END IF;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS job_labour_cap_guard_line ON public.trade_invoice_lines;
CREATE CONSTRAINT TRIGGER job_labour_cap_guard_line
  AFTER INSERT OR UPDATE ON public.trade_invoice_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.job_labour_cap_guard_line();

DROP TRIGGER IF EXISTS job_labour_cap_guard_invoice ON public.trade_invoices;
CREATE CONSTRAINT TRIGGER job_labour_cap_guard_invoice
  AFTER UPDATE ON public.trade_invoices
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.job_labour_cap_guard_invoice();

-- ── 5. The only writer of a raise ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.raise_job_labour_cap(
  p_job uuid,
  p_budget_id uuid,
  p_actor uuid,
  p_actor_email text,
  p_org_id uuid,
  p_amount numeric,
  p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_authority text;
  v_job_org   uuid;
  b           record;
  v_id        uuid;
BEGIN
  v_authority := public.owner_approval_authority(p_actor);
  IF v_authority IS NULL THEN
    RAISE EXCEPTION 'job_labour_cap_not_approver' USING ERRCODE = '42501';
  END IF;
  SELECT j.org_id INTO v_job_org FROM public.jobs j WHERE j.id = p_job;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job_labour_cap_job_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT COALESCE(public.owner_approval_company_ok(p_actor, p_org_id, v_job_org), false) THEN
    RAISE EXCEPTION 'job_labour_cap_wrong_company' USING ERRCODE = '42501';
  END IF;
  SELECT jb.id, jb.budget INTO b
    FROM public.job_budgets jb
   WHERE jb.job_id = p_job
   ORDER BY jb.version DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job_labour_cap_no_budget' USING ERRCODE = '23514';
  END IF;
  IF b.id IS DISTINCT FROM p_budget_id THEN
    RAISE EXCEPTION 'job_labour_cap_budget_changed' USING ERRCODE = '40001';
  END IF;
  IF (b.budget #>> '{labour,pay}') IS DISTINCT FROM 'hourly_capped' THEN
    RAISE EXCEPTION 'job_labour_cap_not_hourly' USING ERRCODE = '23514';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'job_labour_cap_amount_invalid' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'job_labour_cap_reason_invalid' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.job_labour_cap_raises
    (org_id, job_id, budget_id, amount_ex_gst, reason, raised_by, raised_by_email, authority)
  VALUES (v_job_org, p_job, b.id, p_amount, btrim(p_reason), p_actor, NULLIF(btrim(p_actor_email), ''), v_authority)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('raise_id', v_id, 'authority', v_authority,
                            'cap', public.job_labour_cap_state(p_job));
END
$fn$;

REVOKE ALL ON FUNCTION public.raise_job_labour_cap(uuid, uuid, uuid, text, uuid, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.raise_job_labour_cap(uuid, uuid, uuid, text, uuid, numeric, text) TO service_role;
