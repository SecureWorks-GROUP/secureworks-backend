-- The registered stack supplies the group tables, the claim flow (claim_state,
-- the job lock, the split hash) and the pay run approver list this migration
-- reads.
DO $$ BEGIN
  IF to_regclass('public.group_work_order_time_entries') IS NULL
     OR to_regclass('public.group_work_order_events') IS NULL
     OR to_regclass('public.trade_pay_settings') IS NULL
     OR to_regprocedure('public.group_work_order_lock_job(uuid)') IS NULL
     OR to_regprocedure('public.group_claim_current_hash(uuid)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
       AND table_name = 'group_work_orders' AND column_name = 'claim_state')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
       AND table_name = 'trade_pay_settings' AND column_name = 'pay_run_approver_user_ids') THEN
    RAISE EXCEPTION 'group office day entry prerequisites are missing';
  END IF;
END $$;
