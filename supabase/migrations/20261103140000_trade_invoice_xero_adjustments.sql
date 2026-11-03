-- Group work orders field-ready check V10 (job-profit INBOX, 3 Nov 2026):
-- pay deductions the office adds in Xero.
--
-- The office adds its own lines to a crew bill in Xero after our push, for
-- example "Vehicle Loan repayment" -100.00 on account 611 (SW-INV-A-261011-029:
-- app 1438.20, Xero 1338.20) and "Back payment on over payment" -50.00 on 712
-- (SW-INV-A-261015-020: app 631.68, Xero 581.68). The app, and the crew member,
-- saw pay before them. xero-sync now reads each crew bill's lines and records
-- here what Xero pays and every line the office changed, named.
--
--   xero_bill_total        the bill's total in Xero (what Xero pays)
--   xero_adjustments_ex    the sum of the office's changes, in the bill's line
--                          amounts (ex GST: our push writes ex-GST amounts)
--   xero_adjustment_lines  [{description, amount, account_code, kind}], kind
--                          'office_line' (a line our push did not write) or
--                          'unexplained' (the rest of a difference no line names)
--
-- NULL in all three means the bill has not been read yet: unknown, never 0.
-- They are written together, and the total always equals its named lines.
-- Projection: supabase/functions/xero-sync/trade_bill_status.ts
-- (tradeBillAdjustmentsPatch). Job Profit is unchanged on purpose: a loan
-- repayment taken from pay does not make the job's labour cheaper.

ALTER TABLE public.trade_invoices
  ADD COLUMN IF NOT EXISTS xero_bill_total numeric(12,2),
  ADD COLUMN IF NOT EXISTS xero_adjustments_ex numeric(12,2),
  ADD COLUMN IF NOT EXISTS xero_adjustment_lines jsonb;

-- True when every line is {description: non-empty text, amount: number,
-- account_code: text or null, kind: office_line | unexplained} and the lines
-- sum exactly to the total.
CREATE OR REPLACE FUNCTION public.trade_invoice_xero_adjustments_tie(
  p_total numeric,
  p_lines jsonb
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN false
    ELSE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_lines) AS e(line)
      WHERE jsonb_typeof(e.line) <> 'object'
         OR jsonb_typeof(e.line -> 'description') IS DISTINCT FROM 'string'
         OR btrim(e.line ->> 'description') = ''
         OR jsonb_typeof(e.line -> 'amount') IS DISTINCT FROM 'number'
         OR COALESCE(jsonb_typeof(e.line -> 'account_code'), 'missing') NOT IN ('string', 'null')
         OR COALESCE(e.line ->> 'kind', '') NOT IN ('office_line', 'unexplained')
    )
    AND p_total IS NOT DISTINCT FROM COALESCE((
      SELECT sum((e.line ->> 'amount')::numeric)
      FROM jsonb_array_elements(p_lines) AS e(line)
    ), 0)
  END;
$$;

COMMENT ON FUNCTION public.trade_invoice_xero_adjustments_tie(numeric, jsonb) IS
  'Group WO V10: a crew bill''s recorded Xero changes are named lines that sum exactly to their total.';

ALTER TABLE public.trade_invoices
  DROP CONSTRAINT IF EXISTS trade_invoices_xero_adjustments_read_together;
ALTER TABLE public.trade_invoices
  ADD CONSTRAINT trade_invoices_xero_adjustments_read_together CHECK (
    (xero_bill_total IS NULL AND xero_adjustments_ex IS NULL AND xero_adjustment_lines IS NULL)
    OR (
      xero_bill_total IS NOT NULL
      AND xero_adjustments_ex IS NOT NULL
      AND xero_adjustment_lines IS NOT NULL
      AND public.trade_invoice_xero_adjustments_tie(xero_adjustments_ex, xero_adjustment_lines)
    )
  );

COMMENT ON COLUMN public.trade_invoices.xero_bill_total IS
  'The crew bill''s total in Xero: what Xero pays. NULL until xero-sync reads the bill.';
COMMENT ON COLUMN public.trade_invoices.xero_adjustments_ex IS
  'Sum of the changes made to the crew bill in Xero after our push (office lines). 0 = read, none. NULL = not read yet.';
COMMENT ON COLUMN public.trade_invoices.xero_adjustment_lines IS
  'Each change made in Xero, named: [{description, amount, account_code, kind}]. NULL = not read yet.';
