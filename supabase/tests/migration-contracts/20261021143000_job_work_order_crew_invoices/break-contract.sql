-- Ship the every-type switch on: the promise that a make-safe job opens no
-- work order until the owner says so is gone.
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_work_order_all_types_v1';
