DO $$
BEGIN
  IF to_regclass('public.debt_followup_approvals') IS NOT NULL OR
     to_regclass('public.debt_followup_executions') IS NOT NULL OR
     to_regprocedure('public.debt_followup_executions_settle_once()') IS NOT NULL OR
     to_regprocedure('public.debt_followup_approvals_insert_only()') IS NOT NULL THEN
    RAISE EXCEPTION 'debt follow-up rollback left objects behind';
  END IF;
END $$;
