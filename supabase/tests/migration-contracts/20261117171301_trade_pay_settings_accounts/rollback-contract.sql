DO $$ BEGIN
  IF to_regprocedure('public.set_trade_pay_setting(text,text,uuid)') IS NOT NULL
     OR to_regclass('public.trade_pay_settings_changes') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'trade_pay_settings' AND column_name IN ('repayment_account_code', 'not_job_work_account_code')) THEN
    RAISE EXCEPTION 'pay settings rollback contract: new surface remains';
  END IF;
  PERFORM tax_set_aside_percent, reimbursement_account_code, inclusive_super_from, pay_run_approver_user_ids FROM public.trade_pay_settings;
END $$;
