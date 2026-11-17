DO $$ DECLARE d text; old text := $s$'travel_logistics_deduction'::text]$s$;
new text := $s$'travel_logistics_deduction'::text, 'reimbursement'::text]$s$;
BEGIN
  IF EXISTS (SELECT 1 FROM public.trade_invoice_lines WHERE lower(line_type) = 'reimbursement') THEN
    RAISE EXCEPTION 'reimbursement lines exist; rollback refused';
  END IF;
  d := pg_get_viewdef('public.v_trade_charge_resolved'::regclass, true);
  IF (length(d) - length(replace(d, new, ''))) / length(new) <> 1 THEN
    RAISE EXCEPTION 'reimbursement cost lane rollback preimage changed';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_trade_charge_resolved AS ' || replace(d, new, old);
END $$;
SELECT public.remove_trade_invoice_reimbursement_guard();
DROP FUNCTION IF EXISTS public.install_trade_invoice_reimbursement_guard();
DROP FUNCTION IF EXISTS public.remove_trade_invoice_reimbursement_guard();
DROP FUNCTION IF EXISTS public.trade_invoice_lines_reimbursement_once();
ALTER TABLE public.trade_invoice_lines DROP CONSTRAINT IF EXISTS trade_invoice_lines_receipt_only_on_reimbursement;
ALTER TABLE public.trade_invoice_lines DROP CONSTRAINT IF EXISTS trade_invoice_lines_reimbursement_check;
DROP INDEX IF EXISTS public.trade_invoice_lines_expense_receipt_idx;
ALTER TABLE public.trade_invoice_lines DROP COLUMN IF EXISTS expense_receipt_id;
DELETE FROM public.feature_flags WHERE flag_name = 'trade_reimbursement_line_v1';
