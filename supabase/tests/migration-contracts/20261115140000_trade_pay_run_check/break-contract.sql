-- Deliberately take away the booking rate: a trade paid the rate on their booking for a job would
-- then be stopped as "rate differs". The contract must fail on that invoice.
DO $$
DECLARE d text := pg_get_functiondef('public.trade_pay_run_check(date,integer,uuid)'::regprocedure);
DECLARE needle text := 'AND a.hourly_rate IS NOT NULL AND abs(a.hourly_rate - l.hourly_rate) <= 0.005';
BEGIN
  IF position(needle IN d) = 0 THEN
    RAISE EXCEPTION 'break: the booking rate test was not found';
  END IF;
  EXECUTE replace(d, needle, 'AND false');
END $$;
