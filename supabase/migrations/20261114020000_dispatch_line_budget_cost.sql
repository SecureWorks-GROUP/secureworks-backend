-- Ruling 17 step 3 (backend half): Dispatch material lines carry their cost
-- from the job budget, and an order line over its budget line, or a line not
-- in the budget, goes out only with a named person's reason recorded.
--
-- Contract: docs/job-budget-v1.md, section "Dispatch lines carry cost (step 3)".
--
-- What this adds (additive only; writes no existing row):
--   1. job_material_lines.budget_id + budget_line_key: the stored budget line
--      a Dispatch line was filled from (job_budgets is write-once, so the link
--      always reads the same line). Both null on a line typed in, on every
--      line filled before this migration, and on a job with no budget.
--   2. dispatch_line_cost_reasons: the reasons, append-only. One row per
--      reason given: who (a signed-in person, public.users.id), when, the
--      quantity it covers, and the unit cost they gave where the budget has
--      none. job_material_lines.cost_reason_id names the line's current one.
--   3. dispatch_supplier_order_emails.order_cost: the order's cost when the
--      email was made (each line's unit cost, line cost and basis, and the
--      supplier's budget). Staff record only: the email body is built from
--      the line text and never prints a dollar.
--   4. feature_flags.dispatch_budget_cost_v1, seeded OFF. While it is off
--      (or missing or unreadable) Dispatch fills, makes and sends exactly as
--      before. On: a job with a stored budget fills from the budget's
--      materials, every line carries its cost, and an order email is made and
--      sent only when every line on it is costed.
--
-- The rule itself (what is over, what needs a reason, how a line is costed)
-- is ops-api/dispatch_v2_budget_cost.ts, the one place. The database keeps the
-- shapes honest: a link names a real budget, a reason row is never changed or
-- deleted, and a reason is given by a person.
--
-- Rollback: supabase/rollbacks/20261114020000_dispatch_line_budget_cost_down.sql.

-- ── 1. The link from a Dispatch line to its budget line ─────────────────────

ALTER TABLE public.job_material_lines
  ADD COLUMN IF NOT EXISTS budget_id uuid NULL
    REFERENCES public.job_budgets(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS budget_line_key text NULL;

DO $link$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_material_lines_budget_link_shape') THEN
    ALTER TABLE public.job_material_lines ADD CONSTRAINT job_material_lines_budget_link_shape CHECK (
      (budget_id IS NULL) = (budget_line_key IS NULL)
      AND (budget_line_key IS NULL OR char_length(budget_line_key) BETWEEN 1 AND 200));
  END IF;
END $link$;

COMMENT ON COLUMN public.job_material_lines.budget_id IS
  'Ruling 17 step 3: the stored job budget (job_budgets) this line was filled from. Null on a line typed in or filled before step 3.';
COMMENT ON COLUMN public.job_material_lines.budget_line_key IS
  'Ruling 17 step 3: the key of the materials line in that budget (job_budget_lines.key). Set with budget_id, never alone.';

-- ── 2. The reasons ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.dispatch_line_cost_reasons (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  job_id            uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  line_id           uuid NOT NULL,
  -- The budget the line was costed against when the reason was given.
  budget_id         uuid NOT NULL REFERENCES public.job_budgets(id) ON DELETE RESTRICT,
  budget_line_key   text NULL CHECK (budget_line_key IS NULL OR char_length(budget_line_key) BETWEEN 1 AND 200),
  -- Why a reason was asked for (ops-api/dispatch_v2_budget_cost.ts).
  basis             text NOT NULL CHECK (basis IN (
                      'over_budget', 'unit_changed', 'quantity_changed', 'no_budget_cost', 'not_in_budget')),
  reason            text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  -- The quantity and unit the reason covers: a later rise needs a new reason.
  quantity          numeric(12,3) NOT NULL CHECK (quantity >= 0),
  unit              text NULL CHECK (unit IS NULL OR char_length(unit) BETWEEN 1 AND 30),
  -- The unit cost the person gave, where the budget gives none for this line.
  unit_cost_ex_gst  numeric(12,2) NULL CHECK (unit_cost_ex_gst IS NULL OR unit_cost_ex_gst >= 0),
  -- A named person: a signed-in user, never the ops key.
  given_by          uuid NOT NULL,
  given_by_email    text NULL,
  given_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dispatch_line_cost_reasons_line_idx
  ON public.dispatch_line_cost_reasons (line_id, given_at DESC);
CREATE INDEX IF NOT EXISTS dispatch_line_cost_reasons_job_idx
  ON public.dispatch_line_cost_reasons (job_id);

COMMENT ON TABLE public.dispatch_line_cost_reasons IS
  'Ruling 17 step 3: why a Dispatch line over its budget line, or not in the budget, may be ordered. Append-only; written only by ops-api dispatch_v2_line_cost_reason. Staff and service only.';

ALTER TABLE public.dispatch_line_cost_reasons ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.dispatch_line_cost_reasons FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.dispatch_line_cost_reasons TO service_role;

CREATE OR REPLACE FUNCTION public.dispatch_line_cost_reasons_write_once()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'dispatch_line_cost_reasons is append-only: a reason is never changed or deleted'
    USING ERRCODE = '42501';
END
$fn$;

DROP TRIGGER IF EXISTS dispatch_line_cost_reasons_write_once ON public.dispatch_line_cost_reasons;
CREATE TRIGGER dispatch_line_cost_reasons_write_once
  BEFORE UPDATE OR DELETE ON public.dispatch_line_cost_reasons
  FOR EACH ROW EXECUTE FUNCTION public.dispatch_line_cost_reasons_write_once();

DROP TRIGGER IF EXISTS dispatch_line_cost_reasons_no_truncate ON public.dispatch_line_cost_reasons;
CREATE TRIGGER dispatch_line_cost_reasons_no_truncate
  BEFORE TRUNCATE ON public.dispatch_line_cost_reasons
  FOR EACH STATEMENT EXECUTE FUNCTION public.dispatch_line_cost_reasons_write_once();

ALTER TABLE public.job_material_lines
  ADD COLUMN IF NOT EXISTS cost_reason_id uuid NULL
    REFERENCES public.dispatch_line_cost_reasons(id) ON DELETE RESTRICT;

COMMENT ON COLUMN public.job_material_lines.cost_reason_id IS
  'Ruling 17 step 3: the line''s current reason (dispatch_line_cost_reasons). Null when none was given.';

-- A line names only a reason given for itself, on its own job.
CREATE OR REPLACE FUNCTION public.job_material_lines_cost_reason_own()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_ok boolean;
BEGIN
  IF NEW.cost_reason_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.cost_reason_id IS NOT DISTINCT FROM OLD.cost_reason_id THEN
    RETURN NEW;
  END IF;
  SELECT r.line_id = NEW.id AND r.job_id = NEW.job_id
    INTO v_ok
    FROM public.dispatch_line_cost_reasons r
   WHERE r.id = NEW.cost_reason_id;
  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'dispatch_line_cost_reason_not_this_line'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS job_material_lines_cost_reason_own ON public.job_material_lines;
CREATE TRIGGER job_material_lines_cost_reason_own
  BEFORE INSERT OR UPDATE OF cost_reason_id ON public.job_material_lines
  FOR EACH ROW EXECUTE FUNCTION public.job_material_lines_cost_reason_own();

-- ── 3. The order's cost when its email was made ─────────────────────────────

ALTER TABLE public.dispatch_supplier_order_emails
  ADD COLUMN IF NOT EXISTS order_cost jsonb NULL;

DO $cost$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatch_supplier_order_emails_order_cost_shape') THEN
    ALTER TABLE public.dispatch_supplier_order_emails ADD CONSTRAINT dispatch_supplier_order_emails_order_cost_shape
      CHECK (order_cost IS NULL OR (jsonb_typeof(order_cost) = 'object'
                                    AND order_cost->>'version' = 'dispatch-order-cost.v1'));
  END IF;
END $cost$;

COMMENT ON COLUMN public.dispatch_supplier_order_emails.order_cost IS
  'Ruling 17 step 3: each line''s unit cost, line cost and basis, and the supplier''s budget, when the email was made. Staff record only; the email body never prints a dollar. Null on an email made with dispatch_budget_cost_v1 off or on a job with no budget.';

-- ── 4. The switch ───────────────────────────────────────────────────────────

INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES
  ('dispatch_budget_cost_v1', false,
   'Ruling 17 step 3: on a job with a stored budget, Dispatch fills from the budget''s materials, each line carries its cost, and an order line over its budget line or not in the budget is ordered only with a named person''s reason. Off until the owner says.')
ON CONFLICT (flag_name) DO NOTHING;
