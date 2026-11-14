-- Rollback of 20261113190000_trade_super_on_top.sql.
-- Refuses while any invoice carries super_on_top_v1: those invoices were paid
-- the whole gross and must not be reread as a 6% withhold.
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.trade_invoices WHERE super_basis = 'super_on_top_v1') THEN
    RAISE EXCEPTION 'trade_super_on_top rollback refused: invoices carry super_on_top_v1';
  END IF;
END
$guard$;

DO $patch$
DECLARE
  v_def text := pg_get_functiondef('public.trade_invoice_lines_group_share_snapshot()'::regprocedure);
BEGIN
  IF position('i.super_basis = ''employer_12_v2''' IN v_def) > 0 THEN
    EXECUTE replace(v_def, 'i.super_basis = ''employer_12_v2''', 'i.super_basis IS NOT NULL');
  END IF;
END
$patch$;

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

ALTER TABLE public.trade_invoices DROP CONSTRAINT IF EXISTS trade_invoices_super_basis_check;
ALTER TABLE public.trade_invoices ADD CONSTRAINT trade_invoices_super_basis_check
  CHECK (super_basis IS NULL OR super_basis = 'employer_12_v2');

DROP TABLE IF EXISTS public.trade_super_on_top;
