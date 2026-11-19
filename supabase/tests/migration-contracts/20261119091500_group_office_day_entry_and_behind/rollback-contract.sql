BEGIN;
DO $rollback$ BEGIN
  IF to_regprocedure('public.group_office_enter_hours(uuid,uuid,uuid,jsonb,text)') IS NOT NULL
     OR to_regprocedure('public.group_office_dispute_hours(uuid,uuid,text)') IS NOT NULL
     OR to_regprocedure('public.group_work_order_office_dispute_open(uuid)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
       AND table_name = 'group_work_order_time_entries'
       AND column_name IN ('entered_by_office', 'disputed_at', 'office_entry_reason'))
     OR EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'group_office_day_entry_v1') THEN
    RAISE EXCEPTION 'G4 rollback retained its schema';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.group_work_order_events'::regclass
      AND conname = 'group_work_order_events_action_check'
      AND pg_get_constraintdef(oid) LIKE '%office_settle%'
      AND pg_get_constraintdef(oid) NOT LIKE '%office_enter_hours%') THEN
    RAISE EXCEPTION 'G4 rollback did not restore the claim-flow event actions';
  END IF;
  -- The legacy hours writer still works without the new columns.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_group_work_order_time_entries_guard') THEN
    RAISE EXCEPTION 'G4 rollback dropped the existing hours guard';
  END IF;
END $rollback$;
SELECT 'PASS: G4 rollback removes office entry schema and keeps the claim-flow actions' AS result;
ROLLBACK;
