-- After the down migration the gate is gone and nothing else changed.
BEGIN;
DO $$
BEGIN
  ASSERT to_regprocedure('public.job_not_yet_accepted(text,text)') IS NULL,
    'the down migration drops the rule';
  ASSERT NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN
      ('trg_work_orders_issue_needs_acceptance', 'trg_group_work_orders_open_needs_acceptance')),
    'the down migration drops both triggers';
  ASSERT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_work_orders_job_kind_guard'),
    'the job work order seal guard is untouched';
END $$;
ROLLBACK;
