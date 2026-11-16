-- Prerequisites for 20261115110000_xero_spend_revenue_tieout. Earlier registered cases supply everything the
-- migration reads: our copy of Xero's bank transactions and invoices, the sync cursor table, Job Profit's revenue
-- view and jobs. This case adds nothing. Fail closed, by name, if any of it is gone.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.xero_bank_transactions', 'public.xero_sync_state', 'public.xero_invoices',
                           'public.v_job_revenue_events', 'public.jobs', 'public.organisations'] LOOP
    IF to_regclass(t) IS NULL THEN
      RAISE EXCEPTION 'xero spend revenue setup: % missing from the registered stack', t;
    END IF;
  END LOOP;
END $$;
