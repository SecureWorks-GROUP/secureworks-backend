-- Break: the switch is on before anyone said so.
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_profit_expected_from_job_budget';
