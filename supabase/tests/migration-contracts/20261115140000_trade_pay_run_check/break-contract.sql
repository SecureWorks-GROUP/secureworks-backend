-- Deliberately take away the "pays more than the invoice" halves of the changed-by-hand stop (the
-- raised total and the office line that adds money). Because invoice_pays adds every change made in
-- Xero back in, a bill raised by hand would then read as matching and go through as clean. The
-- contract must fail on that invoice.
DO $$
DECLARE d text := pg_get_functiondef('public.trade_pay_run_check(date,integer,uuid)'::regprocedure);
DECLARE needle text := 'AND (COALESCE(i.xero_adjustments_ex, 0) > 0.005';
DECLARE needle2 text := 'OR (jsonb_typeof(x->''amount'') = ''number'' AND (x->>''amount'')::numeric > 0.005)';
BEGIN
  IF position(needle IN d) = 0 OR position(needle2 IN d) = 0 THEN
    RAISE EXCEPTION 'break: the changed-by-hand test was not found';
  END IF;
  EXECUTE replace(replace(d, needle, 'AND (false'), needle2, 'OR false');
END $$;
