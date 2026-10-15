-- The runner has just run the down migration against the forward stack.
DO $$
BEGIN
  IF to_regclass('public.materials_bill_proposals') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback contract: materials_bill_proposals is still there';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'materials_reconciliation_queue'
                AND column_name = 'closed_reason') THEN
    RAISE EXCEPTION 'rollback contract: closed_reason is still on the queue';
  END IF;
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'job_materials_facts_source_chk')) LIKE '%agent_prematch%' THEN
    RAISE EXCEPTION 'rollback contract: the agent fact source is still allowed';
  END IF;
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'materials_recon_status_chk')) LIKE '%void_in_xero%' THEN
    RAISE EXCEPTION 'rollback contract: void_in_xero is still allowed';
  END IF;
  IF to_regclass('public.materials_reconciliation_queue') IS NULL OR to_regclass('public.job_materials_facts') IS NULL THEN
    RAISE EXCEPTION 'rollback contract: the rollback removed a legacy table';
  END IF;
END $$;
