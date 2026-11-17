-- FU17 / P1-03.1: rejection and receipt release are one operation, switched off.
-- No trigger, schedule, install, switch change or historical data rewrite.
CREATE OR REPLACE FUNCTION public.reject_trade_invoice_v1(p_invoice_id uuid, p_note text)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE rejected_id uuid; BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags
    WHERE flag_name = 'trade_reimbursement_line_v1' AND enabled) THEN
    RAISE EXCEPTION 'reimbursement_switch_off' USING ERRCODE = '55000';
  END IF;
  -- trade_invoices_pkey. The update locks the exact invoice and rechecks Xero
  -- custody after a concurrent writer; a refused update releases no receipts.
  UPDATE public.trade_invoices
  SET status = 'ops-reject', query_note = p_note
  WHERE id = p_invoice_id AND xero_bill_id IS NULL AND xero_pushed_at IS NULL
    AND status IS DISTINCT FROM 'pushed_to_xero' AND status IS DISTINCT FROM 'paid'
  RETURNING id INTO rejected_id;
  IF rejected_id IS NULL THEN RETURN NULL; END IF;

  -- idx_inv_lines_invoice bounds this to one invoice. Remove only receipt
  -- claims; keep labour, group shares, the rejected header and source receipts.
  -- Any failure rolls the rejection back as well. The permanent receipt index
  -- remains the final arbiter if a corrected claim races this transaction.
  DELETE FROM public.trade_invoice_lines
  WHERE trade_invoice_id = rejected_id AND expense_receipt_id IS NOT NULL;
  RETURN rejected_id;
END $$;
REVOKE ALL ON FUNCTION public.reject_trade_invoice_v1(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reject_trade_invoice_v1(uuid, text) TO service_role;
