-- Ship the switch on: the promise that nothing reaches the trades until the
-- captain says so is gone.
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_work_order_auto_issue_v1';
