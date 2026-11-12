-- 20261112090000_trade_invoice_commission_super_base.sql
--
-- No super on commission (Marnin, business owner, 12 Nov 2026).
--
-- Until now super (12% of gross, half withheld from the trade) was charged on
-- the whole gross of a trade invoice, commission lines included. From this
-- migration a commission line (trade_invoice_lines.line_type = 'commission',
-- the type ops-api saves through extraLineType) is outside the super base:
--
--   gross_earned   every line, commission included (unchanged)
--   super_base_ex  gross less the commission lines, never below 0. Stored
--                  ONLY when the invoice carries commission; null means the
--                  super base is the whole gross.
--   super_amount   12% of the super base
--   net_pay        gross less 6% of the super base
--
-- Historic rows keep super_base_ex null, so the split check below reads them
-- exactly as before: an invoice with commission that was priced on the old
-- rule (super on the whole gross) stays valid and is never re-priced.
--
-- 1. trade_invoices.super_base_ex (nullable numeric).
-- 2. trade_invoices_super_gst_split_check accepts the super base. With it null
--    the check is the 20261030133000 check, term for term.
-- 3. unfreeze_group_work_order_split recalculates an invoice's money with the
--    same super base when it strips a group share line (it rewrote super as
--    12% of every remaining line). An invoice whose super_base_ex is null is
--    recalculated exactly as before. Patched by guarded text replacement: if
--    the live body is not the 20261022050000 body the migration fails.
--
-- Writes no row. Apply before the matching ops-api and xero-sync.

ALTER TABLE public.trade_invoices
  ADD COLUMN IF NOT EXISTS super_base_ex numeric(12,2);

COMMENT ON COLUMN public.trade_invoices.super_base_ex IS
  'No super on commission (20261112090000): the amount super is charged on, ex GST, when the invoice carries commission lines (gross less commission, never below 0). Null: super is on the whole gross, as on every invoice before this column.';

ALTER TABLE public.trade_invoices DROP CONSTRAINT IF EXISTS trade_invoices_super_gst_split_check;
ALTER TABLE public.trade_invoices ADD CONSTRAINT trade_invoices_super_gst_split_check CHECK (
  ((gst_on IS NULL) AND (super_rate IS NULL) AND (super_amount IS NULL) AND (gross_earned IS NULL) AND (net_pay IS NULL) AND (super_basis IS NULL) AND (super_base_ex IS NULL))
  OR ((gst_on IS NOT NULL) AND (super_rate = 0.12) AND (super_amount >= 0) AND (gross_earned >= 0) AND (net_pay >= 0)
    AND (gross_earned = round(subtotal_ex, 2))
    AND (super_base_ex IS NULL OR (super_base_ex >= 0 AND super_base_ex < gross_earned))
    AND (super_amount = round(COALESCE(super_base_ex, gross_earned) * super_rate, 2))
    AND (
      (super_basis IS NULL AND (
        (net_pay = round(gross_earned - round(COALESCE(super_base_ex, gross_earned) * 0.06, 2), 2))
        OR (super_base_ex IS NULL AND net_pay = round(gross_earned - super_amount, 2))
      ))
      OR (super_basis = 'employer_12_v2' AND net_pay = gross_earned)
    )
    AND (gst = CASE WHEN gst_on THEN round(gross_earned * 0.10, 2) ELSE 0 END)
    AND (total_inc = round(gross_earned + gst, 2)))
);

DO $patch$
DECLARE
  v_def text := pg_get_functiondef('public.unfreeze_group_work_order_split(uuid,uuid)'::regprocedure);
  v_new text;
  -- The SET clause: super on the super base, and the base itself.
  v_set_old text := '      super_amount = round(m.line_sum * 0.12, 2),';
  v_set_new text := E'      super_amount = round(m.super_base * 0.12, 2),\n      super_base_ex = m.super_base_ex,';
  -- The withhold in new_net and in payable (two places).
  v_withhold_old text := 'round(raw.line_sum * 0.06, 2)';
  v_withhold_new text := 'round(raw.super_base * 0.06, 2)';
  -- Carry the base out of m.
  v_m_old text := 'raw.final_deductions,';
  v_m_new text := E'raw.final_deductions,\n           raw.super_base,\n           raw.super_base_ex,';
  -- Work the base out per invoice: the whole line sum when the invoice has no
  -- stored base (exactly as before), else the lines less commission.
  v_raw_old text := 'COALESCE(round(sum(l.line_total_ex), 2), 0) AS line_sum,';
  v_raw_new text := E'COALESCE(round(sum(l.line_total_ex), 2), 0) AS line_sum,\n'
    || E'             CASE WHEN i2.super_base_ex IS NULL THEN COALESCE(round(sum(l.line_total_ex), 2), 0)\n'
    || E'               ELSE GREATEST(0, COALESCE(round(sum(l.line_total_ex) FILTER (\n'
    || E'                 WHERE lower(btrim(COALESCE(l.line_type, \'\'))) <> \'commission\'\n'
    || E'               ), 2), 0)) END AS super_base,\n'
    || E'             CASE WHEN i2.super_base_ex IS NULL THEN NULL\n'
    || E'               ELSE GREATEST(0, COALESCE(round(sum(l.line_total_ex) FILTER (\n'
    || E'                 WHERE lower(btrim(COALESCE(l.line_type, \'\'))) <> \'commission\'\n'
    || E'               ), 2), 0)) END AS super_base_ex,';
BEGIN
  IF position('super_base' IN v_def) > 0 THEN
    RETURN; -- already patched (safe to apply twice)
  END IF;
  IF (length(v_def) - length(replace(v_def, v_set_old, ''))) / length(v_set_old) <> 1
     OR (length(v_def) - length(replace(v_def, v_withhold_old, ''))) / length(v_withhold_old) <> 2
     OR (length(v_def) - length(replace(v_def, v_m_old, ''))) / length(v_m_old) <> 1
     OR (length(v_def) - length(replace(v_def, v_raw_old, ''))) / length(v_raw_old) <> 1 THEN
    RAISE EXCEPTION 'trade_invoice_commission_super_base: unfreeze_group_work_order_split body changed; patch it by hand';
  END IF;
  v_new := replace(v_def, v_set_old, v_set_new);
  v_new := replace(v_new, v_withhold_old, v_withhold_new);
  v_new := replace(v_new, v_m_old, v_m_new);
  v_new := replace(v_new, v_raw_old, v_raw_new);
  EXECUTE v_new;
END;
$patch$;
