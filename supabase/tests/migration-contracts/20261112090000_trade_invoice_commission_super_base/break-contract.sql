-- Put back the 20261030133000 check (super on the whole gross, no super base
-- term): the commission-excluded worked example must then be refused.
ALTER TABLE public.trade_invoices DROP CONSTRAINT trade_invoices_super_gst_split_check;
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
