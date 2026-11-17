-- Reintroduce the reported fault while retaining the real reject/update path.
DO $$ DECLARE d text; old_text text := $old$  DELETE FROM public.trade_invoice_lines
  WHERE trade_invoice_id = rejected_id AND expense_receipt_id IS NOT NULL;$old$;
new_text text := $new$    DELETE FROM public.trade_invoice_lines WHERE id = released_line.id;$new$;
BEGIN
 d := pg_get_functiondef('public.reject_trade_invoice_v1(uuid,text)'::regprocedure);
 -- FU22 deletes exact locked rows after their audit. Break either generation.
 IF strpos(d,new_text)>0 THEN old_text:=new_text; END IF;
 IF (length(d)-length(replace(d,old_text,'')))/length(old_text)<>1 THEN
  RAISE EXCEPTION 'FU17 deliberate break preimage changed';
 END IF;
 EXECUTE replace(d,old_text,'  PERFORM 1;');
END $$;
