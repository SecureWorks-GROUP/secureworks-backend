-- ════════════════════════════════════════════════════════════
-- Invoice System — Extra Items, Notes, Drafts, Misc Invoices
-- ════════════════════════════════════════════════════════════

-- Add notes and invoice number to trade_invoices
ALTER TABLE trade_invoices ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE trade_invoices ADD COLUMN IF NOT EXISTS invoice_number text;

-- Make week_start/week_end nullable for miscellaneous invoices
ALTER TABLE trade_invoices ALTER COLUMN week_start DROP NOT NULL;
ALTER TABLE trade_invoices ALTER COLUMN week_end DROP NOT NULL;
ALTER TABLE trade_invoices ALTER COLUMN total_hours DROP NOT NULL;
ALTER TABLE trade_invoices ALTER COLUMN total_hours SET DEFAULT 0;
ALTER TABLE trade_invoices ALTER COLUMN subtotal_ex DROP NOT NULL;
ALTER TABLE trade_invoices ALTER COLUMN subtotal_ex SET DEFAULT 0;
ALTER TABLE trade_invoices ALTER COLUMN gst DROP NOT NULL;
ALTER TABLE trade_invoices ALTER COLUMN gst SET DEFAULT 0;
ALTER TABLE trade_invoices ALTER COLUMN total_inc DROP NOT NULL;
ALTER TABLE trade_invoices ALTER COLUMN total_inc SET DEFAULT 0;

-- Allow non-labour line items (job_id nullable, hours/rate optional)
ALTER TABLE trade_invoice_lines ALTER COLUMN job_id DROP NOT NULL;
ALTER TABLE trade_invoice_lines ALTER COLUMN total_hours DROP NOT NULL;
ALTER TABLE trade_invoice_lines ALTER COLUMN total_hours SET DEFAULT 0;
ALTER TABLE trade_invoice_lines ALTER COLUMN hourly_rate DROP NOT NULL;
ALTER TABLE trade_invoice_lines ALTER COLUMN hourly_rate SET DEFAULT 0;
ALTER TABLE trade_invoice_lines ALTER COLUMN line_total_ex DROP NOT NULL;
ALTER TABLE trade_invoice_lines ALTER COLUMN line_total_ex SET DEFAULT 0;

-- Add fields for extra item types
ALTER TABLE trade_invoice_lines ADD COLUMN IF NOT EXISTS line_type text DEFAULT 'labour';
ALTER TABLE trade_invoice_lines ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE trade_invoice_lines ADD COLUMN IF NOT EXISTS quantity numeric(10,2);
ALTER TABLE trade_invoice_lines ADD COLUMN IF NOT EXISTS unit text;
ALTER TABLE trade_invoice_lines ADD COLUMN IF NOT EXISTS unit_rate numeric(10,2);

-- Drop unique constraint on week_start to allow misc invoices (week_start = NULL)
DROP INDEX IF EXISTS idx_trade_inv_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_inv_unique
  ON trade_invoices(user_id, week_start) WHERE week_start IS NOT NULL;
