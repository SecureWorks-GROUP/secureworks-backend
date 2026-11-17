-- 20261117020000_trade_pay_inclusive_super.sql
--
-- One super rule (owner, 17 Nov 2026, ticket P1-01.1): every rate and every
-- work order amount includes super. The super fund gets 12/112 of the total
-- (12% of what the person is paid) and the person is paid the rest. Super
-- comes out of every line paid to a person; a reimbursement line carries none.
-- Nothing is paid on top.
--
-- On an invoice priced under this rule (super_basis = 'inclusive_12_112_v1'):
--
--   gross_earned   every line, reimbursements included
--   super_base_ex  gross less the reimbursement lines, never below 0. Stored
--                  only when it differs from gross.
--   super_amount   round(COALESCE(super_base_ex, gross_earned) * 12 / 112, 2)
--   net_pay        gross_earned - super_amount (paid to the person)
--   gst            10% of the base when gst_on (spec open point 1)
--
-- Every invoice priced before keeps its own stamp (null or employer_12_v2) and
-- the live check term for term, so no earlier week moves.
--
-- Because the invoice withholds the whole super, the job cost views read
-- employer super on top as super_amount - (subtotal_ex - net_pay) = 0 for
-- these invoices with no change to them (20261030170000 trade_employer_super).
--
-- 1. feature flag trade_pay_inclusive_super_v1, seeded OFF.
-- 2. trade_pay_settings: one row, every value empty until the owner's word.
-- 3. trade_pay_rule_on(p_day): the switch and the start date, read in SQL.
-- 4. trade_invoices_super_basis_check admits inclusive_12_112_v1.
-- 5. trade_invoices_super_gst_split_check: the 20261112090000 check as its
--    first branch, plus an inclusive branch.
-- 6. trade_invoice_lines_group_share_snapshot: the "carries its group share
--    and nothing else" guard narrows from any basis to employer_12_v2, so an
--    ordinary line may sit on an inclusive invoice. Guarded text patch.
-- 7. persist_weekly_trade_invoice_v1 and persist_trade_work_order_invoice_v1
--    insert super_basis and super_base_ex from the payload (null when the
--    payload has none, exactly as before). Guarded text patch. Beyond the
--    ticket: without it ops-api cannot store the basis through these two.
-- 8. unfreeze_group_work_order_split refuses, by name, to strip a group share
--    from an inclusive invoice (its 12/6 re-price would break the check).
--    Beyond the ticket. Guarded text patch.
--
-- Writes no invoice row and no setting value. Apply before the matching
-- ops-api.

-- ── 1. the switch ───────────────────────────────────────────────────────────

INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES ('trade_pay_inclusive_super_v1', false, 'One super rule: every trade invoice amount includes super; the fund gets 12/112 of the total, from trade_pay_settings.inclusive_super_from. Off: the old rules.')
ON CONFLICT (flag_name) DO NOTHING;

-- ── 2. the settings ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.trade_pay_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  inclusive_super_from date CHECK (inclusive_super_from IS NULL OR EXTRACT(ISODOW FROM inclusive_super_from) = 1),
  tax_set_aside_percent numeric(5,2) CHECK (tax_set_aside_percent IS NULL OR (tax_set_aside_percent >= 0 AND tax_set_aside_percent <= 60)),
  reimbursement_account_code text,
  pay_run_approver_user_ids uuid[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
INSERT INTO public.trade_pay_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.trade_pay_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.trade_pay_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.trade_pay_settings TO service_role;

COMMENT ON TABLE public.trade_pay_settings IS
  'Trade pay settings (P1-01). One row. inclusive_super_from: the first pay week (a Monday) priced on the one super rule while feature flag trade_pay_inclusive_super_v1 is on; null prices nothing. Written only on the owner''s word, never in code.';

-- ── 3. the rule in SQL ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.trade_pay_rule_on(p_day date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT p_day IS NOT NULL
    AND COALESCE((SELECT f.enabled FROM public.feature_flags f WHERE f.flag_name = 'trade_pay_inclusive_super_v1'), false)
    AND COALESCE(p_day >= (SELECT s.inclusive_super_from FROM public.trade_pay_settings s WHERE s.id = 1), false);
$fn$;
REVOKE ALL ON FUNCTION public.trade_pay_rule_on(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trade_pay_rule_on(date) TO service_role;

-- ── 4. the basis ────────────────────────────────────────────────────────────

ALTER TABLE public.trade_invoices DROP CONSTRAINT IF EXISTS trade_invoices_super_basis_check;
ALTER TABLE public.trade_invoices ADD CONSTRAINT trade_invoices_super_basis_check
  CHECK (super_basis IS NULL OR super_basis IN ('employer_12_v2', 'inclusive_12_112_v1'));
COMMENT ON COLUMN public.trade_invoices.super_basis IS
  'Null: the ordinary split (6% withheld from the worker, 6% company). employer_12_v2: a group share where the company pays all 12% super inside the share; net_pay equals gross_earned. inclusive_12_112_v1 (P1-01): every amount includes super; super is 12/112 of the total less reimbursements and net_pay is gross less super.';

-- ── 5. the split check ──────────────────────────────────────────────────────

ALTER TABLE public.trade_invoices DROP CONSTRAINT IF EXISTS trade_invoices_super_gst_split_check;
ALTER TABLE public.trade_invoices ADD CONSTRAINT trade_invoices_super_gst_split_check CHECK (
  ((gst_on IS NULL) AND (super_rate IS NULL) AND (super_amount IS NULL) AND (gross_earned IS NULL) AND (net_pay IS NULL) AND (super_basis IS NULL) AND (super_base_ex IS NULL))
  OR ((gst_on IS NOT NULL) AND (super_rate = 0.12) AND (super_amount >= 0) AND (gross_earned >= 0) AND (net_pay >= 0)
    AND (gross_earned = round(subtotal_ex, 2))
    AND (super_base_ex IS NULL OR (super_base_ex >= 0 AND super_base_ex < gross_earned))
    AND (
      (super_basis IS DISTINCT FROM 'inclusive_12_112_v1'
        AND super_amount = round(COALESCE(super_base_ex, gross_earned) * super_rate, 2)
        AND (
          (super_basis IS NULL AND (
            (net_pay = round(gross_earned - round(COALESCE(super_base_ex, gross_earned) * 0.06, 2), 2))
            OR (super_base_ex IS NULL AND net_pay = round(gross_earned - super_amount, 2))
          ))
          OR (super_basis = 'employer_12_v2' AND net_pay = gross_earned)
        )
        AND gst = CASE WHEN gst_on THEN round(gross_earned * 0.10, 2) ELSE 0 END)
      OR (super_basis = 'inclusive_12_112_v1'
        AND super_amount = round(COALESCE(super_base_ex, gross_earned) * 12 / 112, 2)
        AND net_pay = round(gross_earned - super_amount, 2)
        AND gst = CASE WHEN gst_on THEN round(COALESCE(super_base_ex, gross_earned) * 0.10, 2) ELSE 0 END)
    )
    AND (total_inc = round(gross_earned + gst, 2)))
);

-- ── 6. an ordinary line may sit on an inclusive invoice ────────────────────

DO $guard$
DECLARE
  v_def text := pg_get_functiondef('public.trade_invoice_lines_group_share_snapshot()'::regprocedure);
  v_old text := 'i.super_basis IS NOT NULL';
  v_new text := 'i.super_basis = ''employer_12_v2''';
  v_count int;
BEGIN
  v_count := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_count = 0 AND position(v_new IN v_def) > 0 THEN
    RETURN; -- already narrowed
  END IF;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'trade_pay_inclusive_super: expected the group share line guard once, found % times', v_count;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END;
$guard$;

-- ── 7. the persist inserts carry the basis ──────────────────────────────────
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
      RAISE EXCEPTION 'trade_pay_inclusive_super: % is not deployed', v_target.signature;
    END IF;
    v_def := pg_get_functiondef(to_regprocedure(v_target.signature));
    IF position('p_invoice->>''super_basis''' IN v_def) > 0 THEN
      CONTINUE; -- already patched
    END IF;
    IF (length(v_def) - length(replace(v_def, v_target.cols_old, ''))) / length(v_target.cols_old) <> 1
       OR (length(v_def) - length(replace(v_def, v_target.vals_old, ''))) / length(v_target.vals_old) <> 1 THEN
      RAISE EXCEPTION 'trade_pay_inclusive_super: % insert changed; patch it by hand', v_target.signature;
    END IF;
    v_new := replace(v_def, v_target.cols_old, v_target.cols_new);
    v_new := replace(v_new, v_target.vals_old, v_target.vals_new);
    EXECUTE v_new;
  END LOOP;
END;
$persist$;

-- ── 8. the unfreeze refuses an inclusive invoice ───────────────────────────

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
    || E'      AND i.super_basis = ''inclusive_12_112_v1''\n'
    || E'  ) THEN\n'
    || E'    RAISE EXCEPTION ''group_split_inclusive_super_invoice'' USING ERRCODE = ''23514'';\n'
    || E'  END IF;\n\n';
BEGIN
  IF position('group_split_inclusive_super_invoice' IN v_def) > 0 THEN
    RETURN; -- already patched
  END IF;
  IF (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'trade_pay_inclusive_super: unfreeze_group_work_order_split body changed; patch it by hand';
  END IF;
  EXECUTE replace(v_def, v_anchor, v_guard || v_anchor);
END;
$unfreeze$;
