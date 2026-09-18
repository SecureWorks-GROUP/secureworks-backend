-- Restore the old 12% full-carve-out CHECK so a 6% withhold insert is refused.
ALTER TABLE public.trade_invoices
  DROP CONSTRAINT IF EXISTS trade_invoices_super_gst_split_check;

ALTER TABLE public.trade_invoices
  ADD CONSTRAINT trade_invoices_super_gst_split_check CHECK (
    (
      gst_on IS NULL
      AND super_rate IS NULL
      AND super_amount IS NULL
      AND gross_earned IS NULL
      AND net_pay IS NULL
    )
    OR
    (
      gst_on IS NOT NULL
      AND super_rate = 0.12
      AND super_amount >= 0
      AND gross_earned >= 0
      AND net_pay >= 0
      AND gross_earned = round(subtotal_ex, 2)
      AND super_amount = round(gross_earned * super_rate, 2)
      AND net_pay = round(gross_earned - super_amount, 2)
      AND gst = CASE WHEN gst_on THEN round(gross_earned * 0.10, 2) ELSE 0 END
      AND total_inc = round(gross_earned + gst, 2)
    )
  );
