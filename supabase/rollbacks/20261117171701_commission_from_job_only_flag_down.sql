DELETE FROM public.feature_flags
WHERE flag_name = 'commission_from_job_only_v1' AND enabled = false;
