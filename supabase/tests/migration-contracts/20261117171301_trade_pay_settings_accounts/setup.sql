DO $$ BEGIN
  IF to_regclass('public.trade_pay_settings') IS NULL THEN
    RAISE EXCEPTION 'trade_pay_settings_accounts: P1-01.1 is required';
  END IF;
END $$;
