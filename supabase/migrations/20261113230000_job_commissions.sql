-- Ruling 17 step 2 (backend half): the commission rule, job_commissions and
-- the cap. Contract: docs/job-budget-v1.md, "Commission (step 2)".
--
--   commission_rates            the rate per trade (fencing 15, patios 8, of the
--                               budget's gross profit), append-only: a change is
--                               a new row. Staff read it; only an editor named in
--                               commission_rate_settings changes it, through
--                               set_commission_rate.
--   commission_rate_settings    one row: editor_user_ids (public.users.id). Ships
--                               empty: until the owner's id is written there,
--                               nobody can change a rate and the two seeded
--                               rates stand.
--   job_commissions             one row per stored job budget: the job, the
--                               salesperson (public.users.id), the rule, the
--                               percent and the expected amount, copied from the
--                               budget the moment it is stored (trigger on
--                               job_budgets). Write-once.
--   the cap                     a commission line on a job with a commission
--                               record is accepted only on the named
--                               salesperson's invoice and only while the job's
--                               counted commission lines stay within the
--                               expected amount. Triggers on trade_invoice_lines
--                               and trade_invoices, so every write path is held.
--
-- No operator share of profit is recorded anywhere. Nothing here reaches a
-- customer, a trade's job data or a crew document: every table is staff and
-- service only, and the cap's refusals carry codes, never amounts.

-- ─── The rate ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.commission_rate_settings (
  id              smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  editor_user_ids uuid[] NOT NULL DEFAULT '{}'::uuid[]
);
INSERT INTO public.commission_rate_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.commission_rates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade      text NOT NULL CHECK (trade IN ('fence', 'patio')),
  rule_id    text NOT NULL CHECK (btrim(rule_id) <> ''),
  percent    numeric(5,2) NOT NULL CHECK (percent BETWEEN 0 AND 100),
  basis      text NOT NULL DEFAULT 'gross_profit' CHECK (basis = 'gross_profit'),
  set_by     uuid,
  reason     text NOT NULL CHECK (btrim(reason) <> ''),
  set_at     timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS commission_rates_trade_idx ON public.commission_rates (trade, set_at DESC, id DESC);

-- The two rates the owner gave (ruling 17, 13 Nov 2026). Seeded once.
INSERT INTO public.commission_rates (trade, rule_id, percent, reason)
SELECT v.trade, v.rule_id, v.percent, 'Ruling 17: the owner''s rate, 13 Nov 2026'
  FROM (VALUES ('fence', 'fence_gross_profit_rate', 15.00::numeric),
               ('patio', 'patio_gross_profit_rate', 8.00::numeric)) AS v(trade, rule_id, percent)
 WHERE NOT EXISTS (SELECT 1 FROM public.commission_rates r WHERE r.trade = v.trade);

CREATE OR REPLACE FUNCTION public.commission_write_once()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'commission record is write-once: % on % refused', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS commission_rates_write_once ON public.commission_rates;
CREATE TRIGGER commission_rates_write_once
  BEFORE UPDATE OR DELETE ON public.commission_rates
  FOR EACH ROW EXECUTE FUNCTION public.commission_write_once();
DROP TRIGGER IF EXISTS commission_rates_write_once_truncate ON public.commission_rates;
CREATE TRIGGER commission_rates_write_once_truncate
  BEFORE TRUNCATE ON public.commission_rates
  FOR EACH STATEMENT EXECUTE FUNCTION public.commission_write_once();

-- The current rate per trade: the newest row.
CREATE OR REPLACE VIEW public.v_commission_rates
WITH (security_invoker = true) AS
SELECT DISTINCT ON (r.trade)
       r.trade, r.rule_id, r.percent, r.basis, r.set_by, r.set_at, r.id AS rate_id
  FROM public.commission_rates r
 ORDER BY r.trade, r.set_at DESC, r.id DESC;

-- Staff read the rate (the scoping tools read it with the staff sign-in, like
-- the staff-only scope tool defaults); nobody writes it but the writer below.
ALTER TABLE public.commission_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commission_rate_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS commission_rates_service_role ON public.commission_rates;
CREATE POLICY commission_rates_service_role ON public.commission_rates
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS commission_rates_staff_read ON public.commission_rates;
CREATE POLICY commission_rates_staff_read ON public.commission_rates
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.users u
                  WHERE u.id = auth.uid()
                    AND lower(u.role) = ANY (ARRAY['admin', 'owner', 'ops_manager', 'estimator'])));
DROP POLICY IF EXISTS commission_rate_settings_service_role ON public.commission_rate_settings;
CREATE POLICY commission_rate_settings_service_role ON public.commission_rate_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.commission_rates, public.commission_rate_settings, public.v_commission_rates
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.commission_rates, public.v_commission_rates TO authenticated;
GRANT SELECT, INSERT ON public.commission_rates TO service_role;
GRANT SELECT ON public.v_commission_rates TO service_role;
GRANT SELECT, UPDATE ON public.commission_rate_settings TO service_role;

-- The one writer of a rate change. The caller is the signed-in user (ops-api
-- passes the session's id, never a body field); only an id in
-- commission_rate_settings.editor_user_ids may change a rate. The rule id
-- stays the trade's.
CREATE OR REPLACE FUNCTION public.set_commission_rate(
  p_trade   text,
  p_percent numeric,
  p_reason  text,
  p_actor   uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_current public.commission_rates%ROWTYPE;
  v_new     public.commission_rates%ROWTYPE;
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.commission_rate_settings s WHERE s.id = 1 AND p_actor = ANY (s.editor_user_ids)
  ) THEN
    RAISE EXCEPTION 'commission_rate_editor_only' USING ERRCODE = 'P0001';
  END IF;
  IF p_trade IS NULL OR p_trade NOT IN ('fence', 'patio') THEN
    RAISE EXCEPTION 'commission_rate_trade_unknown' USING ERRCODE = 'P0001';
  END IF;
  IF p_percent IS NULL OR p_percent < 0 OR p_percent > 100 OR p_percent <> round(p_percent, 2) THEN
    RAISE EXCEPTION 'commission_rate_percent_invalid' USING ERRCODE = 'P0001';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'commission_rate_reason_required' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_current FROM public.commission_rates
   WHERE trade = p_trade ORDER BY set_at DESC, id DESC LIMIT 1;
  INSERT INTO public.commission_rates (trade, rule_id, percent, set_by, reason)
  VALUES (p_trade, COALESCE(v_current.rule_id, p_trade || '_gross_profit_rate'), p_percent, p_actor, btrim(p_reason))
  RETURNING * INTO v_new;
  RETURN jsonb_build_object('trade', v_new.trade, 'rule_id', v_new.rule_id, 'percent', v_new.percent,
                            'basis', v_new.basis, 'set_at', v_new.set_at, 'rate_id', v_new.id,
                            'previous_percent', v_current.percent);
END;
$$;
REVOKE ALL ON FUNCTION public.set_commission_rate(text, numeric, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_commission_rate(text, numeric, text, uuid) TO service_role;

-- ─── job_commissions ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.job_commissions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                 uuid NOT NULL REFERENCES public.jobs(id),
  budget_id              uuid NOT NULL UNIQUE REFERENCES public.job_budgets(id),
  version                int  NOT NULL CHECK (version >= 1),
  scope_revision_id      uuid NOT NULL,
  trade                  text NOT NULL,
  -- The salesperson the budget names, as sealed, and the same id once it is
  -- found to be a person of the job's company (else null: nobody may claim).
  -- named: a person and an amount; no_amount: a person, the budget has no
  -- commission figure (nothing may be claimed); otherwise no person.
  sealed_salesperson_id  uuid,
  salesperson_user_id    uuid REFERENCES public.users(id),
  state                  text NOT NULL CHECK (state IN ('named', 'no_salesperson', 'salesperson_not_found', 'no_amount')),
  rule_id                text,
  percent                numeric(5,2),
  basis                  text NOT NULL DEFAULT 'gross_profit' CHECK (basis = 'gross_profit'),
  gross_profit_ex_gst    numeric(12,2),
  expected_amount_ex_gst numeric(12,2) CHECK (expected_amount_ex_gst IS NULL OR expected_amount_ex_gst >= 0),
  created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT job_commissions_version_unique UNIQUE (job_id, version),
  CONSTRAINT job_commissions_state_matches
    CHECK (CASE state
             WHEN 'named'     THEN salesperson_user_id IS NOT NULL AND expected_amount_ex_gst IS NOT NULL
             WHEN 'no_amount' THEN salesperson_user_id IS NOT NULL AND expected_amount_ex_gst IS NULL
             ELSE salesperson_user_id IS NULL AND expected_amount_ex_gst IS NULL END),
  CONSTRAINT job_commissions_no_commission_on_a_loss
    CHECK (gross_profit_ex_gst IS NULL OR gross_profit_ex_gst > 0 OR expected_amount_ex_gst IS NULL OR expected_amount_ex_gst = 0)
);
CREATE INDEX IF NOT EXISTS job_commissions_salesperson_idx ON public.job_commissions (salesperson_user_id);

DROP TRIGGER IF EXISTS job_commissions_write_once ON public.job_commissions;
CREATE TRIGGER job_commissions_write_once
  BEFORE UPDATE OR DELETE ON public.job_commissions
  FOR EACH ROW EXECUTE FUNCTION public.commission_write_once();
DROP TRIGGER IF EXISTS job_commissions_write_once_truncate ON public.job_commissions;
CREATE TRIGGER job_commissions_write_once_truncate
  BEFORE TRUNCATE ON public.job_commissions
  FOR EACH STATEMENT EXECUTE FUNCTION public.commission_write_once();

ALTER TABLE public.job_commissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS job_commissions_service_role ON public.job_commissions;
CREATE POLICY job_commissions_service_role ON public.job_commissions
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.job_commissions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.job_commissions TO service_role;

-- The commission record of one stored budget, from the budget's own columns.
-- The salesperson is named only when the budget's id is a person of the job's
-- company; the amount is the budget's commission (0 on a loss, by the budget's
-- own check). Idempotent per budget.
CREATE OR REPLACE FUNCTION public.record_job_commission_from_budget(p_budget public.job_budgets)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_person uuid;
  v_state  text;
BEGIN
  IF p_budget.salesperson_staff_id IS NOT NULL THEN
    SELECT u.id INTO v_person
      FROM public.users u JOIN public.jobs j ON j.id = p_budget.job_id
     WHERE u.id = p_budget.salesperson_staff_id AND u.org_id = j.org_id;
  END IF;
  v_state := CASE
    WHEN p_budget.salesperson_staff_id IS NULL THEN 'no_salesperson'
    WHEN v_person IS NULL THEN 'salesperson_not_found'
    WHEN p_budget.commission_ex_gst IS NULL THEN 'no_amount'
    ELSE 'named' END;
  INSERT INTO public.job_commissions (
    job_id, budget_id, version, scope_revision_id, trade, sealed_salesperson_id,
    salesperson_user_id, state, rule_id, percent, gross_profit_ex_gst, expected_amount_ex_gst)
  VALUES (
    p_budget.job_id, p_budget.id, p_budget.version, p_budget.scope_revision_id, p_budget.trade,
    p_budget.salesperson_staff_id,
    CASE WHEN v_state IN ('named', 'no_amount') THEN v_person END, v_state,
    p_budget.commission_rule_id, p_budget.commission_pct, p_budget.gross_profit_ex_gst,
    CASE WHEN v_state = 'named' THEN p_budget.commission_ex_gst END)
  ON CONFLICT (budget_id) DO NOTHING;
END;
$$;
REVOKE ALL ON FUNCTION public.record_job_commission_from_budget(public.job_budgets) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.job_budgets_record_commission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.record_job_commission_from_budget(NEW);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.job_budgets_record_commission() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS job_budgets_record_commission ON public.job_budgets;
CREATE TRIGGER job_budgets_record_commission
  AFTER INSERT ON public.job_budgets
  FOR EACH ROW EXECUTE FUNCTION public.job_budgets_record_commission();

-- Budgets stored before this migration get their record now.
SELECT public.record_job_commission_from_budget(b)
  FROM public.job_budgets b
 WHERE NOT EXISTS (SELECT 1 FROM public.job_commissions c WHERE c.budget_id = b.id);

-- ─── The cap ────────────────────────────────────────────────────────────────

-- What counts against a job's commission: commission lines on the job, on an
-- invoice that is neither a draft nor refused by the office, whose line the
-- office has not refused. A draft does not hold the amount (the invoice route
-- writes a replacement before it removes the draft it replaces); it is checked
-- when it stops being a draft. p_include_invoice counts that invoice whatever
-- its status (the invoice being written).
CREATE OR REPLACE FUNCTION public.job_commission_claimed_ex_gst(p_job_id uuid, p_include_invoice uuid DEFAULT NULL)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(sum(l.line_total_ex), 0)::numeric(12,2)
    FROM public.trade_invoice_lines l
    JOIN public.trade_invoices i ON i.id = l.trade_invoice_id
   WHERE l.job_id = p_job_id
     AND lower(btrim(COALESCE(l.line_type, ''))) = 'commission'
     AND l.office_review_status IS DISTINCT FROM 'rejected'
     AND (i.id = p_include_invoice OR i.status NOT IN ('draft', 'ops-reject'));
$$;
REVOKE ALL ON FUNCTION public.job_commission_claimed_ex_gst(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_commission_claimed_ex_gst(uuid, uuid) TO service_role;

-- Hold one invoice's commission on one job to the job's current record. No
-- record: today's rules, nothing checked. The record row is locked so two
-- invoices on one job are checked one after the other.
CREATE OR REPLACE FUNCTION public.assert_job_commission_cap(p_job_id uuid, p_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rec     public.job_commissions%ROWTYPE;
  v_invoice public.trade_invoices%ROWTYPE;
  v_total   numeric;
BEGIN
  SELECT * INTO v_rec FROM public.job_commissions
   WHERE job_id = p_job_id ORDER BY version DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO v_invoice FROM public.trade_invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN RETURN; END IF;
  -- An invoice the office refused holds nothing.
  IF v_invoice.status = 'ops-reject' THEN RETURN; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.trade_invoice_lines l
     WHERE l.trade_invoice_id = p_invoice_id AND l.job_id = p_job_id
       AND lower(btrim(COALESCE(l.line_type, ''))) = 'commission'
       AND l.office_review_status IS DISTINCT FROM 'rejected'
  ) THEN
    RETURN;
  END IF;
  IF v_rec.salesperson_user_id IS NULL OR v_invoice.user_id IS DISTINCT FROM v_rec.salesperson_user_id THEN
    RAISE EXCEPTION 'commission_not_salesperson' USING ERRCODE = 'P0001';
  END IF;
  IF v_rec.state <> 'named' THEN
    RAISE EXCEPTION 'commission_amount_unknown' USING ERRCODE = 'P0001';
  END IF;
  v_total := public.job_commission_claimed_ex_gst(p_job_id, p_invoice_id);
  IF v_total > v_rec.expected_amount_ex_gst THEN
    RAISE EXCEPTION 'commission_over_amount' USING ERRCODE = 'P0001';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.assert_job_commission_cap(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.trade_invoice_lines_commission_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.job_id IS NOT NULL AND lower(btrim(COALESCE(NEW.line_type, ''))) = 'commission' THEN
    PERFORM public.assert_job_commission_cap(NEW.job_id, NEW.trade_invoice_id);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.trade_invoice_lines_commission_cap() FROM PUBLIC, anon, authenticated;

-- AFTER: every line of the statement is in place before the sum is read.
DROP TRIGGER IF EXISTS trade_invoice_lines_commission_cap ON public.trade_invoice_lines;
CREATE TRIGGER trade_invoice_lines_commission_cap
  AFTER INSERT OR UPDATE OF line_type, line_total_ex, job_id, trade_invoice_id, office_review_status
  ON public.trade_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION public.trade_invoice_lines_commission_cap();

-- An invoice that starts to count (a draft submitted, a refusal undone) or
-- changes hands is checked again for every job it claims commission on.
CREATE OR REPLACE FUNCTION public.trade_invoices_commission_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job uuid;
BEGIN
  IF NEW.status IN ('draft', 'ops-reject') THEN RETURN NULL; END IF;
  IF OLD.status NOT IN ('draft', 'ops-reject') AND OLD.user_id IS NOT DISTINCT FROM NEW.user_id THEN
    RETURN NULL;
  END IF;
  FOR v_job IN
    SELECT DISTINCT l.job_id FROM public.trade_invoice_lines l
     WHERE l.trade_invoice_id = NEW.id AND l.job_id IS NOT NULL
       AND lower(btrim(COALESCE(l.line_type, ''))) = 'commission'
     ORDER BY l.job_id
  LOOP
    PERFORM public.assert_job_commission_cap(v_job, NEW.id);
  END LOOP;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.trade_invoices_commission_cap() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trade_invoices_commission_cap ON public.trade_invoices;
CREATE TRIGGER trade_invoices_commission_cap
  AFTER UPDATE OF status, user_id ON public.trade_invoices
  FOR EACH ROW EXECUTE FUNCTION public.trade_invoices_commission_cap();

-- ─── One read ───────────────────────────────────────────────────────────────

-- Each job's current commission record, what counts against it and what is
-- left. Staff and service only.
CREATE OR REPLACE VIEW public.v_job_commission AS
SELECT DISTINCT ON (c.job_id)
       c.job_id, c.id AS commission_id, c.budget_id, c.version, c.scope_revision_id, c.trade,
       c.state, c.salesperson_user_id, c.sealed_salesperson_id, c.rule_id, c.percent, c.basis,
       c.gross_profit_ex_gst, c.expected_amount_ex_gst,
       public.job_commission_claimed_ex_gst(c.job_id) AS claimed_ex_gst,
       CASE WHEN c.expected_amount_ex_gst IS NULL THEN NULL
            ELSE c.expected_amount_ex_gst - public.job_commission_claimed_ex_gst(c.job_id) END AS remaining_ex_gst,
       c.created_at
  FROM public.job_commissions c
 ORDER BY c.job_id, c.version DESC;

REVOKE ALL ON public.v_job_commission FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_job_commission TO service_role;
