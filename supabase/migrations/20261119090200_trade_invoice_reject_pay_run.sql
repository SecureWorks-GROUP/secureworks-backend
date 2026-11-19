-- P1-10 pay run: the database reject refuses an invoice a pay run approved.
-- reject_trade_invoice_v1(uuid,text,text), the office reject behind
-- trade_reimbursement_line_v1, sends an invoice back and releases its receipt
-- claims. The door reads pay_run_id first (payRunHeldRefusalFor), but a run
-- can approve the invoice between that read and this update. The update now
-- also needs pay_run_id IS NULL, so an approved invoice is never sent back:
-- it returns NULL, as for any other refused invoice, and releases nothing.
-- One condition added to the update; nothing else in the body moves.
-- Built from main's body (20261117235501 with 20261118153104's stamp). No
-- table, column, index, trigger, schedule, switch or row change. Grants kept.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5s';

DO $guard$ DECLARE fn regprocedure := to_regprocedure('public.reject_trade_invoice_v1(uuid,text,text)');
  body_hash text; definition text; BEGIN
  SELECT md5(prosrc), pg_get_functiondef(oid) INTO body_hash, definition FROM pg_proc WHERE oid = fn;
  -- Already applied: nothing to do.
  IF body_hash = '11db2726fa12909a671fdfc400082e4e' THEN RETURN; END IF;
  IF body_hash IS DISTINCT FROM 'd689b65f2fa743a8af8e5e795f2cc39e' THEN
    RAISE EXCEPTION 'reject_pay_run_preimage_mismatch';
  END IF;
  EXECUTE replace(definition,
    $old$WHERE id = p_invoice_id AND xero_bill_id IS NULL AND xero_pushed_at IS NULL
$old$,
    $new$WHERE id = p_invoice_id AND xero_bill_id IS NULL AND xero_pushed_at IS NULL
    AND pay_run_id IS NULL
$new$);
  SELECT md5(prosrc) INTO body_hash FROM pg_proc WHERE oid = fn;
  IF body_hash IS DISTINCT FROM '11db2726fa12909a671fdfc400082e4e' THEN
    RAISE EXCEPTION 'reject_pay_run_result_mismatch';
  END IF;
END $guard$;
