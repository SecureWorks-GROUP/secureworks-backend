-- Deliberately put the old blind spot back: the tie-out stops reading the rows Job Profit places by bookkeeping's
-- line evidence, which is what the function before this migration could not see. The contract must fail, because
-- on a job would then fall short of what Job Profit counts.
DO $$
DECLARE d text := pg_get_functiondef('public.xero_tieout_monthly(date,integer,uuid)'::regprocedure);
BEGIN
  IF position('WHERE e.source IN (''supplier_bill'', ''materials_fact'', ''installer_bill_unconfirmed'')' IN d) = 0 THEN
    RAISE EXCEPTION 'break: the cost row filter was not found';
  END IF;
  EXECUTE replace(d, 'WHERE e.source IN (''supplier_bill'', ''materials_fact'', ''installer_bill_unconfirmed'')',
                     'WHERE e.source IN (''supplier_bill'', ''materials_fact'', ''installer_bill_unconfirmed'') AND e.match_method IS DISTINCT FROM ''bookkeeping_evidence''');
END $$;
