-- Existing registered group stack supplies all prerequisites.
DO $$ BEGIN
  IF to_regprocedure('public.remove_group_work_order_participant(uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'ZZTEST crew prerequisites missing';
  END IF;
END $$;

-- This index is on main in 20260313000022, before the registered test stack.
CREATE INDEX IF NOT EXISTS idx_trade_rates_user ON public.trade_rates(user_id);
