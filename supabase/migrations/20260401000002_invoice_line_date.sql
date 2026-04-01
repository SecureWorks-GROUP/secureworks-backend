-- Add date and division to invoice line items
ALTER TABLE trade_invoice_lines ADD COLUMN IF NOT EXISTS line_date date;
ALTER TABLE trade_invoice_lines ADD COLUMN IF NOT EXISTS division text;
