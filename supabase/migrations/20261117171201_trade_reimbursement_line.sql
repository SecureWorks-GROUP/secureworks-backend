-- P1-03.1. Receipt-backed reimbursement lines. Released switched off.
INSERT INTO public.feature_flags(flag_name, enabled, description)
VALUES ('trade_reimbursement_line_v1', false, 'A trade may add a reimbursement line, tied to a receipt, to a trade invoice. No super on it.')
ON CONFLICT (flag_name) DO NOTHING;
ALTER TABLE public.trade_invoice_lines ADD COLUMN IF NOT EXISTS expense_receipt_id uuid REFERENCES public.expense_receipts(id);
ALTER TABLE public.trade_invoice_lines DROP CONSTRAINT IF EXISTS trade_invoice_lines_reimbursement_check;
ALTER TABLE public.trade_invoice_lines ADD CONSTRAINT trade_invoice_lines_reimbursement_check
CHECK (lower(line_type) <> 'reimbursement' OR (expense_receipt_id IS NOT NULL AND line_total_ex > 0));
ALTER TABLE public.trade_invoice_lines DROP CONSTRAINT IF EXISTS trade_invoice_lines_receipt_only_on_reimbursement;
ALTER TABLE public.trade_invoice_lines ADD CONSTRAINT trade_invoice_lines_receipt_only_on_reimbursement
CHECK (expense_receipt_id IS NULL OR lower(line_type) = 'reimbursement');
CREATE INDEX IF NOT EXISTS trade_invoice_lines_expense_receipt_idx
ON public.trade_invoice_lines(expense_receipt_id) WHERE expense_receipt_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.trade_invoice_lines_reimbursement_once()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF NEW.expense_receipt_id IS NOT NULL THEN
    -- Serialise claims of the same receipt before reading the other invoices.
    PERFORM 1 FROM public.expense_receipts WHERE id = NEW.expense_receipt_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM public.trade_invoice_lines l JOIN public.trade_invoices i ON i.id = l.trade_invoice_id
      WHERE l.expense_receipt_id = NEW.expense_receipt_id AND i.id <> NEW.trade_invoice_id
      AND i.status IS DISTINCT FROM 'draft' AND i.status IS DISTINCT FROM 'ops-reject') THEN
      RAISE EXCEPTION 'reimbursement_already_claimed' USING ERRCODE = '23505';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.trade_invoice_lines_reimbursement_once() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trade_invoice_lines_reimbursement_once ON public.trade_invoice_lines;
CREATE TRIGGER trade_invoice_lines_reimbursement_once BEFORE INSERT OR UPDATE OF expense_receipt_id
ON public.trade_invoice_lines FOR EACH ROW EXECUTE FUNCTION public.trade_invoice_lines_reimbursement_once();
-- The lane CASE belongs to this view; v_job_cost_events consumes its cost_lane.
DO $$ DECLARE d text; old text := $s$'travel_logistics_deduction'::text]$s$;
new text := $s$'travel_logistics_deduction'::text, 'reimbursement'::text]$s$;
BEGIN
  d := pg_get_viewdef('public.v_trade_charge_resolved'::regclass, true);
  IF strpos(d, new) > 0 THEN RETURN; END IF;
  IF (length(d) - length(replace(d, old, ''))) / length(old) <> 1 THEN
    RAISE EXCEPTION 'reimbursement cost lane preimage changed';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_trade_charge_resolved AS ' || replace(d, old, new);
END $$;
