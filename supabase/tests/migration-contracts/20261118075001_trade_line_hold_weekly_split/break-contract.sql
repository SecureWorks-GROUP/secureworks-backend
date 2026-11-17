\ir ../../../rollbacks/20261118075002_trade_line_hold_work_order_split_down.sql
\ir ../../../rollbacks/20261118075001_trade_line_hold_weekly_split_down.sql
-- The contract re-applies the migration first, so the break also leaves a
-- body the migration was not written against: its pre-image guard must refuse.
DO $zzbreak$ DECLARE d text; BEGIN
  d := pg_get_functiondef('public.persist_weekly_trade_invoice_v1(jsonb,jsonb,uuid)'::regprocedure);
  IF position('AS $function$' IN d) = 0 THEN RAISE EXCEPTION 'break fixture: no function tag'; END IF;
  EXECUTE replace(d, 'AS $function$', E'AS $function$\n-- ZZTEST foreign body');
END $zzbreak$;
