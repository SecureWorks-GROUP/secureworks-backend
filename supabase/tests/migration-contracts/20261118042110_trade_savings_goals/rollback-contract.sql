DO $$ BEGIN
  IF to_regclass('public.trade_savings_goals') IS NOT NULL THEN
    RAISE EXCEPTION 'ZZTEST rollback left savings goals';
  END IF;
END $$;
