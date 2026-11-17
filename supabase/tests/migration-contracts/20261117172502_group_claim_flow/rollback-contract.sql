BEGIN;
DO $$ BEGIN
  IF to_regclass('public.group_work_order_approvals') IS NOT NULL
     OR to_regprocedure('public.group_claim_split_hash(uuid)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
       AND table_name = 'group_work_orders' AND column_name = 'claim_state') THEN
    RAISE EXCEPTION 'ZZTEST group claim rollback retained its schema';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.group_work_order_events'::regclass
      AND conname = 'group_work_order_events_action_check'
      AND pg_get_constraintdef(oid) LIKE '%restore_participant%'
      AND pg_get_constraintdef(oid) NOT LIKE '%name_crew%') THEN
    RAISE EXCEPTION 'ZZTEST group claim rollback lost legacy event actions';
  END IF;
END $$;
SELECT 'PASS: P1-13.3 rollback restores legacy event actions' AS result;
ROLLBACK;
