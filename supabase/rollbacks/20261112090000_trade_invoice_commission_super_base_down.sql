-- Rollback of 20261112090000_trade_invoice_commission_super_base.
--
-- Refuses while any invoice stores a super base: such an invoice was priced
-- with no super on its commission and the old check (super on the whole
-- gross) would reject it. Re-price or remove those invoices by hand first.
-- Otherwise restores the 20261030133000 split check, the 20261022050000
-- unfreeze body and drops the column. Roll back the matching ops-api and
-- xero-sync first: they select trade_invoices.super_base_ex.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.trade_invoices WHERE super_base_ex IS NOT NULL) THEN
    RAISE EXCEPTION 'trade_invoice_commission_super_base rollback: invoices store a super base (no super on commission); re-price them by hand first';
  END IF;
END $$;

DO $patch$
DECLARE
  v_def text := pg_get_functiondef('public.unfreeze_group_work_order_split(uuid,uuid)'::regprocedure);
  v_new text;
  v_set_new text := E'      super_amount = round(m.super_base * 0.12, 2),\n      super_base_ex = m.super_base_ex,';
  v_set_old text := '      super_amount = round(m.line_sum * 0.12, 2),';
  v_withhold_new text := 'round(raw.super_base * 0.06, 2)';
  v_withhold_old text := 'round(raw.line_sum * 0.06, 2)';
  v_m_new text := E'raw.final_deductions,\n           raw.super_base,\n           raw.super_base_ex,';
  v_m_old text := 'raw.final_deductions,';
  v_raw_new text := E'COALESCE(round(sum(l.line_total_ex), 2), 0) AS line_sum,\n'
    || E'             CASE WHEN i2.super_base_ex IS NULL THEN COALESCE(round(sum(l.line_total_ex), 2), 0)\n'
    || E'               ELSE GREATEST(0, COALESCE(round(sum(l.line_total_ex) FILTER (\n'
    || E'                 WHERE lower(btrim(COALESCE(l.line_type, \'\'))) <> \'commission\'\n'
    || E'               ), 2), 0)) END AS super_base,\n'
    || E'             CASE WHEN i2.super_base_ex IS NULL THEN NULL\n'
    || E'               ELSE GREATEST(0, COALESCE(round(sum(l.line_total_ex) FILTER (\n'
    || E'                 WHERE lower(btrim(COALESCE(l.line_type, \'\'))) <> \'commission\'\n'
    || E'               ), 2), 0)) END AS super_base_ex,';
  v_raw_old text := 'COALESCE(round(sum(l.line_total_ex), 2), 0) AS line_sum,';
BEGIN
  IF position('super_base' IN v_def) = 0 THEN
    RETURN; -- the unfreeze body is already the 20261022050000 body
  END IF;
  IF (length(v_def) - length(replace(v_def, v_set_new, ''))) / length(v_set_new) <> 1
     OR (length(v_def) - length(replace(v_def, v_withhold_new, ''))) / length(v_withhold_new) <> 2
     OR (length(v_def) - length(replace(v_def, v_m_new, ''))) / length(v_m_new) <> 1
     OR (length(v_def) - length(replace(v_def, v_raw_new, ''))) / length(v_raw_new) <> 1 THEN
    RAISE EXCEPTION 'trade_invoice_commission_super_base rollback: unfreeze_group_work_order_split body changed; restore it by hand';
  END IF;
  v_new := replace(v_def, v_raw_new, v_raw_old);
  v_new := replace(v_new, v_m_new, v_m_old);
  v_new := replace(v_new, v_withhold_new, v_withhold_old);
  v_new := replace(v_new, v_set_new, v_set_old);
  EXECUTE v_new;
END;
$patch$;

ALTER TABLE public.trade_invoices DROP CONSTRAINT IF EXISTS trade_invoices_super_gst_split_check;
ALTER TABLE public.trade_invoices ADD CONSTRAINT trade_invoices_super_gst_split_check CHECK (
  ((gst_on IS NULL) AND (super_rate IS NULL) AND (super_amount IS NULL) AND (gross_earned IS NULL) AND (net_pay IS NULL) AND (super_basis IS NULL))
  OR ((gst_on IS NOT NULL) AND (super_rate = 0.12) AND (super_amount >= 0) AND (gross_earned >= 0) AND (net_pay >= 0)
    AND (gross_earned = round(subtotal_ex, 2))
    AND (super_amount = round(gross_earned * super_rate, 2))
    AND (
      (super_basis IS NULL AND ((net_pay = round(gross_earned - round(gross_earned * 0.06, 2), 2)) OR (net_pay = round(gross_earned - super_amount, 2))))
      OR (super_basis = 'employer_12_v2' AND net_pay = gross_earned)
    )
    AND (gst = CASE WHEN gst_on THEN round(gross_earned * 0.10, 2) ELSE 0 END)
    AND (total_inc = round(gross_earned + gst, 2)))
);

ALTER TABLE public.trade_invoices DROP COLUMN IF EXISTS super_base_ex;
