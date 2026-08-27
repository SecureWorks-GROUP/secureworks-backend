BEGIN;

DROP FUNCTION IF EXISTS public.replace_trade_invoice_draft_v1(uuid, uuid, uuid, uuid[]);

DROP TRIGGER IF EXISTS trg_trade_invoices_require_money_split
  ON public.trade_invoices;
DROP FUNCTION IF EXISTS public.enforce_trade_invoice_money_split_v1();

ALTER TABLE public.trade_invoices
  DROP CONSTRAINT IF EXISTS trade_invoices_super_gst_split_check,
  DROP COLUMN IF EXISTS gst_on,
  DROP COLUMN IF EXISTS super_rate,
  DROP COLUMN IF EXISTS super_amount,
  DROP COLUMN IF EXISTS gross_earned,
  DROP COLUMN IF EXISTS net_pay;

COMMIT;
