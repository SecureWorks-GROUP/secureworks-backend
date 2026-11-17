-- 20261117020000_trade_super_inclusive.sql
--
-- One super rule (owner, 17 Nov 2026, ticket P1-01): every rate and every work
-- order amount includes super. The super fund gets 12/112 of the total (12%
-- of what the person is paid) and the person is paid the rest. Super comes out
-- of every line paid to a person (hourly, work order claims, travel,
-- commission); a reimbursement line carries none. Nothing is paid on top.
--
-- On an invoice priced under this rule (super_basis = 'super_inclusive_v1'):
--
--   gross_earned   every line, reimbursements included
--   super_base_ex  gross less the reimbursement lines, never below 0. Stored
--                  only when the invoice carries a reimbursement.
--   super_amount   round(COALESCE(super_base_ex, gross_earned) * 12 / 112, 2)
--   net_pay        gross_earned - super_amount (paid to the person)
--   GST            unchanged: 10% of gross when gst_on
--
-- Every invoice priced before keeps its own stamp (null or employer_12_v2) and
-- its own check term, so no earlier week moves.
--
-- Because the invoice withholds the whole super, the job cost views read
-- employer super on top as super_amount - (subtotal_ex - net_pay) = 0 for
-- these invoices with no change to them (20261030170000 trade_employer_super).
--
-- 1. feature flag trade_super_inclusive_v1, seeded OFF.
-- 2. trade_super_inclusive_settings: one row, starts_on null until the office
--    sets it. ops-api reads it; service role may update it.
-- 3. trade_invoices_super_basis_check admits super_inclusive_v1.
-- 4. trade_invoices_super_gst_split_check: the 20261112090000 check term for
--    term, with the super amount and net pay terms split by basis and a
--    super inclusive term added.
-- 5. persist_weekly_trade_invoice_v1 and persist_trade_work_order_invoice_v1
--    insert super_basis and super_base_ex from the payload (null when the
--    payload has none, exactly as before). Guarded text patch.
-- 6. unfreeze_group_work_order_split refuses, by name, to strip a group share
--    from a super inclusive invoice (it would re-price it on the 12/6 split).
--    ops-api never prices an invoice carrying a group share under this rule,
--    so this is a guard, not a path. Guarded text patch.
--
-- Writes no invoice row. Apply before the matching ops-api.

-- ── 1. the switch ───────────────────────────────────────────────────────────

INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES
  ('trade_super_inclusive_v1', false,
   'One super rule (P1-01): from trade_super_inclusive_settings.starts_on every trade rate and work order amount includes super; the fund gets 12/112 of the total less reimbursements and the person the rest. Off until the owner says turn it on.')
ON CONFLICT (flag_name) DO NOTHING;

-- ── 2. the start date ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.trade_super_inclusive_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  starts_on date,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.trade_super_inclusive_settings IS
  'One row (P1-01). starts_on: the first invoice week (Monday week_start; an invoice with no week, the day it is priced) priced super inclusive while feature flag trade_super_inclusive_v1 is on. Null: the rule prices nothing. Set by the office on the owner''s word; never in code.';

INSERT INTO public.trade_super_inclusive_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.trade_super_inclusive_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.trade_super_inclusive_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, UPDATE ON TABLE public.trade_super_inclusive_settings TO service_role;

-- ── 3. the basis ────────────────────────────────────────────────────────────

ALTER TABLE public.trade_invoices DROP CONSTRAINT IF EXISTS trade_invoices_super_basis_check;
ALTER TABLE public.trade_invoices ADD CONSTRAINT trade_invoices_super_basis_check
  CHECK (super_basis IS NULL OR super_basis IN ('employer_12_v2', 'super_inclusive_v1'));
COMMENT ON COLUMN public.trade_invoices.super_basis IS
  'Null: the ordinary split (6% withheld from the worker, 6% company). employer_12_v2: a group share where the company pays all 12% super inside the share; net_pay equals gross_earned. super_inclusive_v1 (P1-01): every amount includes super; super is 12/112 of the base and net_pay is gross less super.';

-- ── 4. the split check ──────────────────────────────────────────────────────

ALTER TABLE public.trade_invoices DROP CONSTRAINT IF EXISTS trade_invoices_super_gst_split_check;
ALTER TABLE public.trade_invoices ADD CONSTRAINT trade_invoices_super_gst_split_check CHECK (
  ((gst_on IS NULL) AND (super_rate IS NULL) AND (super_amount IS NULL) AND (gross_earned IS NULL) AND (net_pay IS NULL) AND (super_basis IS NULL) AND (super_base_ex IS NULL))
  OR ((gst_on IS NOT NULL) AND (super_rate = 0.12) AND (super_amount >= 0) AND (gross_earned >= 0) AND (net_pay >= 0)
    AND (gross_earned = round(subtotal_ex, 2))
    AND (super_base_ex IS NULL OR (super_base_ex >= 0 AND super_base_ex < gross_earned))
    AND (
      (super_basis IS NULL AND (super_amount = round(COALESCE(super_base_ex, gross_earned) * super_rate, 2)) AND (
        (net_pay = round(gross_earned - round(COALESCE(super_base_ex, gross_earned) * 0.06, 2), 2))
        OR (super_base_ex IS NULL AND net_pay = round(gross_earned - super_amount, 2))
      ))
      OR (super_basis = 'employer_12_v2' AND (super_amount = round(COALESCE(super_base_ex, gross_earned) * super_rate, 2)) AND net_pay = gross_earned)
      OR (super_basis = 'super_inclusive_v1'
        AND super_amount = round(COALESCE(super_base_ex, gross_earned) * 12 / 112, 2)
        AND net_pay = round(gross_earned - super_amount, 2))
    )
    AND (gst = CASE WHEN gst_on THEN round(gross_earned * 0.10, 2) ELSE 0 END)
    AND (total_inc = round(gross_earned + gst, 2)))
);

-- ── 5. the persist inserts carry the basis ──────────────────────────────────
-- The deployed bodies are read from the catalog; two exact fragments in the
-- INSERT are extended, the rest is preserved byte for byte. Fail closed: each
-- fragment must appear exactly once. Safe to apply twice.

DO $persist$
DECLARE
  v_target record;
  v_def text;
  v_new text;
BEGIN
  FOR v_target IN
    SELECT * FROM (VALUES
      ('public.persist_weekly_trade_invoice_v1(jsonb, jsonb, uuid)',
       E'    gst_on, super_rate, super_amount, gross_earned, net_pay,\n    invoice_source,',
       E'    gst_on, super_rate, super_amount, gross_earned, net_pay,\n    super_basis, super_base_ex,\n    invoice_source,',
       E'    (p_invoice->>''net_pay'')::numeric,\n    v_invoice_source,',
       E'    (p_invoice->>''net_pay'')::numeric,\n    NULLIF(p_invoice->>''super_basis'', ''''),\n    NULLIF(p_invoice->>''super_base_ex'', '''')::numeric,\n    v_invoice_source,'),
      ('public.persist_trade_work_order_invoice_v1(jsonb, jsonb, uuid)',
       E'    gross_earned, net_pay, has_manual_overrides, override_details,',
       E'    gross_earned, net_pay, super_basis, super_base_ex, has_manual_overrides, override_details,',
       E'    (p_invoice->>''net_pay'')::numeric,\n    COALESCE((p_invoice->>''has_manual_overrides'')::boolean, false),',
       E'    (p_invoice->>''net_pay'')::numeric,\n    NULLIF(p_invoice->>''super_basis'', ''''),\n    NULLIF(p_invoice->>''super_base_ex'', '''')::numeric,\n    COALESCE((p_invoice->>''has_manual_overrides'')::boolean, false),')
    ) AS t(signature, cols_old, cols_new, vals_old, vals_new)
  LOOP
    IF to_regprocedure(v_target.signature) IS NULL THEN
      RAISE EXCEPTION 'trade_super_inclusive: % is not deployed', v_target.signature;
    END IF;
    v_def := pg_get_functiondef(to_regprocedure(v_target.signature));
    IF position('p_invoice->>''super_basis''' IN v_def) > 0 THEN
      CONTINUE; -- already patched
    END IF;
    IF (length(v_def) - length(replace(v_def, v_target.cols_old, ''))) / length(v_target.cols_old) <> 1
       OR (length(v_def) - length(replace(v_def, v_target.vals_old, ''))) / length(v_target.vals_old) <> 1 THEN
      RAISE EXCEPTION 'trade_super_inclusive: % insert changed; patch it by hand', v_target.signature;
    END IF;
    v_new := replace(v_def, v_target.cols_old, v_target.cols_new);
    v_new := replace(v_new, v_target.vals_old, v_target.vals_new);
    EXECUTE v_new;
  END LOOP;
END;
$persist$;

-- ── 6. the unfreeze refuses a super inclusive invoice ───────────────────────

DO $unfreeze$
DECLARE
  v_def text := pg_get_functiondef('public.unfreeze_group_work_order_split(uuid,uuid)'::regprocedure);
  v_anchor text := E'  SELECT COALESCE(array_agg(DISTINCT l.trade_invoice_id), ARRAY[]::uuid[])\n    INTO v_stripped';
  v_guard text := E'  IF EXISTS (\n'
    || E'    SELECT 1\n'
    || E'    FROM public.group_work_order_shares s\n'
    || E'    JOIN public.trade_invoice_lines l ON l.group_share_id = s.id\n'
    || E'    JOIN public.trade_invoices i ON i.id = l.trade_invoice_id\n'
    || E'    WHERE s.group_id = p_group_id\n'
    || E'      AND i.super_basis = ''super_inclusive_v1''\n'
    || E'  ) THEN\n'
    || E'    RAISE EXCEPTION ''group_split_super_inclusive_invoice'' USING ERRCODE = ''23514'';\n'
    || E'  END IF;\n\n';
BEGIN
  IF position('group_split_super_inclusive_invoice' IN v_def) > 0 THEN
    RETURN; -- already patched
  END IF;
  IF (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'trade_super_inclusive: unfreeze_group_work_order_split body changed; patch it by hand';
  END IF;
  EXECUTE replace(v_def, v_anchor, v_guard || v_anchor);
END;
$unfreeze$;
