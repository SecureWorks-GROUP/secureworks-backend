-- Trade invoice payable split (Captain 2026-09-18).
--
-- Super remittance stays 12% of gross_earned (bookkeeper / SG fund).
-- Cash withheld from the trade is 6%; the company contributes the other 6%.
-- net_pay becomes round(gross_earned - round(gross_earned * 0.06, 2), 2).
--
-- Historical rows written under the 2026-09-10 full 12% carve-out
-- (net_pay = gross_earned - super_amount) MUST remain valid: status and
-- Xero-identity updates still hit those rows. The CHECK therefore accepts
-- both formulae. New invoices are produced by trade_invoice_money.ts.
--
-- Do not backfill historical net_pay. That would rewrite settled pay.

COMMENT ON COLUMN public.trade_invoices.super_amount IS
  'SG remittance: round(gross_earned * super_rate, 2). Bookkeeper / fund figure; still 12%. Not reduced by the 2026-09-18 payable split.';
COMMENT ON COLUMN public.trade_invoices.net_pay IS
  'Cash payable before GST. From 2026-09-18: round(gross_earned - round(gross_earned * 0.06, 2), 2) (worker withhold 6%, company contributes the other 6% of SG). Legacy split-aware rows remain gross_earned - super_amount.';

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
      AND (
        net_pay = round(gross_earned - round(gross_earned * 0.06, 2), 2)
        OR net_pay = round(gross_earned - super_amount, 2)
      )
      AND gst = CASE WHEN gst_on THEN round(gross_earned * 0.10, 2) ELSE 0 END
      AND total_inc = round(gross_earned + gst, 2)
    )
  );
