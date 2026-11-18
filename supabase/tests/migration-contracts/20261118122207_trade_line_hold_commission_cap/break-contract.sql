\ir ../../../rollbacks/20261118122207_trade_line_hold_commission_cap_down.sql
-- The contract re-applies the migration first, so the break also leaves a
-- body the migration was not written against: its pre-image guard must refuse.
DO $zzbreak$ DECLARE d text; BEGIN
  d := pg_get_functiondef('public.assert_job_commission_cap(uuid,uuid)'::regprocedure);
  IF position('AS $function$' IN d) = 0 THEN RAISE EXCEPTION 'break fixture: no function tag'; END IF;
  EXECUTE replace(d, 'AS $function$', E'AS $function$\n-- ZZTEST foreign body');
END $zzbreak$;
