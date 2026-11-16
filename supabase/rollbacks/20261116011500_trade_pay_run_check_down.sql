-- Down for 20261116011500_trade_pay_run_check: the check is read only and nothing depends on it.
DROP FUNCTION IF EXISTS public.trade_pay_run_check(date, integer, uuid);
