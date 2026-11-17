DO $$ BEGIN
 IF to_regclass('public.v_trade_charge_resolved') IS NULL OR to_regclass('public.v_invoice_line_completeness') IS NULL THEN
   RAISE EXCEPTION 'trade sync setup: prerequisite views missing'; END IF;
END $$;
