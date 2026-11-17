-- Dependencies are supplied by the registered walk; no production stand-ins added here.
DO $$ BEGIN
  IF to_regclass('public.v_job_revenue_events') IS NULL
     OR to_regclass('public.v_bookkeeping_line_evidence_current') IS NULL
     OR to_regclass('public.work_order_customer_variations') IS NULL THEN
    RAISE EXCEPTION 'Follow-up 29: revenue prerequisites missing';
  END IF;
END $$;
