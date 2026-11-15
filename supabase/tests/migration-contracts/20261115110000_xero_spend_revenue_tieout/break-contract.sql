-- Deliberately stop taking GST off a line whose amounts include it. Card spend is entered GST inclusive, so every
-- such line would then be overstated by its GST. The contract must fail on the June direct cost figure.
DO $$
DECLARE d text := pg_get_functiondef('public.xero_spend_revenue_monthly(date,integer,uuid)'::regprocedure);
BEGIN
  IF position('lower(COALESCE(t.line_amount_types, '''')) = ''inclusive''' IN d) = 0 THEN
    RAISE EXCEPTION 'break: the GST rule was not found';
  END IF;
  EXECUTE replace(d, 'lower(COALESCE(t.line_amount_types, '''')) = ''inclusive''',
                     'lower(COALESCE(t.line_amount_types, '''')) = ''never''');
END $$;
