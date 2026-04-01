-- Invoice overrides — lead trade can adjust/reject crew charges
ALTER TABLE trade_invoice_lines ADD COLUMN IF NOT EXISTS override_amount numeric(10,2);
ALTER TABLE trade_invoice_lines ADD COLUMN IF NOT EXISTS override_by uuid;
ALTER TABLE trade_invoice_lines ADD COLUMN IF NOT EXISTS override_note text;
