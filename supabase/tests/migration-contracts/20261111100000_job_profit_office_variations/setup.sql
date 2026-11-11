-- Prerequisites for 20261111100000_job_profit_office_variations: the office variation table (20261013140000) and
-- the Job Profit views as 20261104200500 and 20261104091000 left them, applied by the registered walk.
DO $$
BEGIN
  IF to_regclass('public.work_order_customer_variations') IS NULL THEN
    RAISE EXCEPTION 'RQ-15.g: 20261013140000 is not applied before 20261111100000';
  END IF;
END $$;
