-- FU22: keep the rejected receipt claim before releasing it. Reimbursements stay off.
-- Built from main's 20261117202501 body; no trigger, schedule or switch change.
-- One terminal audit row replaces each deleted claim. Replays append nothing.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
DO $guard$ DECLARE expected text; BEGIN
  SELECT md5(prosrc) INTO expected FROM pg_proc
    WHERE oid = to_regprocedure('public.reject_trade_invoice_v1(uuid,text)');
  IF expected IS NULL OR expected NOT IN ('e608e2ae246bd157c5fcda3b2581f7f9','7f9368d57bed7d02e0a918fd20867680') THEN
    RAISE EXCEPTION 'FU22 reject_trade_invoice_v1 preimage changed';
  END IF;
END $guard$;

ALTER TABLE public.trade_invoice_events DROP CONSTRAINT trade_invoice_events_type_check;
ALTER TABLE public.trade_invoice_events ADD CONSTRAINT trade_invoice_events_type_check
  CHECK (event_type IN ('voided_bill_released','stuck_invoice_resolved',
    'xero_bill_reused','extra_rate_held','receipt_released'));

CREATE OR REPLACE FUNCTION public.reject_trade_invoice_v1(p_invoice_id uuid, p_note text)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE rejected_id uuid; released_line public.trade_invoice_lines%ROWTYPE; BEGIN
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

  -- idx_inv_lines_invoice bounds the locked read to this invoice. Fold each
  -- released claim into the existing append-only audit store before deleting it.
  -- Its full row preserves receipt, amount, invoice and the original line id.
  -- Delete only that locked row: a concurrent new line cannot be deleted unaudited.
  FOR released_line IN SELECT l.* FROM public.trade_invoice_lines l
    WHERE l.trade_invoice_id = rejected_id AND l.expense_receipt_id IS NOT NULL
    ORDER BY l.id FOR UPDATE
  LOOP
    INSERT INTO public.trade_invoice_events(trade_invoice_id,event_type,actor,reason,detail)
    VALUES (rejected_id,'receipt_released','reject_trade_invoice_v1',
      'invoice_rejected',to_jsonb(released_line));
    DELETE FROM public.trade_invoice_lines WHERE id = released_line.id;
  END LOOP;
  RETURN rejected_id;
END $$;
REVOKE ALL ON FUNCTION public.reject_trade_invoice_v1(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reject_trade_invoice_v1(uuid, text) TO service_role;
