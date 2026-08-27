-- Trade invoice super/GST money truth.
--
-- New invoices must persist the contractor's gross earned amount, the
-- statutory SG rate and worked-out super amount, net pay after super, and the
-- per-invoice GST choice. Existing invoices stay NULL: backfilling them would
-- falsely claim a historical super withholding that may not have happened.
--
-- Statutory source checked 2026-08-27: ATO "Super guarantee percentage" table,
-- general rate 12.00% from 1 July 2025 (including 2026-27 and 2027 onwards):
-- https://www.ato.gov.au/tax-rates-and-codes/key-superannuation-rates-and-thresholds/super-guarantee

ALTER TABLE public.trade_invoices
  ADD COLUMN IF NOT EXISTS gst_on boolean,
  ADD COLUMN IF NOT EXISTS super_rate numeric(7,6),
  ADD COLUMN IF NOT EXISTS super_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS gross_earned numeric(12,2),
  ADD COLUMN IF NOT EXISTS net_pay numeric(12,2);

COMMENT ON COLUMN public.trade_invoices.gst_on IS
  'Per-invoice GST choice. true = 10% GST on gross_earned; false = no GST. NULL only on legacy pre-split rows.';
COMMENT ON COLUMN public.trade_invoices.super_rate IS
  'Statutory Superannuation Guarantee rate snapshot used for this invoice (for example 0.120000). NULL only on legacy pre-split rows.';
COMMENT ON COLUMN public.trade_invoices.super_amount IS
  'Worked-out super allocation: round(gross_earned * super_rate, 2). This is part of gross earned, not an added cost.';
COMMENT ON COLUMN public.trade_invoices.gross_earned IS
  'Contractor earnings before super is split out and before optional GST. Equals subtotal_ex for split-aware invoices.';
COMMENT ON COLUMN public.trade_invoices.net_pay IS
  'Contractor earnings after super: gross_earned - super_amount, before GST.';

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

CREATE OR REPLACE FUNCTION public.enforce_trade_invoice_money_split_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.gst_on IS NULL
     OR NEW.super_rate IS NULL
     OR NEW.super_amount IS NULL
     OR NEW.gross_earned IS NULL
     OR NEW.net_pay IS NULL THEN
    RAISE EXCEPTION 'new trade invoices require gst_on, super_rate, super_amount, gross_earned and net_pay'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trade_invoices_require_money_split
  ON public.trade_invoices;
CREATE TRIGGER trg_trade_invoices_require_money_split
  BEFORE INSERT ON public.trade_invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_trade_invoice_money_split_v1();
