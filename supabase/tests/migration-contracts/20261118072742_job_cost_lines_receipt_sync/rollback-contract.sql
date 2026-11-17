DO $$ BEGIN
 IF to_regprocedure('public.job_cost_lines_sync_receipt(uuid)') IS NOT NULL
  OR to_regprocedure('public.job_cost_lines_try_receipt(uuid)') IS NOT NULL
  OR to_regprocedure('public.job_cost_lines_receipt_row()') IS NOT NULL
  OR to_regprocedure('public.job_cost_lines_install_receipt_trigger()') IS NOT NULL
  OR to_regprocedure('public.job_cost_lines_remove_receipt_trigger()') IS NOT NULL
  OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='job_cost_lines_receipt_sync') THEN
  RAISE EXCEPTION 'receipt sync rollback: objects remain'; END IF;
 IF to_regprocedure('public.job_cost_lines_upsert_documents(jsonb)') IS NULL
  OR to_regclass('public.match_queue') IS NULL OR to_regclass('public.expense_receipts') IS NULL THEN
  RAISE EXCEPTION 'receipt sync rollback: removed something it does not own'; END IF;
END $$;
