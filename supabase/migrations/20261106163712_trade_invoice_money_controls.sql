-- Trade invoice money controls (6 Nov 2026).
--
-- 1. trade_invoice_events: an append-only record of what the system or the
--    office did to a trade invoice outside the normal submit flow: a voided or
--    deleted Xero bill releasing its week, a stuck invoice resolved by the
--    office, an existing Xero bill reused on a retry, an extras rate held for
--    the office. Service role only.
-- 2. Invoice numbers are unique. The old number was a count of the trade's
--    invoices plus one, which repeats once a row is deleted.
-- 3. trade_invoice_extra_rate_rules: the office's highest unit rate per extras
--    line type. A trade-typed rate above it holds the line for office review
--    before anything reaches Xero. Ships empty.
-- 4. One live no-week invoice per person per work order and line kind. A
--    double submit is refused. Group shares are already one per person by
--    their own trigger; a line naming no work order, travel and deductions
--    are not claims.
--
-- No explicit transaction: the apply lane runs each migration in its own.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.trade_invoices
    WHERE invoice_number IS NOT NULL
    GROUP BY invoice_number
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'trade_invoice_money_controls: duplicate trade invoice numbers exist; fix them before this migration';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS trade_invoices_invoice_number_key
  ON public.trade_invoices (invoice_number)
  WHERE invoice_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.trade_invoice_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- No foreign key: the record outlives a deleted invoice row.
  trade_invoice_id uuid NOT NULL,
  event_type text NOT NULL,
  actor text NOT NULL,
  reason text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trade_invoice_events_type_check CHECK (event_type IN (
    'voided_bill_released',
    'stuck_invoice_resolved',
    'xero_bill_reused',
    'extra_rate_held'
  )),
  CONSTRAINT trade_invoice_events_actor_check CHECK (btrim(actor) <> ''),
  CONSTRAINT trade_invoice_events_detail_object CHECK (jsonb_typeof(detail) = 'object')
);

CREATE INDEX IF NOT EXISTS trade_invoice_events_invoice_idx
  ON public.trade_invoice_events (trade_invoice_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.trade_invoice_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'trade_invoice_events_append_only' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_trade_invoice_events_append_only ON public.trade_invoice_events;
CREATE TRIGGER trg_trade_invoice_events_append_only
  BEFORE UPDATE OR DELETE ON public.trade_invoice_events
  FOR EACH ROW EXECUTE FUNCTION public.trade_invoice_events_append_only();

ALTER TABLE public.trade_invoice_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trade_invoice_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.trade_invoice_events TO service_role;

CREATE TABLE IF NOT EXISTS public.trade_invoice_extra_rate_rules (
  -- An extras line type, lower case, or '*' for every type with no row.
  line_type text PRIMARY KEY,
  max_unit_rate_ex numeric(12,2) NOT NULL,
  note text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trade_invoice_extra_rate_rules_type_check CHECK (
    line_type = '*' OR (line_type = lower(btrim(line_type)) AND line_type <> '')
  ),
  CONSTRAINT trade_invoice_extra_rate_rules_rate_check CHECK (max_unit_rate_ex > 0)
);

ALTER TABLE public.trade_invoice_extra_rate_rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trade_invoice_extra_rate_rules FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trade_invoice_extra_rate_rules TO service_role;

-- The claim a no-week line makes: its work order and its kind.
CREATE OR REPLACE FUNCTION public.trade_invoice_no_week_claim_key(
  p_source_work_order_id uuid,
  p_line_type text
) RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT 'wo:' || p_source_work_order_id::text
    || '|' || lower(btrim(COALESCE(p_line_type, '')))
$$;

CREATE OR REPLACE FUNCTION public.trade_invoice_lines_no_week_claim_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_kind text;
  v_user uuid;
  v_week date;
  v_status text;
  v_claim text;
BEGIN
  IF NEW.trade_invoice_id IS NULL OR NEW.source_work_order_id IS NULL OR NEW.group_share_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  v_kind := lower(btrim(COALESCE(NEW.line_type, '')));
  IF v_kind = 'group share' OR v_kind LIKE '%travel%' OR COALESCE(NEW.line_total_ex, 0) <= 0 THEN
    RETURN NEW;
  END IF;
  SELECT i.user_id, i.week_start, i.status INTO v_user, v_week, v_status
  FROM public.trade_invoices i
  WHERE i.id = NEW.trade_invoice_id;
  IF NOT FOUND OR v_user IS NULL OR v_week IS NOT NULL
     OR COALESCE(v_status, '') IN ('draft', 'failed', 'ops-reject') THEN
    RETURN NEW;
  END IF;
  v_claim := public.trade_invoice_no_week_claim_key(NEW.source_work_order_id, NEW.line_type);
  PERFORM pg_advisory_xact_lock(
    hashtextextended('trade-invoice-no-week-claim:' || v_user::text || ':' || v_claim, 0)
  );
  IF EXISTS (
    SELECT 1
    FROM public.trade_invoice_lines l
    JOIN public.trade_invoices i ON i.id = l.trade_invoice_id
    WHERE i.user_id = v_user
      AND i.week_start IS NULL
      AND i.id <> NEW.trade_invoice_id
      AND COALESCE(i.status, '') NOT IN ('draft', 'failed', 'ops-reject')
      AND l.source_work_order_id = NEW.source_work_order_id
      AND l.group_share_id IS NULL
      AND COALESCE(l.line_total_ex, 0) > 0
      AND public.trade_invoice_no_week_claim_key(l.source_work_order_id, l.line_type) = v_claim
  ) THEN
    RAISE EXCEPTION 'no_week_claim_already_invoiced' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trade_invoice_lines_no_week_claim_guard ON public.trade_invoice_lines;
CREATE TRIGGER trg_trade_invoice_lines_no_week_claim_guard
  BEFORE INSERT ON public.trade_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION public.trade_invoice_lines_no_week_claim_guard();

COMMENT ON TABLE public.trade_invoice_events IS
  'Append-only record of system and office actions on a trade invoice outside the submit flow (20261106163712).';
COMMENT ON TABLE public.trade_invoice_extra_rate_rules IS
  'Office-set highest unit rate per trade invoice extras line type. A higher trade-typed rate is held for office review (20261106163712).';
