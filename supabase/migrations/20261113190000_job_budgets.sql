-- Ruling 17 step 1: the job budget (`budget.v1`), locked at acceptance.
--
-- The Scope Engine builds the budget at seal and freezes it as the top-level key
-- `budget` of the revision's pricing record (`scope_revisions.pricing_canonical_text`,
-- covered by `pricing_hash`). At acceptance the job system stores it here exactly
-- as given, with the options the customer took added by the contract's one
-- formula (docs/job-budget-v1.md, section 5). The add-up checks run in the edge
-- function (`_shared/job_budget/budget_v1.ts`) before this writer is called; a
-- budget that does not add up is never stored: the acceptance stands and a
-- `job_budget_refused` job event records the code.
--
--   job_budgets       one row per accepted revision, never edited (a later
--                     accepted option or variation is a new version)
--   job_budget_lines  one row per line, per lane, unique on (budget_id, key)
--   record_job_budget the one writer, service role only, both tables in one
--                     transaction, idempotent per revision
--   v_job_budget      each job's current version, or "budget refused: <code>"
--
-- What this does NOT change: jobs.expected_costs is written exactly as before
-- (step 5 switches it). No customer, trade or crew read can reach these tables
-- (row-level security, one service-role policy, browser roles revoked). No
-- operator share of gross profit is stored anywhere here.

CREATE TABLE IF NOT EXISTS public.job_budgets (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                         uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  scope_revision_id              uuid NOT NULL REFERENCES public.scope_revisions(id) ON DELETE RESTRICT,
  version                        int  NOT NULL CHECK (version >= 1),
  pricing_hash                   text NOT NULL CHECK (pricing_hash ~ '^[0-9a-f]{64}$'),
  taken_option_ids               text[] NOT NULL DEFAULT '{}'::text[],
  trade                          text NOT NULL CHECK (trade IN ('patio', 'fence')),
  complete                       boolean NOT NULL,
  gap_count                      int  NOT NULL CHECK (gap_count >= 0),
  sell_ex_gst                    numeric(12,2),
  gst                            numeric(12,2),
  total_inc_gst                  numeric(12,2),
  materials_ex_gst               numeric(12,2),
  labour_ex_gst                  numeric(12,2),
  work_order_ex_gst              numeric(12,2),
  other_ex_gst                   numeric(12,2),
  cost_before_commission_ex_gst  numeric(12,2),
  gross_profit_ex_gst            numeric(12,2),
  gross_profit_pct               numeric(9,2),
  commission_rule_id             text,
  commission_pct                 numeric(5,2) CHECK (commission_pct IS NULL OR commission_pct BETWEEN 0 AND 100),
  commission_ex_gst              numeric(12,2) CHECK (commission_ex_gst IS NULL OR commission_ex_gst >= 0),
  profit_after_commission_ex_gst numeric(12,2),
  profit_after_commission_pct    numeric(9,2),
  scoped_by_staff_id             uuid,
  salesperson_staff_id           uuid,
  budget                         jsonb NOT NULL
    CHECK (jsonb_typeof(budget) = 'object' AND budget->>'version' = 'budget.v1'),
  created_at                     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_budgets_one_per_revision UNIQUE (job_id, scope_revision_id),
  CONSTRAINT job_budgets_version_unique UNIQUE (job_id, version),
  CONSTRAINT job_budgets_gst_adds_up CHECK (total_inc_gst IS NOT DISTINCT FROM sell_ex_gst + gst),
  CONSTRAINT job_budgets_gross_profit_adds_up
    CHECK (gross_profit_ex_gst IS NULL OR gross_profit_ex_gst = sell_ex_gst - cost_before_commission_ex_gst),
  CONSTRAINT job_budgets_profit_after_adds_up
    CHECK (profit_after_commission_ex_gst IS NULL OR profit_after_commission_ex_gst = gross_profit_ex_gst - commission_ex_gst),
  CONSTRAINT job_budgets_no_commission_on_a_loss
    CHECK (gross_profit_ex_gst IS NULL OR gross_profit_ex_gst > 0 OR commission_ex_gst IS NULL OR commission_ex_gst = 0),
  CONSTRAINT job_budgets_complete_means_no_gap CHECK (complete = (gap_count = 0))
);

CREATE TABLE IF NOT EXISTS public.job_budget_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id          uuid NOT NULL REFERENCES public.job_budgets(id) ON DELETE RESTRICT,
  job_id             uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  lane               text NOT NULL
    CHECK (lane IN ('materials', 'labour', 'delivery', 'removal', 'skip_and_tip', 'hire', 'buffer', 'other')),
  key                text NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  line_id            text,
  supplier_key       text,
  supplier_id        text,
  supplier_name      text,
  description        text,
  quantity           numeric,
  unit               text,
  unit_cost_ex_gst   numeric(12,2),
  cost_ex_gst        numeric(12,2),
  in_total           boolean NOT NULL,
  paid_to            text CHECK (paid_to IS NULL OR paid_to IN ('supplier', 'crew', 'office')),
  cost_from          text,
  option_id          text,
  CONSTRAINT job_budget_lines_key_unique UNIQUE (budget_id, key),
  CONSTRAINT job_budget_lines_supplier_key_on_materials CHECK ((lane = 'materials') = (supplier_key IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS job_budget_lines_job_idx ON public.job_budget_lines (job_id);

-- Written once, never edited or removed.
CREATE OR REPLACE FUNCTION public.job_budgets_write_once()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'job budget is write-once: % on % refused', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS job_budgets_write_once ON public.job_budgets;
CREATE TRIGGER job_budgets_write_once
  BEFORE UPDATE OR DELETE ON public.job_budgets
  FOR EACH ROW EXECUTE FUNCTION public.job_budgets_write_once();
DROP TRIGGER IF EXISTS job_budgets_write_once_truncate ON public.job_budgets;
CREATE TRIGGER job_budgets_write_once_truncate
  BEFORE TRUNCATE ON public.job_budgets
  FOR EACH STATEMENT EXECUTE FUNCTION public.job_budgets_write_once();
DROP TRIGGER IF EXISTS job_budget_lines_write_once ON public.job_budget_lines;
CREATE TRIGGER job_budget_lines_write_once
  BEFORE UPDATE OR DELETE ON public.job_budget_lines
  FOR EACH ROW EXECUTE FUNCTION public.job_budgets_write_once();
DROP TRIGGER IF EXISTS job_budget_lines_write_once_truncate ON public.job_budget_lines;
CREATE TRIGGER job_budget_lines_write_once_truncate
  BEFORE TRUNCATE ON public.job_budget_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.job_budgets_write_once();

-- Staff and service only: the budget carries commission and the salesperson.
ALTER TABLE public.job_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_budget_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS job_budgets_service_role ON public.job_budgets;
CREATE POLICY job_budgets_service_role ON public.job_budgets
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS job_budget_lines_service_role ON public.job_budget_lines;
CREATE POLICY job_budget_lines_service_role ON public.job_budget_lines
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.job_budgets, public.job_budget_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.job_budgets, public.job_budget_lines TO service_role;

-- The one writer. The edge function has already checked the budget adds up and
-- applied the options formula; this stores it, checks the revision is the job's
-- and frozen with that hash, refuses a third decimal, and is idempotent per
-- revision: the same budget again is a replay, a different one is a conflict.
CREATE OR REPLACE FUNCTION public.record_job_budget(
  p_job_id            uuid,
  p_scope_revision_id uuid,
  p_pricing_hash      text,
  p_taken_option_ids  text[],
  p_budget            jsonb,
  p_summary           jsonb,
  p_lines             jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing public.job_budgets%ROWTYPE;
  v_taken    text[] := COALESCE(p_taken_option_ids, '{}'::text[]);
  v_version  int;
  v_id       uuid;
  v_money    text[] := ARRAY['sell_ex_gst', 'gst', 'total_inc_gst', 'materials_ex_gst', 'labour_ex_gst',
                             'work_order_ex_gst', 'other_ex_gst', 'cost_before_commission_ex_gst',
                             'gross_profit_ex_gst', 'commission_ex_gst', 'profit_after_commission_ex_gst',
                             'gross_profit_pct', 'commission_pct', 'profit_after_commission_pct'];
BEGIN
  IF p_job_id IS NULL OR p_scope_revision_id IS NULL OR p_budget IS NULL OR p_summary IS NULL
     OR jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'job_budget_args_missing';
  END IF;

  PERFORM 1 FROM public.scope_revisions r
   WHERE r.id = p_scope_revision_id AND r.job_id = p_job_id
     AND r.status IN ('frozen', 'superseded') AND r.pricing_hash = p_pricing_hash;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job_budget_revision_mismatch';
  END IF;

  -- At most two decimal places: numeric(12,2) would round a third, so refuse it.
  IF EXISTS (
    SELECT 1 FROM unnest(v_money) k
     WHERE jsonb_typeof(p_summary->k) = 'number'
       AND (p_summary->>k)::numeric <> round((p_summary->>k)::numeric, 2)
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) l, unnest(ARRAY['unit_cost_ex_gst', 'cost_ex_gst']) k
     WHERE jsonb_typeof(l->k) = 'number' AND (l->>k)::numeric <> round((l->>k)::numeric, 2)
  ) THEN
    RAISE EXCEPTION 'job_budget_money_not_two_decimals';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('job_budget:' || p_job_id::text));

  SELECT * INTO v_existing FROM public.job_budgets
   WHERE job_id = p_job_id AND scope_revision_id = p_scope_revision_id;
  IF FOUND THEN
    IF v_existing.pricing_hash = p_pricing_hash AND v_existing.taken_option_ids = v_taken
       AND v_existing.budget = p_budget THEN
      RETURN jsonb_build_object('recorded', false, 'replayed', true,
                                'budget_id', v_existing.id, 'version', v_existing.version);
    END IF;
    RAISE EXCEPTION 'job_budget_conflict';
  END IF;

  SELECT COALESCE(max(version), 0) + 1 INTO v_version FROM public.job_budgets WHERE job_id = p_job_id;

  INSERT INTO public.job_budgets (
    job_id, scope_revision_id, version, pricing_hash, taken_option_ids, trade, complete, gap_count,
    sell_ex_gst, gst, total_inc_gst, materials_ex_gst, labour_ex_gst, work_order_ex_gst, other_ex_gst,
    cost_before_commission_ex_gst, gross_profit_ex_gst, gross_profit_pct, commission_rule_id,
    commission_pct, commission_ex_gst, profit_after_commission_ex_gst, profit_after_commission_pct,
    scoped_by_staff_id, salesperson_staff_id, budget)
  VALUES (
    p_job_id, p_scope_revision_id, v_version, p_pricing_hash, v_taken,
    p_summary->>'trade', (p_summary->>'complete')::boolean, (p_summary->>'gap_count')::int,
    (p_summary->>'sell_ex_gst')::numeric, (p_summary->>'gst')::numeric, (p_summary->>'total_inc_gst')::numeric,
    (p_summary->>'materials_ex_gst')::numeric, (p_summary->>'labour_ex_gst')::numeric,
    (p_summary->>'work_order_ex_gst')::numeric, (p_summary->>'other_ex_gst')::numeric,
    (p_summary->>'cost_before_commission_ex_gst')::numeric, (p_summary->>'gross_profit_ex_gst')::numeric,
    (p_summary->>'gross_profit_pct')::numeric, p_summary->>'commission_rule_id',
    (p_summary->>'commission_pct')::numeric, (p_summary->>'commission_ex_gst')::numeric,
    (p_summary->>'profit_after_commission_ex_gst')::numeric, (p_summary->>'profit_after_commission_pct')::numeric,
    (p_summary->>'scoped_by_staff_id')::uuid, (p_summary->>'salesperson_staff_id')::uuid, p_budget)
  RETURNING id INTO v_id;

  INSERT INTO public.job_budget_lines (
    budget_id, job_id, lane, key, line_id, supplier_key, supplier_id, supplier_name, description,
    quantity, unit, unit_cost_ex_gst, cost_ex_gst, in_total, paid_to, cost_from, option_id)
  SELECT v_id, p_job_id, x.lane, x.key, x.line_id, x.supplier_key, x.supplier_id, x.supplier_name,
         x.description, x.quantity, x.unit, x.unit_cost_ex_gst, x.cost_ex_gst, x.in_total, x.paid_to,
         x.cost_from, x.option_id
    FROM jsonb_to_recordset(p_lines) AS x(
      lane text, key text, line_id text, supplier_key text, supplier_id text, supplier_name text,
      description text, quantity numeric, unit text, unit_cost_ex_gst numeric, cost_ex_gst numeric,
      in_total boolean, paid_to text, cost_from text, option_id text);

  RETURN jsonb_build_object('recorded', true, 'replayed', false, 'budget_id', v_id, 'version', v_version);
END;
$$;

REVOKE ALL ON FUNCTION public.record_job_budget(uuid, uuid, text, text[], jsonb, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_job_budget(uuid, uuid, text, text[], jsonb, jsonb, jsonb)
  TO service_role;

-- One read for downstream: each job's current budget version, its lanes and
-- totals, or the refusal code when the budget did not add up (never "no budget").
CREATE OR REPLACE VIEW public.v_job_budget
WITH (security_invoker = true)
AS
WITH current_budget AS (
  SELECT DISTINCT ON (b.job_id) b.*
    FROM public.job_budgets b
   ORDER BY b.job_id, b.version DESC
), refused AS (
  SELECT DISTINCT ON (e.job_id) e.job_id, e.detail_json->>'code' AS code,
         e.detail_json->>'scope_revision_id' AS scope_revision_id, e.created_at
    FROM public.job_events e
   WHERE e.event_type = 'job_budget_refused'
   ORDER BY e.job_id, e.created_at DESC
)
SELECT c.job_id,
       'budget'::text AS state,
       NULL::text AS refused_code,
       'budget'::text AS state_label,
       c.id AS budget_id,
       c.version,
       c.scope_revision_id,
       c.pricing_hash,
       c.taken_option_ids,
       c.trade,
       c.complete,
       c.budget->'gaps' AS gaps,
       c.sell_ex_gst, c.gst, c.total_inc_gst,
       jsonb_build_object('materials', c.materials_ex_gst, 'labour', c.labour_ex_gst)
         || COALESCE((SELECT jsonb_object_agg(o->>'lane', o->'total_ex_gst')
                        FROM jsonb_array_elements(COALESCE(c.budget->'other', '[]'::jsonb)) o), '{}'::jsonb)
         AS lane_totals,
       c.budget->'materials'->'by_supplier' AS by_supplier,
       c.materials_ex_gst, c.labour_ex_gst, c.work_order_ex_gst, c.other_ex_gst,
       c.cost_before_commission_ex_gst, c.gross_profit_ex_gst, c.gross_profit_pct,
       c.commission_rule_id, c.commission_pct, c.commission_ex_gst,
       c.profit_after_commission_ex_gst, c.profit_after_commission_pct,
       c.scoped_by_staff_id, c.salesperson_staff_id,
       c.created_at
  FROM current_budget c
UNION ALL
SELECT r.job_id,
       'refused'::text,
       r.code,
       'budget refused: ' || COALESCE(r.code, 'unknown'),
       NULL::uuid, NULL::int,
       CASE WHEN r.scope_revision_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN r.scope_revision_id::uuid END,
       NULL::text, NULL::text[], NULL::text, false, NULL::jsonb,
       NULL::numeric, NULL::numeric, NULL::numeric,
       NULL::jsonb, NULL::jsonb,
       NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
       NULL::numeric, NULL::numeric, NULL::numeric,
       NULL::text, NULL::numeric, NULL::numeric,
       NULL::numeric, NULL::numeric,
       NULL::uuid, NULL::uuid,
       r.created_at
  FROM refused r
 WHERE NOT EXISTS (SELECT 1 FROM public.job_budgets b WHERE b.job_id = r.job_id);

REVOKE ALL ON public.v_job_budget FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_job_budget TO service_role;
