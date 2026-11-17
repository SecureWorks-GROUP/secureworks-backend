-- Reintroduce the reported fault while retaining the real reject/update path.
DO $$ DECLARE d text; old_text text := $old$  DELETE FROM public.trade_invoice_lines
  WHERE trade_invoice_id = rejected_id AND expense_receipt_id IS NOT NULL;$old$;
BEGIN
 d := pg_get_functiondef('public.reject_trade_invoice_v1(uuid,text)'::regprocedure);
 IF (length(d)-length(replace(d,old_text,'')))/length(old_text)<>1 THEN
  RAISE EXCEPTION 'FU17 deliberate break preimage changed';
 END IF;
 EXECUTE replace(d,old_text,'  PERFORM 1;');
END $$;
