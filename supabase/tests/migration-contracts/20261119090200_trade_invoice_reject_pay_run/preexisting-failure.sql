-- A reject body this migration was not built from: it must refuse, not replace it.
DO $$ BEGIN
  EXECUTE replace(pg_get_functiondef('public.reject_trade_invoice_v1(uuid,text,text)'::regprocedure),
    'RETURN rejected_id;', 'RETURN rejected_id; -- ZZTEST office edit');
END $$;
