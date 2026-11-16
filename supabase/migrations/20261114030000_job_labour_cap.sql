-- Ruling 17 step 4 (backend half): a job paid hourly up to a maximum holds
-- every trade to it, unless the work order approver raises it, and every
-- raise records who, when, why and how much.
--
-- Ruling 17c (16 Nov 2026): one labour cap per job, through one guard. The
-- refusal is the live work order cap's (_assertWithinWorkOrderTotal in
-- ops-api, work_order_total_cap.ts): same doors, same count, same codes. This
-- migration adds no guard of its own; it holds the hourly maximum's limit
-- and its raises, which that guard reads.
--
-- Contract: docs/job-budget-v1.md, section "Labour: pay mode and the hourly
-- cap (step 4)".
--
-- What this adds (additive only; writes no existing row):
--   1. job_labour_cap_raises: the approver's raises, append-only. Each names
--      the stored budget it raises (a new budget version starts again from its
--      own maximum).
--   2. job_labour_cap_state(job): the one read of a job's limit. The job's
--      newest stored budget (job_budgets) says how the crew is paid; on
--      'hourly_capped' the limit is what the work order promises the crew
--      (ruling 18 B): the budget's work order amount (the sealed hours times
--      the sealed rate, plus any crew option the customer took, plus every
--      counted line in another lane paid to the crew, a removal for one) plus
--      the raises. What counts against it is counted by the guard, not here.
--   3. raise_job_labour_cap(...): the only writer of a raise. Only an approver
--      the database already names (owner_approval_authority; the list is not
--      touched here) in the job's company, against the job's current budget,
--      when that budget pays hourly.
--   4. feature_flags.job_labour_budget_v1, seeded OFF. While it is off (or
--      missing) ops-api reads no pay mode from the budget: invoicing, the
--      cap and the work order fill run exactly as before.
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
  v_crew     numeric;
  v_crew_unknown integer;
  v_wo       numeric;
  v_valid    boolean;
  v_reason   text;
  v_raised   numeric;
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
  IF v_valid IS NOT TRUE THEN
    v_reason := 'labour_hourly_invalid';
  ELSE
    v_rate := (v_hourly->>'rate_ex_gst')::numeric;
    v_hours := (v_hourly->>'max_hours')::numeric;
    v_max := (v_hourly->>'max_ex_gst')::numeric;
    -- The labour: the hourly maximum plus every crew option the customer
    -- took (budget.v1 labour.amount_ex_gst, checked at storing).
    v_labour := (b.budget #>> '{labour,amount_ex_gst}')::numeric;
    -- The budget check's own rules (budget_v1.ts, labour.hourly), so a budget
    -- stored before a rule or by an older writer is read by today's rules:
    -- rate above zero, hours above zero, every figure to the cent (hours to
    -- two decimals) and the maximum exactly rate x hours, to the cent. The
    -- labour amount is never below the maximum. A record that breaks one of
    -- them holds two numbers that disagree; neither is picked.
    IF NOT (v_rate > 0 AND v_hours > 0 AND v_max >= 0)
       OR v_rate <> round(v_rate, 2) OR v_hours <> round(v_hours, 2)
       OR v_max <> round(v_max, 2) OR v_labour <> round(v_labour, 2) THEN
      v_reason := 'labour_hourly_invalid';
    ELSIF v_max <> round(v_rate * v_hours, 2) OR v_labour < v_max THEN
      v_reason := 'labour_hourly_mismatch';
    END IF;
  END IF;
  -- The limit is the agreed work order, one figure (ruling 17c): the crew is
  -- held to everything the work order pays it, and the guard counts every
  -- line the crew bills except commission. budget.v1 work_order_amount_ex_gst
  -- is the labour above plus every counted line in another lane paid to the
  -- crew (a removal the crew does, for one). It is read by the budget check's
  -- own rule (work_order_amount_mismatch): a line paid to the crew whose cost
  -- is unknown leaves the work order unknown, and a work order that is not
  -- the labour plus those lines, to the cent, is two numbers that disagree.
  -- Neither is picked; the rate and the hours are never changed for it.
  IF v_reason IS NULL THEN
    SELECT count(*) FILTER (WHERE jsonb_typeof(l->'cost_ex_gst') IS DISTINCT FROM 'number'),
           COALESCE(sum((l->>'cost_ex_gst')::numeric)
                      FILTER (WHERE jsonb_typeof(l->'cost_ex_gst') = 'number'), 0)
      INTO v_crew_unknown, v_crew
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.budget->'other') = 'array'
                                     THEN b.budget->'other' ELSE '[]'::jsonb END) o,
           jsonb_array_elements(CASE WHEN jsonb_typeof(o->'lines') = 'array'
                                     THEN o->'lines' ELSE '[]'::jsonb END) l
     WHERE l->'in_total' = 'true'::jsonb AND l->>'paid_to' = 'crew';
    IF v_crew_unknown > 0
       OR COALESCE(jsonb_typeof(b.budget #> '{labour,work_order_amount_ex_gst}') = 'number', false) IS NOT TRUE THEN
      v_reason := 'work_order_amount_unknown';
    ELSE
      v_wo := (b.budget #>> '{labour,work_order_amount_ex_gst}')::numeric;
      IF v_wo <> round(v_wo, 2) OR v_crew <> round(v_crew, 2) OR v_wo <> v_labour + v_crew THEN
        v_reason := 'work_order_amount_mismatch';
      END IF;
    END IF;
  END IF;
  v_valid := v_reason IS NULL;
  -- A stored maximum that cannot be read is never a limit: the state says
  -- capped_unreadable with a zero cap and names why (unreadable_reason, the
  -- budget check's code), and the ops-api guard refuses such a job as
  -- unreadable (503), never lets labour through on a guess.
  IF NOT v_valid THEN
    v_rate := NULL; v_hours := NULL; v_max := 0; v_labour := 0; v_crew := 0; v_wo := 0;
  END IF;
  SELECT COALESCE(sum(r.amount_ex_gst), 0) INTO v_raised
    FROM public.job_labour_cap_raises r
   WHERE r.job_id = p_job AND r.budget_id = b.id;
  v_cap := round(v_wo + v_raised, 2);
  RETURN jsonb_build_object(
    'state', CASE WHEN v_valid THEN 'capped' ELSE 'capped_unreadable' END,
    'unreadable_reason', v_reason,
    'switch_on', public.job_labour_budget_on(),
    'pay', v_pay,
    'budget_id', b.id,
    'budget_version', b.version,
    'scope_revision_id', b.scope_revision_id,
    'rate_ex_gst', v_rate,
    'max_hours', v_hours,
    'max_ex_gst', round(v_max, 2),
    'crew_options_ex_gst', round(v_labour - v_max, 2),
    'crew_lines_ex_gst', round(v_crew, 2),
    'work_order_ex_gst', round(v_wo, 2),
    'raised_ex_gst', round(v_raised, 2),
    'cap_ex_gst', v_cap);
END
$fn$;

REVOKE ALL ON FUNCTION public.job_labour_cap_state(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_labour_cap_state(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.job_labour_budget_on() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_labour_budget_on() TO service_role;

-- ── 4. The only writer of a raise ───────────────────────────────────────────

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
